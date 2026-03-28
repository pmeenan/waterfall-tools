/**
 * TLS 1.3 HKDF-Expand-Label
 * Utilizes WebCrypto natively underneath dynamically simulating the raw PRF manually across Promises.
 */

// Format generic strings consistently to WebCrypto hash names (e.g. 'sha256' -> 'SHA-256')
function getWebCryptoHashName(alg) {
    if (alg.toLowerCase() === 'sha384') return 'SHA-384';
    if (alg.toLowerCase() === 'sha256') return 'SHA-256';
    if (alg.toLowerCase() === 'sha512') return 'SHA-512';
    if (alg.toLowerCase() === 'sha1') return 'SHA-1';
    return alg.toUpperCase().replace('SHA', 'SHA-');
}

/**
 * Universal Array concatenation
 */
function concatUint8Arrays(arrays) {
    const len = arrays.reduce((acc, a) => acc + a.length, 0);
    const result = new Uint8Array(len);
    let offset = 0;
    for (let a of arrays) {
        result.set(a, offset);
        offset += a.length;
    }
    return result;
}

/**
 * Perform a single HMAC pass over an array of data buffers
 */
async function computeHmac(hashAlg, keyBytes, dataChunks) {
    const webAlg = getWebCryptoHashName(hashAlg);
    const key = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: webAlg }, false, ['sign']);
    const data = concatUint8Arrays(dataChunks);
    const signature = await globalThis.crypto.subtle.sign('HMAC', key, data);
    return new Uint8Array(signature);
}

/**
 * Creates the HkdfLabel structure for TLS 1.3 HKDF expansion.
 */
function createHkdfLabel(length, label, context) {
    const encoder = new TextEncoder();
    const prefix = encoder.encode('tls13 ' + label);
    
    // length (2) + prefix length byte (1) + prefix + context length byte (1) + context
    const labelBuf = new Uint8Array(2 + 1 + prefix.length + 1 + context.length);
    let offset = 0;
    
    // uint16 length (Big Endian)
    labelBuf[offset] = (length >> 8) & 0xff;
    labelBuf[offset + 1] = length & 0xff;
    offset += 2;
    
    // opaque label<7..255>
    labelBuf[offset] = prefix.length;
    offset += 1;
    labelBuf.set(prefix, offset);
    offset += prefix.length;
    
    // opaque context<0..255>
    labelBuf[offset] = context.length;
    offset += 1;
    labelBuf.set(context, offset);
    
    return labelBuf;
}

export async function hkdfExpandLabel(secret, labelStr, contextBuf, hashAlg, length) {
    const info = createHkdfLabel(length, labelStr, contextBuf);
    return await hkdfExpand(hashAlg, secret, info, length);
}

/**
 * HKDF-Expand implementation (RFC 5869) mapped to async WebCrypto primitives
 */
export async function hkdfExpand(hashAlg, prk, info, length) {
    // Determine hash length directly from WebCrypto by hashing an empty string
    const webAlg = getWebCryptoHashName(hashAlg);
    const hashDump = await globalThis.crypto.subtle.digest(webAlg, new Uint8Array(0));
    const hashLen = hashDump.byteLength;
    
    const n = Math.ceil(length / hashLen);
    const blockList = [];
    let t = new Uint8Array(0);
    
    for (let i = 1; i <= n; i++) {
        // HMAC(prk, t + info + [i])
        const iBuf = new Uint8Array([i]);
        t = await computeHmac(hashAlg, prk, [t, info, iBuf]);
        blockList.push(t);
    }
    
    return concatUint8Arrays(blockList).subarray(0, length);
}

/**
 * TLS 1.2 PRF implementation (RFC 5246)
 */
async function pHash(hashAlg, secret, seed, length) {
    const webAlg = getWebCryptoHashName(hashAlg);
    const hashDump = await globalThis.crypto.subtle.digest(webAlg, new Uint8Array(0));
    const hashLen = hashDump.byteLength;
    
    const blockList = [];
    let currentA = seed;

    while (blockList.length * hashLen < length) {
        // A(i) = HMAC(secret, A(i-1))
        currentA = await computeHmac(hashAlg, secret, [currentA]);
        
        // HMAC(secret, A(i) + seed)
        const hmacBlock = await computeHmac(hashAlg, secret, [currentA, seed]);
        blockList.push(hmacBlock);
    }

    return concatUint8Arrays(blockList).subarray(0, length);
}

export async function prfTls12(secret, labelStr, seedBuf, hashAlg, length) {
    const encoder = new TextEncoder();
    const labelBuf = encoder.encode(labelStr); // TLS labels are ASCII which matches UTF8 natively
    const seed = concatUint8Arrays([labelBuf, seedBuf]);
    return await pHash(hashAlg, secret, seed, length);
}
