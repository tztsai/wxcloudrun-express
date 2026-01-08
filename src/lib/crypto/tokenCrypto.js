function base64ToBytes(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

export async function importAesKeyFromBase64(base64Key) {
    const raw = base64ToBytes(base64Key);
    if (raw.byteLength !== 32) {
        throw new Error('TOKEN_ENCRYPTION_KEY_BASE64 must be 32 bytes (base64-encoded)');
    }
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(aesKey, token) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(token);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
    const cipherBytes = new Uint8Array(ciphertext);
    const payload = new Uint8Array(iv.byteLength + cipherBytes.byteLength);
    payload.set(iv, 0);
    payload.set(cipherBytes, iv.byteLength);
    return bytesToBase64(payload);
}

export async function decryptToken(aesKey, tokenEncBase64) {
    const payload = base64ToBytes(tokenEncBase64);
    if (payload.byteLength < 13) throw new Error('invalid encrypted token');
    const iv = payload.slice(0, 12);
    const cipherBytes = payload.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipherBytes);
    return new TextDecoder().decode(plaintext);
}
