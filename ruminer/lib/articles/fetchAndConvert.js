import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { validateFetchUrl } from '../net/ssrf.js';
import { withRetry } from '../util/retry.js';

function htmlToMarkdown(html) {
    // Turndown's browser bundle tries DOMParser when given a string.
    // In Workers, that path can require `doc.open()` which LinkeDOM doesn't provide.
    // Passing a DOM Node avoids that code path.
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    return turndown.turndown(document.body);
}

function cleanupMarkdown(md) {
    return md
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function fetchWithTimeout(url, { timeoutMs = 8000, headers = {} } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
        return await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            headers: {
                'user-agent': 'Mozilla/5.0 (compatible; RuminerWeChatService/1.0; +https://example.com)',
                accept: 'text/html,application/xhtml+xml',
                ...headers,
            },
        });
    } finally {
        clearTimeout(timeout);
    }
}

function extractMainHtml(html) {
    const { document } = parseHTML(html);
    // Remove noisy tags
    for (const selector of ['script', 'style', 'nav', 'footer', 'aside', 'noscript']) {
        for (const el of document.querySelectorAll(selector)) el.remove();
    }

    const wechat = document.querySelector('#js_content');
    if (wechat) return wechat.innerHTML;
    const article = document.querySelector('article');
    if (article) return article.innerHTML;
    return document.body?.innerHTML || html;
}

function extractTitle(html) {
    const { document } = parseHTML(html);
    const activityName = document.querySelector('#activity-name');
    if (activityName?.textContent?.trim()) return activityName.textContent.trim();

    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle?.trim()) return ogTitle.trim();

    const metaTitle = document.querySelector('meta[name="title"]')?.getAttribute('content');
    if (metaTitle?.trim()) return metaTitle.trim();

    if (document.title?.trim()) return document.title.trim();

    const h1 = document.querySelector('h1');
    if (h1?.textContent?.trim()) return h1.textContent.trim();

    return '';
}

export async function fetchArticleAsMarkdown({ url, title }) {
    const validated = validateFetchUrl(url);
    if (!validated.ok) throw new Error(`fetch_blocked:${validated.reason}`);

    const res = await withRetry(
        () => fetchWithTimeout(validated.url.toString()),
        {
            retries: 2,
            baseDelayMs: 300,
            shouldRetry: (err) => String(err?.message || err).includes('timeout'),
        },
    );
    if (!res.ok) {
        // Retry transient upstream errors once more if needed
        if (res.status >= 500 && res.status <= 599) {
            const res2 = await fetchWithTimeout(validated.url.toString());
            if (!res2.ok) throw new Error(`fetch_failed:${res2.status}`);
            const html2 = await res2.text();
            const mainHtml2 = extractMainHtml(html2);
            const markdown2 = cleanupMarkdown(htmlToMarkdown(mainHtml2));
            return { markdown: markdown2, resolvedTitle: title || 'Untitled' };
        }
        throw new Error(`fetch_failed:${res.status}`);
    }

    const html = await res.text();
    const mainHtml = extractMainHtml(html);
    const extractedTitle = extractTitle(html);

    const markdown = cleanupMarkdown(htmlToMarkdown(mainHtml));
    return { markdown, resolvedTitle: (title || extractedTitle || 'Untitled').trim() };
}
