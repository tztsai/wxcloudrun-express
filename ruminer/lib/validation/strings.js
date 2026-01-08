export function isValidRepoFullName(repo) {
    if (typeof repo !== 'string') return false;
    // Very small validation: owner/repo with allowed chars.
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

export function normalizePathPrefix(prefix) {
    let p = String(prefix || '').trim();
    if (!p) p = 'articles/';
    p = p.replace(/^\//, '');
    if (!p.endsWith('/')) p += '/';
    return p;
}

export function slugify(input) {
    const base = String(input || '')
        .toLowerCase()
        .replace(/['"`]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
    return base;
}
