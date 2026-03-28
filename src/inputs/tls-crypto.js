import crypto from 'node:crypto';

/**
 * Creates the HkdfLabel structure for TLS 1.3 HKDF expansion.
 */
function createHkdfLabel(length, label, context) {
    const prefix = Buffer.from('tls13 ' + label, 'ascii');
    
    // length (2) + prefix length byte (1) + prefix + context length byte (1) + context
    const labelBuf = Buffer.alloc(2 + 1 + prefix.length + 1 + context.length);
    let offset = 0;
    
    // uint16 length
    labelBuf.writeUInt16BE(length, offset);
    offset += 2;
    
    // opaque label<7..255>
    labelBuf.writeUInt8(prefix.length, offset);
    offset += 1;
    prefix.copy(labelBuf, offset);
    offset += prefix.length;
    
    // opaque context<0..255>
    labelBuf.writeUInt8(context.length, offset);
    offset += 1;
    context.copy(labelBuf, offset);
    
    return labelBuf;
}

/**
 * TLS 1.3 HKDF-Expand-Label
 * Utilizes Node native crypto.hkdfSync under the hood. 
 * Since HKDF-Expand is technically the expansion phase without extraction, 
 * we simulate the raw PRF expand by extracting with an empty salt if necessary,
 * or using crypto.hkdfSync directly if it functions identically.
 * Note: crypto.hkdfSync computes both Extract and Expand. 
 * To do purely HKDF-Expand, we use standard HMAC iteratively as defined in RFC 5869.
 */
export function hkdfExpandLabel(secret, labelStr, contextBuf, hashAlg, length) {
    const info = createHkdfLabel(length, labelStr, contextBuf);
    return hkdfExpand(hashAlg, secret, info, length);
}

/**
 * HKDF-Expand implementation (RFC 5869)
 * Used directly because Node's crypto.hkdfSync does both Extract+Expand together,
 * and TLS 1.3 Key Schedules provide the already-extracted Secret.
 */
export function hkdfExpand(hashAlg, prk, info, length) {
    const hashLen = crypto.createHash(hashAlg).digest().length;
    const n = Math.ceil(length / hashLen);
    
    const blockList = [];
    let t = Buffer.alloc(0);
    
    for (let i = 1; i <= n; i++) {
        const hmac = crypto.createHmac(hashAlg, prk);
        hmac.update(t);
        hmac.update(info);
        hmac.update(Buffer.from([i]));
        t = hmac.digest();
        blockList.push(t);
    }
    
    return Buffer.concat(blockList).subarray(0, length);
}

/**
 * TLS 1.2 PRF implementation (RFC 5246)
 * P_hash(secret, seed) = HMAC_hash(secret, A(1) + seed) +
 *                        HMAC_hash(secret, A(2) + seed) + ...
 * Where A(0) = seed, A(i) = HMAC_hash(secret, A(i-1))
 */
function pHash(hashAlg, secret, seed, length) {
    const hashLen = crypto.createHash(hashAlg).digest().length;
    const blockList = [];
    let currentA = seed;

    while (blockList.length * hashLen < length) {
        // A(i) = HMAC(secret, A(i-1))
        let hmacA = crypto.createHmac(hashAlg, secret);
        hmacA.update(currentA);
        currentA = hmacA.digest();

        // HMAC(secret, A(i) + seed)
        let hmacBlock = crypto.createHmac(hashAlg, secret);
        hmacBlock.update(currentA);
        hmacBlock.update(seed);
        blockList.push(hmacBlock.digest());
    }

    return Buffer.concat(blockList).subarray(0, length);
}

export function prfTls12(secret, labelStr, seedBuf, hashAlg, length) {
    const labelBuf = Buffer.from(labelStr, 'ascii');
    const seed = Buffer.concat([labelBuf, seedBuf]);
    return pHash(hashAlg, secret, seed, length);
}
