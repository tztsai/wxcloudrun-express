export function createSequelizeKvAdapter({ Kv }) {
    return {
        async get(key) {
            const now = new Date();
            const row = await Kv.findByPk(key);
            if (!row) return null;
            const expiresAt = row.get('expires_at');
            if (expiresAt && expiresAt <= now) {
                try {
                    await row.destroy();
                } catch {
                    // best-effort cleanup
                }
                return null;
            }
            return row.get('v');
        },

        async put(key, value, options = {}) {
            const expirationTtl = options?.expirationTtl;
            const expiresAt =
                typeof expirationTtl === 'number' && Number.isFinite(expirationTtl) && expirationTtl > 0
                    ? new Date(Date.now() + expirationTtl * 1000)
                    : null;

            await Kv.upsert({
                k: key,
                v: String(value),
                expires_at: expiresAt,
            });
        },
    };
}
