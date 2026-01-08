import express from 'express';

import { fetchArticleAsMarkdown } from './lib/articles/fetchAndConvert.js';
import { sha1Hex } from './lib/crypto/sha1.js';
import { decryptToken, encryptToken, importAesKeyFromBase64 } from './lib/crypto/tokenCrypto.js';
import { githubGetRepo, githubPutMarkdown } from './lib/github/github.js';
import { createLogger, getRequestId } from './lib/logging/logger.js';
import { getIdemRecord, isRecentIso, putIdemRecord } from './lib/storage/idemKv.js';
import { getUserBinding, setUserBinding } from './lib/storage/usersKv.js';
import { isValidRepoFullName, normalizePathPrefix } from './lib/validation/strings.js';
import {
    wechatBuildEncryptedReplyXml,
    wechatDecryptMessage,
    wechatEncryptMessage,
    wechatRandomNonce,
    wechatVerifyMsgSignature,
    wechatVerifySignaturePlain,
} from './lib/wechat/crypto.js';
import { enforceWeChatReplayGuard } from './lib/wechat/replayGuard.js';
import { xmlGetText, xmlTextReply } from './lib/wechat/xml.js';

function text(res, body, { status = 200, headers = {} } = {}) {
    res.status(status);
    res.set({ 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.send(body);
}

function xml(res, body, { status = 200, headers = {} } = {}) {
    res.status(status);
    res.set({ 'content-type': 'text/xml; charset=utf-8', ...headers });
    res.send(body);
}

function isWeChatEncryptedMode(url) {
    // In safe/compatible mode, WeChat uses msg_signature and encrypts echostr/body.
    return Boolean(url.searchParams.get('msg_signature'));
}

async function verifyWeChatCallback({ url, env, encrypted }) {
    const timestamp = url.searchParams.get('timestamp');
    const nonce = url.searchParams.get('nonce');
    const msgSignature = url.searchParams.get('msg_signature');
    if (msgSignature) {
        return wechatVerifyMsgSignature({
            token: env.WECHAT_TOKEN,
            timestamp,
            nonce,
            msgSignature,
            encrypted: encrypted ?? '',
        });
    }

    const signature = url.searchParams.get('signature');
    return wechatVerifySignaturePlain({ token: env.WECHAT_TOKEN, timestamp, nonce, signature });
}

function parseBindCommand(content) {
    // bind <token> <owner>/<repo> [path <prefix>]
    const trimmed = (content ?? '').trim();
    if (!trimmed.toLowerCase().startsWith('bind ')) return null;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 3) return { error: 'usage' };
    const githubToken = tokens[1];
    const repo = tokens[2];
    let pathPrefix;
    const pathIndex = tokens.findIndex((t) => t.toLowerCase() === 'path');
    if (pathIndex !== -1 && tokens[pathIndex + 1]) {
        pathPrefix = tokens[pathIndex + 1];
    }
    return { githubToken, repo, pathPrefix };
}

async function handleWeChatGet(req, res, env, logger) {
    const url = new URL(req.originalUrl, 'http://localhost');
    const echostr = url.searchParams.get('echostr') ?? '';
    const ok = await verifyWeChatCallback({ url, env, encrypted: echostr });
    if (!ok) {
        logger.log('wechat_verify_failed', { stage: 'get' });
        return text(res, 'invalid signature', { status: 400 });
    }

    if (isWeChatEncryptedMode(url)) {
        if (!env.WECHAT_AES_KEY || !env.WECHAT_APP_ID) {
            logger.log('wechat_missing_crypto_config', { stage: 'get' });
            return text(res, 'missing crypto config', { status: 400 });
        }
        try {
            const plain = await wechatDecryptMessage({
                encodingAesKey: env.WECHAT_AES_KEY,
                appId: env.WECHAT_APP_ID,
                encryptedBase64: echostr,
            });
            logger.log('wechat_verify_ok', { stage: 'get', encrypted: true });
            return text(res, plain);
        } catch (err) {
            logger.log('wechat_decrypt_failed', { stage: 'get', error: err?.message ?? String(err) });
            return text(res, 'invalid echostr', { status: 400 });
        }
    }

    logger.log('wechat_verify_ok', { stage: 'get', encrypted: false });
    return text(res, echostr);
}

async function handleWeChatPost(req, res, env, ctx, logger) {
    const url = new URL(req.originalUrl, 'http://localhost');
    let xmlBody = typeof req.body === 'string' ? req.body : '';

    const encryptedMode = isWeChatEncryptedMode(url);
    let encrypted;
    if (encryptedMode) encrypted = xmlGetText(xmlBody, 'Encrypt');

    const ok = await verifyWeChatCallback({ url, env, encrypted });
    if (!ok) {
        logger.log('wechat_verify_failed', { stage: 'post', encrypted: encryptedMode });
        return text(res, 'invalid signature', { status: 400 });
    }

    if (String(env.WECHAT_REPLAY_PROTECT ?? 'true').toLowerCase() !== 'false') {
        const guard = await enforceWeChatReplayGuard({ env, url });
        if (!guard.ok) {
            logger.log('wechat_replay_guard_block', { reason: guard.reason });
            return text(res, 'invalid request', { status: 400 });
        }
    }

    if (encryptedMode) {
        if (!env.WECHAT_AES_KEY || !env.WECHAT_APP_ID) {
            logger.log('wechat_missing_crypto_config', { stage: 'post' });
            return text(res, 'missing crypto config', { status: 400 });
        }
        try {
            xmlBody = await wechatDecryptMessage({
                encodingAesKey: env.WECHAT_AES_KEY,
                appId: env.WECHAT_APP_ID,
                encryptedBase64: encrypted,
            });
        } catch (err) {
            logger.log('wechat_decrypt_failed', { stage: 'post', error: err?.message ?? String(err) });
            return text(res, 'invalid message', { status: 400 });
        }
    }

    const toUser = xmlGetText(xmlBody, 'ToUserName');
    const fromUser = xmlGetText(xmlBody, 'FromUserName');
    const msgType = (xmlGetText(xmlBody, 'MsgType') || '').toLowerCase();
    logger.log('wechat_received', { msg_type: msgType, openid: logger.maskOpenId(fromUser) });

    if (!toUser || !fromUser || !msgType) {
        return xml(
            res,
            xmlTextReply({ toUser: fromUser, fromUser: toUser, content: '消息格式不支持（缺少字段）。' }),
        );
    }

    // Text commands
    if (msgType === 'text') {
        const t0 = Date.now();
        const content = xmlGetText(xmlBody, 'Content') || '';
        const bind = parseBindCommand(content);
        if (!bind) {
            logger.log('wechat_text_help', { dur_ms: Date.now() - t0, openid: logger.maskOpenId(fromUser) });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content:
                    '可用指令：\n1) bind <github_token> <owner>/<repo> [path <prefix>]\n示例：bind ghp_xxx myname/myrepo path articles/',
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        if (bind.error === 'usage') {
            logger.log('wechat_bind_usage', { dur_ms: Date.now() - t0, openid: logger.maskOpenId(fromUser) });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content: '用法：bind <github_token> <owner>/<repo> [path <prefix>]',
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        if (!isValidRepoFullName(bind.repo)) {
            logger.log('wechat_bind_invalid_repo', { dur_ms: Date.now() - t0, openid: logger.maskOpenId(fromUser) });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content: '仓库格式错误，应为 <owner>/<repo>，例如：octocat/hello-world',
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        const defaultPath = normalizePathPrefix(bind.pathPrefix ?? 'articles/');
        let verifyOnBind = true;
        if (typeof env.GITHUB_VERIFY_ON_BIND === 'string' && env.GITHUB_VERIFY_ON_BIND.toLowerCase() === 'false') {
            verifyOnBind = false;
        }

        try {
            if (verifyOnBind) {
                logger.log('github_repo_verify_start', { repo: bind.repo, openid: logger.maskOpenId(fromUser) });
                await githubGetRepo({ token: bind.githubToken, repoFullName: bind.repo });
                logger.log('github_repo_verify_ok', { repo: bind.repo, openid: logger.maskOpenId(fromUser) });
            }
        } catch (err) {
            logger.log('github_repo_verify_failed', {
                repo: bind.repo,
                openid: logger.maskOpenId(fromUser),
                error: err?.message ?? String(err),
            });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content: '绑定失败：无法访问该仓库。请检查 token 权限（至少 repo）与仓库名是否正确。',
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        if (!env.TOKEN_ENCRYPTION_KEY_BASE64) {
            logger.log('server_missing_encryption_key', { openid: logger.maskOpenId(fromUser) });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content:
                    '服务端尚未配置 TOKEN_ENCRYPTION_KEY_BASE64，暂无法绑定。请联系管理员配置后重试。',
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        const aesKey = await importAesKeyFromBase64(env.TOKEN_ENCRYPTION_KEY_BASE64);
        const githubTokenEnc = await encryptToken(aesKey, bind.githubToken);
        await setUserBinding(env.RUMI_KV, fromUser, {
            github_token_enc: githubTokenEnc,
            default_repo: bind.repo,
            default_path: defaultPath,
        });
        logger.log('binding_saved', {
            repo: bind.repo,
            path: defaultPath,
            openid: logger.maskOpenId(fromUser),
            dur_ms: Date.now() - t0,
        });

        const plainReply = xmlTextReply({
            toUser: fromUser,
            fromUser: toUser,
            content: `绑定成功：\nrepo=${bind.repo}\npath=${defaultPath}`,
        });
        return await replyXml(res, env, url, encryptedMode, plainReply);
    }

    // Link save
    if (msgType === 'link') {
        const t0 = Date.now();
        const articleUrl = xmlGetText(xmlBody, 'Url');
        const title = xmlGetText(xmlBody, 'Title') || 'Untitled';
        const msgId = xmlGetText(xmlBody, 'MsgId');

        if (!articleUrl) {
            const plainReply = xmlTextReply({ toUser: fromUser, fromUser: toUser, content: '未找到链接 URL。' });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        const binding = await getUserBinding(env.RUMI_KV, fromUser);
        if (!binding) {
            logger.log('bind_required', { openid: logger.maskOpenId(fromUser), dur_ms: Date.now() - t0 });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content: '你还未绑定 GitHub。请发送：\nbind <github_token> <owner>/<repo> [path <prefix>]',
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        const canAsyncNotify = Boolean(env.WECHAT_APP_ID && env.WECHAT_APP_SECRET);

        let idemKey;
        if (msgId) {
            idemKey = `wxmsg:${fromUser}:${msgId}`;
        } else {
            const dateBucket = new Date().toISOString().slice(0, 10);
            idemKey = `wxurl:${await sha1Hex(`${fromUser}|${articleUrl}|${dateBucket}`)}`;
        }

        const existing = await getIdemRecord(env.RUMI_KV, idemKey);
        if (existing?.status === 'success' && existing?.result_url) {
            logger.log('idem_hit_success', { openid: logger.maskOpenId(fromUser), dur_ms: Date.now() - t0 });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content: `已处理：\n${existing.result_url}`,
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }
        if (existing?.status === 'processing' && isRecentIso(existing.updated_at, 2 * 60 * 1000)) {
            logger.log('idem_hit_processing', { openid: logger.maskOpenId(fromUser), dur_ms: Date.now() - t0 });
            const plainReply = xmlTextReply({
                toUser: fromUser,
                fromUser: toUser,
                content: '正在处理中，请稍后再试。',
            });
            return await replyXml(res, env, url, encryptedMode, plainReply);
        }

        await putIdemRecord(env.RUMI_KV, idemKey, { status: 'processing', source_url: articleUrl }, { ttlSeconds: 7 * 24 * 3600 });

        const immediateReply = canAsyncNotify ? '已收到链接，正在处理中，稍后将发送结果消息。' : '已收到链接，正在处理中…';

        const processOnce = async () => {
            logger.log('pipeline_start', { openid: logger.maskOpenId(fromUser) });
            const aesKey = await importAesKeyFromBase64(env.TOKEN_ENCRYPTION_KEY_BASE64);
            const githubToken = await decryptToken(aesKey, binding.github_token_enc);
            logger.log('fetch_start', { openid: logger.maskOpenId(fromUser) });
            const { markdown, resolvedTitle } = await fetchArticleAsMarkdown({ url: articleUrl, title });
            logger.log('fetch_done', { openid: logger.maskOpenId(fromUser), md_chars: markdown.length });
            return githubPutMarkdown({
                token: githubToken,
                repoFullName: binding.default_repo,
                pathPrefix: binding.default_path,
                title: resolvedTitle,
                sourceUrl: articleUrl,
                markdown,
                defaultBranch: env.GITHUB_DEFAULT_BRANCH ?? 'main',
            });
        };

        if (!canAsyncNotify) {
            try {
                logger.log('github_write_start', { openid: logger.maskOpenId(fromUser) });
                const putResult = await processOnce();
                logger.log('github_write_done', { openid: logger.maskOpenId(fromUser), url: putResult.html_url });
                await putIdemRecord(
                    env.RUMI_KV,
                    idemKey,
                    { status: 'success', result_url: putResult.html_url, path: putResult.path },
                    { ttlSeconds: 30 * 24 * 3600 },
                );
                const plainReply = xmlTextReply({
                    toUser: fromUser,
                    fromUser: toUser,
                    content: `已保存：${putResult.title}\n${putResult.html_url}`,
                });
                return await replyXml(res, env, url, encryptedMode, plainReply);
            } catch (err) {
                logger.log('link_processing_failed', { openid: logger.maskOpenId(fromUser), error: err?.message ?? String(err) });
                await putIdemRecord(env.RUMI_KV, idemKey, { status: 'failed', error_code: err?.message ?? 'unknown' }, { ttlSeconds: 24 * 3600 });
                const plainReply = xmlTextReply({
                    toUser: fromUser,
                    fromUser: toUser,
                    content: '处理失败：可能是链接无法访问、正文抽取失败或 GitHub 写入失败。请稍后重试或重新绑定 token。',
                });
                return await replyXml(res, env, url, encryptedMode, plainReply);
            }
        }

        ctx.waitUntil(
            (async () => {
                try {
                    const putResult = await processOnce();
                    await putIdemRecord(
                        env.RUMI_KV,
                        idemKey,
                        { status: 'success', result_url: putResult.html_url, path: putResult.path },
                        { ttlSeconds: 30 * 24 * 3600 },
                    );

                    const message = `已保存：${putResult.title}\n${putResult.html_url}`;
                    if (canAsyncNotify) {
                        const { wechatSendText } = await import('./lib/wechat/customerService.js');
                        await wechatSendText({ env, toUser: fromUser, content: message });
                    }
                } catch (err) {
                    console.log('link_processing_failed', { openid: logger.maskOpenId(fromUser), error: err?.message ?? String(err) });

                    await putIdemRecord(env.RUMI_KV, idemKey, { status: 'failed', error_code: err?.message ?? 'unknown' }, { ttlSeconds: 24 * 3600 });

                    if (canAsyncNotify) {
                        try {
                            const { wechatSendText } = await import('./lib/wechat/customerService.js');
                            await wechatSendText({
                                env,
                                toUser: fromUser,
                                content: '处理失败：可能是链接无法访问、正文抽取失败或 GitHub 写入失败。请稍后重试或重新绑定 token。',
                            });
                        } catch {
                            // ignore
                        }
                    }
                }
            })(),
        );

        logger.log('reply_sent', { openid: logger.maskOpenId(fromUser), async: true, dur_ms: Date.now() - t0 });

        const plainReply = xmlTextReply({ toUser: fromUser, fromUser: toUser, content: immediateReply });
        return await replyXml(res, env, url, encryptedMode, plainReply);
    }

    const plainReply = xmlTextReply({ toUser: fromUser, fromUser: toUser, content: '暂不支持该消息类型。' });
    return await replyXml(res, env, url, encryptedMode, plainReply);
}

async function replyXml(res, env, url, encryptedMode, plainReply) {
    if (!encryptedMode) return xml(res, plainReply);

    if (!env.WECHAT_AES_KEY || !env.WECHAT_APP_ID) {
        return text(res, 'missing crypto config', { status: 400 });
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = wechatRandomNonce();
    const encrypted = await wechatEncryptMessage({
        encodingAesKey: env.WECHAT_AES_KEY,
        appId: env.WECHAT_APP_ID,
        plaintext: plainReply,
    });
    const msgSignature = await sha1Hex([env.WECHAT_TOKEN, timestamp, nonce, encrypted].sort().join(''));
    return xml(res, wechatBuildEncryptedReplyXml({ encrypted, msgSignature, timestamp, nonce }));
}

export function mountRuminerWeChatRoutes(app, { env, ctx }) {
    // WeChat callbacks require raw XML body
    const wechatTextParser = express.text({ type: ['text/xml', 'application/xml', '*/xml'], limit: '2mb' });

    app.get('/api/healthz', (req, res) => {
        res.set('content-type', 'application/json; charset=utf-8');
        res.send({ status: 'ok' });
    });

    app.get('/api/callback', async (req, res) => {
        const requestId = getRequestId();
        const logger = createLogger({ requestId });
        res.set('x-request-id', requestId);

        try {
            await handleWeChatGet(req, res, env, logger);
        } catch (err) {
            logger.log('unhandled_error', { error: err?.message ?? String(err) });
            text(res, 'internal_error', { status: 500 });
        }
    });

    app.post('/api/callback', wechatTextParser, async (req, res) => {
        const requestId = getRequestId();
        const logger = createLogger({ requestId });
        res.set('x-request-id', requestId);

        try {
            await handleWeChatPost(req, res, env, ctx, logger);
        } catch (err) {
            logger.log('unhandled_error', { error: err?.message ?? String(err) });
            text(res, 'internal_error', { status: 500 });
        }
    });
}
