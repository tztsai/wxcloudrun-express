import { maskOpenId } from './pii.js';

function safeString(value) {
    if (value == null) return undefined;
    return String(value);
}

export function createLogger({ requestId }) {
    return {
        requestId,
        log(event, fields = {}) {
            const payload = {
                ts: new Date().toISOString(),
                request_id: requestId,
                event: safeString(event),
                ...fields,
            };
            console.log(JSON.stringify(payload));
        },
        maskOpenId,
    };
}

export function getRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
