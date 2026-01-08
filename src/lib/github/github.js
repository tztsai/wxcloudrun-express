import { withRetry } from '../util/retry.js';
import { slugify } from '../validation/strings.js';

function assertOk(response, message) {
    if (response.ok) return;
    throw new Error(`${message}: ${response.status}`);
}

export async function githubGetRepo({ token, repoFullName }) {
    const res = await withRetry(
        () =>
            fetch(`https://api.github.com/repos/${repoFullName}`, {
                method: 'GET',
                headers: {
                    accept: 'application/vnd.github+json',
                    authorization: `Bearer ${token}`,
                    'user-agent': 'ruminer-wechat-service',
                },
            }),
        {
            retries: 2,
            baseDelayMs: 300,
            shouldRetry: (err) => (err && err.name === 'TypeError') || false,
        },
    );
    assertOk(res, 'github repo access failed');
    return res.json();
}

function bytesToBase64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

function buildFrontmatter({ title, sourceUrl }) {
    const now = new Date().toISOString();
    return `---\ntitle: "${String(title).replace(/"/g, '\\"')}"\ndate: ${now}\nsource: ${sourceUrl}\n---\n\n`;
}

async function githubGetContentSha({ token, repoFullName, path, ref }) {
    const url = new URL(`https://api.github.com/repos/${repoFullName}/contents/${path}`);
    if (ref) url.searchParams.set('ref', ref);
    const res = await withRetry(
        () =>
            fetch(url.toString(), {
                method: 'GET',
                headers: {
                    accept: 'application/vnd.github+json',
                    authorization: `Bearer ${token}`,
                    'user-agent': 'ruminer-wechat-service',
                },
            }),
        {
            retries: 2,
            baseDelayMs: 300,
            shouldRetry: (err) => (err && err.name === 'TypeError') || false,
        },
    );
    if (res.status === 404) return null;
    assertOk(res, 'github get content failed');
    const data = await res.json();
    return data.sha ?? null;
}

export async function githubPutMarkdown({
    token,
    repoFullName,
    pathPrefix,
    title,
    sourceUrl,
    markdown,
    defaultBranch,
}) {
    const safeTitle = title || 'Untitled';
    const slug = slugify(safeTitle) || `article-${Date.now()}`;
    const path = `${pathPrefix}${slug}.md`;
    const body = buildFrontmatter({ title: safeTitle, sourceUrl }) + markdown.trim() + '\n';
    const contentB64 = bytesToBase64(new TextEncoder().encode(body));

    const sha = await githubGetContentSha({ token, repoFullName, path, ref: defaultBranch });
    const res = await withRetry(
        () =>
            fetch(`https://api.github.com/repos/${repoFullName}/contents/${path}`, {
                method: 'PUT',
                headers: {
                    accept: 'application/vnd.github+json',
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                    'user-agent': 'ruminer-wechat-service',
                },
                body: JSON.stringify({
                    message: `Save article: ${safeTitle}`,
                    content: contentB64,
                    branch: defaultBranch,
                    ...(sha ? { sha } : {}),
                }),
            }),
        {
            retries: 2,
            baseDelayMs: 400,
            shouldRetry: (err) => (err && err.name === 'TypeError') || false,
        },
    );
    assertOk(res, 'github write failed');
    const data = await res.json();
    return {
        title: safeTitle,
        path,
        html_url: data?.content?.html_url || `https://github.com/${repoFullName}/blob/${defaultBranch}/${path}`,
    };
}
