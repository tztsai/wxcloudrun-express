import { sha1Hex } from '../crypto/sha1.js';

export async function enforceWeChatReplayGuard({ env, url }) {
    // Applies to POST callbacks. Uses KV to reject repeated (timestamp, nonce) pairs.
    const timestamp = url.searchParams.get('timestamp');
    const nonce = url.searchParams.get('nonce');
    if (!timestamp || !nonce) return { ok: false, reason: 'missing_timestamp_or_nonce' };

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_timestamp' };

    const toleranceSeconds = Number(env.WECHAT_TIMESTAMP_TOLERANCE_SECONDS ?? 600);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > toleranceSeconds) return { ok: false, reason: 'timestamp_out_of_range' };

    if (!env.RUMI_KV) return { ok: false, reason: 'kv_missing' };

    const key = await sha1Hex(`wxnonce|${timestamp}|${nonce}`);
    const kvKey = `wxnonce:${key}`;
    const exists = await env.RUMI_KV.get(kvKey);
    if (exists) return { ok: false, reason: 'replay_detected' };
    await env.RUMI_KV.put(kvKey, '1', { expirationTtl: Math.max(60, toleranceSeconds) });
    return { ok: true };
}
