const IDEM_KEY_PREFIX = 'idem:';

export async function getIdemRecord(kv, key) {
    if (!kv) throw new Error('RUMI_KV binding missing');
    const raw = await kv.get(`${IDEM_KEY_PREFIX}${key}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function putIdemRecord(kv, key, record, { ttlSeconds } = {}) {
    if (!kv) throw new Error('RUMI_KV binding missing');
    const now = new Date().toISOString();
    const payload = {
        ...record,
        updated_at: now,
        created_at: record.created_at ?? now,
    };
    const options = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
    await kv.put(`${IDEM_KEY_PREFIX}${key}`, JSON.stringify(payload), options);
    return payload;
}

export function isRecentIso(iso, withinMs) {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return false;
    return Date.now() - t <= withinMs;
}
