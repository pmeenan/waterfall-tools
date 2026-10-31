/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { hkdfExpandLabel } from './tls-crypto.js';

// Convert hex string to Uint8Array directly natively
function hexToBytes(hex) {
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return bytes;
}

// QUIC v1 Salt (RFC 9001 - 5.2)
const QUIC_V1_SALT = hexToBytes('38762cf7f55934b34d179ae6a4c80cadccbb7f0a');

function getWebCryptoHashName(alg) {
    if (alg.toLowerCase() === 'sha384') return 'SHA-384';
    if (alg.toLowerCase() === 'sha256') return 'SHA-256';
    if (alg.toLowerCase() === 'sha512') return 'SHA-512';
    if (alg.toLowerCase() === 'sha1') return 'SHA-1';
    return alg.toUpperCase().replace('SHA', 'SHA-');
}

/**
 * HKDF-Extract as per RFC 5869: extract = HMAC-Hash(salt, IKM)
 * Replicated using native WebCrypto HMAC
 */
async function hkdfExtract(hashAlg, salt, ikm) {
    const webAlg = getWebCryptoHashName(hashAlg);
    if (!salt || salt.length === 0) {
        const hashDump = await globalThis.crypto.subtle.digest(webAlg, new Uint8Array(0));
        salt = new Uint8Array(hashDump.byteLength);
    }
    const key = await globalThis.crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: webAlg }, false, ['sign']);
    const signature = await globalThis.crypto.subtle.sign('HMAC', key, ikm);
    return new Uint8Array(signature);
}

/**
 * Given the initial Destination Connection ID, derives the initial client and server secrets.
 */
export async function deriveInitialSecrets(dcid) {
    // QUIC Initial packets ALWAYS use SHA-256 for key derivation
    const initialSecret = await hkdfExtract('sha256', QUIC_V1_SALT, dcid);
    
    // Hash length for SHA-256 is 32 bytes
    const clientInitialSecret = await hkdfExpandLabel(initialSecret, 'client in', new Uint8Array(0), 'sha256', 32);
    const serverInitialSecret = await hkdfExpandLabel(initialSecret, 'server in', new Uint8Array(0), 'sha256', 32);

    return {
        client: await deriveTrafficKeys(clientInitialSecret, 'sha256'),
        server: await deriveTrafficKeys(serverInitialSecret, 'sha256')
    };
}

const ZERO_IV = new Uint8Array(16);
const hpKeyCache = new WeakMap();
const aeadKeyCache = new WeakMap();

/**
 * Reconstructs the full 62-bit packet number from a truncated packet number
 * header field per RFC 9000 Appendix A.3.
 *
 * @param {number} largestPn - Largest packet number successfully processed in
 *   this packet number space (-1 if none yet).
 * @param {number} truncatedPn - The truncated packet number read from the header.
 * @param {number} pnNBits - Width of the truncated packet number in bits (8, 16, 24, or 32).
 * @returns {number} Full reconstructed packet number.
 */
export function decodePacketNumber(largestPn, truncatedPn, pnNBits) {
    if (largestPn === null || largestPn === undefined || largestPn < 0) {
        return truncatedPn;
    }
    const expectedBig = BigInt(largestPn) + 1n;
    const winBig = 1n << BigInt(pnNBits);
    const hwinBig = winBig >> 1n;
    const maskBig = winBig - 1n;
    const truncBig = BigInt(truncatedPn);

    const candidatePn = (expectedBig & ~maskBig) | truncBig;
    if (candidatePn <= expectedBig - hwinBig && candidatePn < (1n << 62n) - winBig) {
        return Number(candidatePn + winBig);
    }
    if (candidatePn > expectedBig + hwinBig && candidatePn >= winBig) {
        return Number(candidatePn - winBig);
    }
    return Number(candidatePn);
}

/**
 * Given a Traffic Secret (Initial or 1-RTT), derive the AEAD Key, IV, and Header Protection (HP) Key.
 * Supports both TLS_AES_128_GCM_SHA256 (32-byte secret → SHA-256, 16-byte key)
 * and TLS_AES_256_GCM_SHA384 (48-byte secret → SHA-384, 32-byte key).
 */
export async function deriveTrafficKeys(secret, hashAlg = null) {
    const useSha384 = (hashAlg && hashAlg.toLowerCase().replace('-', '') === 'sha384') || (!hashAlg && secret && secret.length === 48);
    const resolvedHash = useSha384 ? 'sha384' : (hashAlg || 'sha256');
    const keyLen = useSha384 ? 32 : 16;

    const key = await hkdfExpandLabel(secret, 'quic key', new Uint8Array(0), resolvedHash, keyLen);
    const iv = await hkdfExpandLabel(secret, 'quic iv', new Uint8Array(0), resolvedHash, 12);
    const hp = await hkdfExpandLabel(secret, 'quic hp', new Uint8Array(0), resolvedHash, keyLen);

    const hpCryptoKey = await globalThis.crypto.subtle.importKey('raw', hp, { name: 'AES-CBC' }, false, ['encrypt']);
    const aeadCryptoKey = await globalThis.crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    hpKeyCache.set(hp, hpCryptoKey);
    aeadKeyCache.set(key, aeadCryptoKey);

    return { key, iv, hp, hpCryptoKey, aeadCryptoKey };
}

/**
 * Apply header protection mask using WebCrypto AES-CBC workaround for ECB.
 */
export async function generateHeaderProtectionMask(hpKey, sample) {
    // WebCrypto does not expose AES-ECB. Since the QUIC sample is precisely 16 bytes (1 block),
    // AES-CBC with a zeroed validation IV provides identical single-block ciphertext natively!
    let key = (hpKey && hpKey.type === 'secret') ? hpKey : hpKeyCache.get(hpKey);
    if (!key) {
        key = await globalThis.crypto.subtle.importKey('raw', hpKey, { name: 'AES-CBC' }, false, ['encrypt']);
        if (hpKey && typeof hpKey === 'object') hpKeyCache.set(hpKey, key);
    }

    const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
        { name: "AES-CBC", iv: ZERO_IV },
        key,
        sample
    );

    // Slice only the first 16 bytes natively excluding standard AES PKCS#7 padding seamlessly!
    return new Uint8Array(ciphertextBuffer).subarray(0, 16);
}

/**
 * Decrypts a QUIC AEAD block using asynchronous WebCrypto AES-GCM natively.
 */
export async function decryptQuicPayload(keyBytes, ivBytes, packetNumber, header, payload) {
    // Reconstruct the Nonce: IV XOR extended packet number
    const nonce = new Uint8Array(ivBytes.length);
    nonce.set(ivBytes);
    
    for (let i = 0; i < 8; i++) {
        const pnByte = Number((BigInt(packetNumber) >> BigInt(8 * (7 - i))) & 0xFFn);
        nonce[nonce.length - 8 + i] ^= pnByte;
    }

    try {
        let key = (keyBytes && keyBytes.type === 'secret') ? keyBytes : aeadKeyCache.get(keyBytes);
        if (!key) {
            key = await globalThis.crypto.subtle.importKey(
                'raw', 
                keyBytes, 
                { name: 'AES-GCM' }, 
                false, 
                ['decrypt']
            );
            if (keyBytes && typeof keyBytes === 'object') aeadKeyCache.set(keyBytes, key);
        }
        
        // In native WebCrypto AES-GCM, the ciphertext properly contains the auth tag securely implicitly at the end!
        const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: nonce,
                additionalData: header,
                tagLength: 128
            },
            key,
            payload
        );
        
        return new Uint8Array(decryptedBuffer);
    } catch (e) {
        if (globalThis.waterfallDebug) console.log(`[QUIC Crypto] Decrypt DOMException: [${e.name}] ${e.message}`, e);
        return null;
    }
}
