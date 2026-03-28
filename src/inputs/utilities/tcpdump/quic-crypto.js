import crypto from 'node:crypto';
import { hkdfExpandLabel, hkdfExpand } from './tls-crypto.js';

// QUIC v1 Salt (RFC 9001 - 5.2)
const QUIC_V1_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');

/**
 * HKDF-Extract as per RFC 5869: extract = HMAC-Hash(salt, IKM)
 */
function hkdfExtract(hashAlg, salt, ikm) {
    if (!salt || salt.length === 0) {
        salt = Buffer.alloc(crypto.createHash(hashAlg).digest().length);
    }
    return crypto.createHmac(hashAlg, salt).update(ikm).digest();
}

/**
 * Given the initial Destination Connection ID, derives the initial client and server secrets.
 */
export function deriveInitialSecrets(dcid) {
    // QUIC Initial packets ALWAYS use SHA-256 for key derivation
    const initialSecret = hkdfExtract('sha256', QUIC_V1_SALT, dcid);
    
    // Hash length for SHA-256 is 32 bytes
    const clientInitialSecret = hkdfExpandLabel(initialSecret, 'client in', Buffer.alloc(0), 'sha256', 32);
    const serverInitialSecret = hkdfExpandLabel(initialSecret, 'server in', Buffer.alloc(0), 'sha256', 32);

    return {
        client: deriveTrafficKeys(clientInitialSecret, 'sha256'),
        server: deriveTrafficKeys(serverInitialSecret, 'sha256')
    };
}

/**
 * Given a Traffic Secret (Initial or 1-RTT), derive the AEAD Key, IV, and Header Protection (HP) Key.
 */
export function deriveTrafficKeys(secret, hashAlg = 'sha256') {
    // AEAD Key length for AES-128-GCM is 16 bytes.
    // IV length is ALWAYS 12 bytes for QUIC payloads.
    // HP Key length is 16 bytes for AES-128-ECB.
    
    const key = hkdfExpandLabel(secret, 'quic key', Buffer.alloc(0), hashAlg, 16);
    const iv = hkdfExpandLabel(secret, 'quic iv', Buffer.alloc(0), hashAlg, 12);
    const hp = hkdfExpandLabel(secret, 'quic hp', Buffer.alloc(0), hashAlg, 16);
    
    return { key, iv, hp };
}

/**
 * Apply header protection mask.
 * QUIC uses AES-128-ECB to generate a mask from the sample.
 */
export function generateHeaderProtectionMask(hpKey, sample) {
    // Use AES-ECB for header protection mask generation
    // crypto.createCipheriv expects an IV, but ECB doesn't use one, so pass empty Buffer or strictly null
    const cipher = crypto.createCipheriv('aes-128-ecb', hpKey, null);
    
    // Ensure padding is disabled to match spec exact block sizes
    cipher.setAutoPadding(false);
    return cipher.update(sample);
}

/**
 * Decrypts a QUIC AEAD block.
 */
export function decryptQuicPayload(key, iv, packetNumber, header, payload) {
    // Reconstruct the Nonce: IV XOR extended packet number
    const nonce = Buffer.from(iv);
    // Packet numbers are written at the end of the IV array limit
    for (let i = 0; i < 8; i++) {
        // Shift PN to fit bottom bytes
        const pnByte = Number((BigInt(packetNumber) >> BigInt(8 * (7 - i))) & 0xFFn);
        // The packet number is padded with 0s to 64 bytes (8 bytes) 
        nonce[iv.length - 8 + i] ^= pnByte;
    }

    const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(payload.subarray(-16)); // Standard 16 byte tag
    
    decipher.setAAD(header); // Context AAD is the entire complete QUIC unmasked header
    
    const ciphertext = payload.subarray(0, -16);
    
    const decrypted = decipher.update(ciphertext);
    try {
        const final = decipher.final();
        return Buffer.concat([decrypted, final]);
    } catch (e) {
        return null; // Auth failed
    }
}
