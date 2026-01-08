function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry(fn, {
    retries = 3,
    baseDelayMs = 250,
    shouldRetry = () => true,
} = {}) {
    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
        try {
            return await fn({ attempt });
        } catch (err) {
            lastErr = err;
            if (attempt >= retries || !shouldRetry(err)) break;
            const delay = baseDelayMs * Math.pow(2, attempt);
            await sleep(delay);
            attempt++;
        }
    }
    throw lastErr;
}
