import { sha1Hex } from '../crypto/sha1.js';

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

function concatBytes(...chunks) {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
    }
    return out;
}

function pkcs7Pad(data, blockSize = 32) {
    const padLen = blockSize - (data.byteLength % blockSize || blockSize);
    const out = new Uint8Array(data.byteLength + padLen);
    out.set(data, 0);
    out.fill(padLen, data.byteLength);
    return out;
}

function pkcs7Unpad(data) {
    if (!data?.byteLength) throw new Error('wechat_crypto_invalid_padding');
    const padLen = data[data.byteLength - 1];
    if (padLen < 1 || padLen > 32) throw new Error('wechat_crypto_invalid_padding');
    for (let i = data.byteLength - padLen; i < data.byteLength; i++) {
        if (data[i] !== padLen) throw new Error('wechat_crypto_invalid_padding');
    }
    return data.slice(0, data.byteLength - padLen);
}

function readUint32BE(bytes, offset) {
    return (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]
    ) >>> 0;
}

function writeUint32BE(value) {
    const out = new Uint8Array(4);
    out[0] = (value >>> 24) & 0xff;
    out[1] = (value >>> 16) & 0xff;
    out[2] = (value >>> 8) & 0xff;
    out[3] = value & 0xff;
    return out;
}

function normalizeEncodingAesKey(encodingAesKey) {
    // WeChat provides 43 chars base64 without '=' padding.
    const normalized = `${encodingAesKey}=`;
    const raw = base64ToBytes(normalized);
    if (raw.byteLength !== 32) {
        throw new Error('WECHAT_AES_KEY must decode to 32 bytes (EncodingAESKey)');
    }
    return raw;
}

async function importAesCbcKey(raw32) {
    return crypto.subtle.importKey('raw', raw32, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

function getIvFromRawKey(raw32) {
    return raw32.slice(0, 16);
}

export async function wechatVerifySignaturePlain({ token, timestamp, nonce, signature }) {
    if (!token || !timestamp || !nonce || !signature) return false;
    const parts = [token, timestamp, nonce].sort();
    const computed = await sha1Hex(parts.join(''));
    return computed === signature;
}

export async function wechatVerifyMsgSignature({ token, timestamp, nonce, msgSignature, encrypted }) {
    if (!token || !timestamp || !nonce || !msgSignature || !encrypted) return false;
    const parts = [token, timestamp, nonce, encrypted].sort();
    const computed = await sha1Hex(parts.join(''));
    return computed === msgSignature;
}

export async function wechatDecryptMessage({ encodingAesKey, appId, encryptedBase64 }) {
    const rawKey = normalizeEncodingAesKey(encodingAesKey);
    const iv = getIvFromRawKey(rawKey);
    const aesKey = await importAesCbcKey(rawKey);

    const cipherBytes = base64ToBytes(encryptedBase64);
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, cipherBytes);
    const plaintextPadded = new Uint8Array(plaintextBuf);
    const plaintext = pkcs7Unpad(plaintextPadded);

    // plaintext = 16 random + 4 msg_len + msg + appId
    if (plaintext.byteLength < 16 + 4 + 1) throw new Error('wechat_crypto_invalid_plaintext');
    const msgLen = readUint32BE(plaintext, 16);
    const msgStart = 20;
    const msgEnd = msgStart + msgLen;
    if (msgEnd > plaintext.byteLength) throw new Error('wechat_crypto_invalid_plaintext');
    const msgBytes = plaintext.slice(msgStart, msgEnd);
    const appIdBytes = plaintext.slice(msgEnd);

    const msg = new TextDecoder().decode(msgBytes);
    const receivedAppId = new TextDecoder().decode(appIdBytes);
    if (appId && receivedAppId && receivedAppId !== appId) {
        throw new Error('wechat_crypto_appid_mismatch');
    }
    return msg;
}

export async function wechatEncryptMessage({ encodingAesKey, appId, plaintext }) {
    if (!appId) throw new Error('wechat_crypto_missing_appid');
    const rawKey = normalizeEncodingAesKey(encodingAesKey);
    const iv = getIvFromRawKey(rawKey);
    const aesKey = await importAesCbcKey(rawKey);

    const random16 = crypto.getRandomValues(new Uint8Array(16));
    const msgBytes = new TextEncoder().encode(plaintext);
    const lenBytes = writeUint32BE(msgBytes.byteLength);
    const appIdBytes = new TextEncoder().encode(appId);
    const packed = concatBytes(random16, lenBytes, msgBytes, appIdBytes);
    const padded = pkcs7Pad(packed, 32);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, padded);
    return bytesToBase64(new Uint8Array(cipherBuf));
}

export function wechatBuildEncryptedReplyXml({ encrypted, msgSignature, timestamp, nonce }) {
    // Minimal XML wrapper for encrypted passive replies.
    return `<?xml version="1.0" encoding="UTF-8"?>
<xml>
	<Encrypt><![CDATA[${String(encrypted)}]]></Encrypt>
	<MsgSignature><![CDATA[${String(msgSignature)}]]></MsgSignature>
	<TimeStamp>${String(timestamp)}</TimeStamp>
	<Nonce><![CDATA[${String(nonce)}]]></Nonce>
</xml>`;
}

export function wechatRandomNonce() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let out = '';
    for (const b of bytes) out += (b % 10).toString(10);
    return out;
}
