const USER_KEY_PREFIX = 'user:';

export async function getUserBinding(kv, openid) {
    if (!kv) throw new Error('RUMI_KV binding missing');
    const raw = await kv.get(`${USER_KEY_PREFIX}${openid}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function setUserBinding(kv, openid, binding) {
    if (!kv) throw new Error('RUMI_KV binding missing');
    const now = new Date().toISOString();
    const payload = {
        ...binding,
        updated_at: now,
        created_at: binding.created_at ?? now,
    };
    await kv.put(`${USER_KEY_PREFIX}${openid}`, JSON.stringify(payload));
    return payload;
}
