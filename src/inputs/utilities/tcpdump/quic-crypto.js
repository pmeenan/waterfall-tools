import { hkdfExpandLabel, hkdfExpand } from './tls-crypto.js';

// Convert hex string to Uint8Array directly natively
function hexToBytes(hex) {
    let bytes = new Uint8Array(Math.ceil(hex.length / 2));
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

/**
 * Given a Traffic Secret (Initial or 1-RTT), derive the AEAD Key, IV, and Header Protection (HP) Key.
 */
export async function deriveTrafficKeys(secret, hashAlg = 'sha256') {
    const key = await hkdfExpandLabel(secret, 'quic key', new Uint8Array(0), hashAlg, 16);
    const iv = await hkdfExpandLabel(secret, 'quic iv', new Uint8Array(0), hashAlg, 12);
    const hp = await hkdfExpandLabel(secret, 'quic hp', new Uint8Array(0), hashAlg, 16);
    
    return { key, iv, hp };
}

/**
 * Apply header protection mask using WebCrypto AES-CBC workaround for ECB.
 */
export async function generateHeaderProtectionMask(hpKey, sample) {
    // WebCrypto does not expose AES-ECB. Since the QUIC sample is precisely 16 bytes (1 block),
    // AES-CBC with a zeroed validation IV provides identical single-block ciphertext natively!
    const key = await globalThis.crypto.subtle.importKey('raw', hpKey, { name: 'AES-CBC' }, false, ['encrypt']);
    
    // Zeroed 16-byte initialization vector natively maps ECB
    const iv = new Uint8Array(16); 
    
    const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
        { name: "AES-CBC", iv: iv },
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
        const key = await globalThis.crypto.subtle.importKey(
            'raw', 
            keyBytes, 
            { name: 'AES-GCM' }, 
            false, 
            ['decrypt']
        );
        
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
        return null; // Auth failed transparently
    }
}
