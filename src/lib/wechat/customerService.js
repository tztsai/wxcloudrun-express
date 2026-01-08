const TOKEN_KV_KEY = 'wechat:access_token';
let memoryCache = null;

function isTokenUsable(expiresAtMs, skewMs = 90_000) {
    return typeof expiresAtMs === 'number' && expiresAtMs > Date.now() + skewMs;
}

function normalizeWeChatTokenError(data, fallback) {
    const errcode = data?.errcode;
    const errmsg = data?.errmsg;
    if (typeof errcode === 'number' && errcode !== 0) {
        // Common cases from WeChat docs / platform notes:
        // 40243: AppSecret frozen
        // 61004: IP not in whitelist
        // 89503: risk confirmation required
        return new Error(`wechat_token_failed:${errcode}:${errmsg || 'unknown'}`);
    }
    return new Error(fallback);
}

async function requestAccessTokenStable({ appId, appSecret }) {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/stable_token');
    const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'client_credential',
            appid: appId,
            secret: appSecret,
            force_refresh: false,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw normalizeWeChatTokenError(data, `wechat_token_http_failed:${res.status}`);
    if (!data?.access_token) throw normalizeWeChatTokenError(data, `wechat_token_missing:${data?.errmsg || 'unknown'}`);
    return { accessToken: data.access_token, expiresIn: Number(data.expires_in || 7200) };
}

async function requestAccessTokenLegacy({ appId, appSecret }) {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    const res = await fetch(url.toString(), { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw normalizeWeChatTokenError(data, `wechat_token_http_failed:${res.status}`);
    if (!data?.access_token) throw normalizeWeChatTokenError(data, `wechat_token_missing:${data?.errmsg || 'unknown'}`);
    return { accessToken: data.access_token, expiresIn: Number(data.expires_in || 7200) };
}

async function getAccessToken({ env }) {
    const appId = env.WECHAT_APP_ID;
    const appSecret = env.WECHAT_APP_SECRET;
    if (!appId || !appSecret) throw new Error('wechat_token_missing_config');

    if (memoryCache && isTokenUsable(memoryCache.expires_at_ms)) {
        return memoryCache.access_token;
    }

    // Prefer KV cache when available to avoid frequent refresh and token invalidation.
    if (env.RUMI_KV) {
        try {
            const raw = await env.RUMI_KV.get(TOKEN_KV_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed?.access_token && isTokenUsable(parsed?.expires_at_ms)) {
                    memoryCache = parsed;
                    return parsed.access_token;
                }
            }
        } catch {
            // Ignore cache errors and continue to fetch.
        }
    }

    // Request new token: try stable endpoint first, then fallback.
    let issued;
    try {
        issued = await requestAccessTokenStable({ appId, appSecret });
    } catch (err) {
        issued = await requestAccessTokenLegacy({ appId, appSecret });
    }

    const ttlSeconds = Math.max(60, Math.min(issued.expiresIn, 7200) - 300);
    const payload = {
        access_token: issued.accessToken,
        // Keep a safety margin to reduce chance of using an expired token.
        expires_at_ms: Date.now() + ttlSeconds * 1000,
        updated_at: new Date().toISOString(),
    };
    memoryCache = payload;
    if (env.RUMI_KV) {
        try {
            await env.RUMI_KV.put(TOKEN_KV_KEY, JSON.stringify(payload), { expirationTtl: ttlSeconds });
        } catch {
            // Cache write failure shouldn't break message sending.
        }
    }
    return payload.access_token;
}

export async function wechatSendText({ env, toUser, content }) {
    const accessToken = await getAccessToken({ env });
    const url = new URL('https://api.weixin.qq.com/cgi-bin/message/custom/send');
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            touser: toUser,
            msgtype: 'text',
            text: { content },
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errcode) {
        throw new Error(`wechat_send_failed:${data.errcode ?? res.status}`);
    }
    return data;
}
