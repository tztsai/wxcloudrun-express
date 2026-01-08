export function maskOpenId(openid) {
    if (!openid) return '';
    if (openid.length <= 8) return '***';
    return `${openid.slice(0, 4)}***${openid.slice(-4)}`;
}
