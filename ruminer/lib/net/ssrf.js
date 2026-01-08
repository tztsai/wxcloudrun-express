function isIpv4(host) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(host) {
    if (!isIpv4(host)) return false;
    const parts = host.split('.').map((x) => Number(x));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
}

function isLocalhostName(host) {
    const h = host.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost');
}

function isPrivateIpv6(host) {
    const h = host.toLowerCase();
    if (h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7
    return false;
}

export function validateFetchUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return { ok: false, reason: 'invalid_url' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: 'invalid_protocol' };
    }
    const host = url.hostname;
    if (isLocalhostName(host)) return { ok: false, reason: 'localhost_blocked' };
    if (isPrivateIpv4(host)) return { ok: false, reason: 'private_ip_blocked' };
    if (isPrivateIpv6(host)) return { ok: false, reason: 'private_ip_blocked' };
    return { ok: true, url };
}
