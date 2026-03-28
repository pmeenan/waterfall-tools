/**
 * QPACK Decoder Primitive
 * Barebones HTTP/3 Stream frame parser.
 */
export function decodeHttp3Stream(decryptedPayload) {
    if (!decryptedPayload) return null;

    // Search stream natively for HTTP strings.
    // Full QPACK involves Static Tables, Dynamic Tables and Huffman decoding.
    // For pure extraction of pseudo-headers in 0-dependency offline parsing,
    // we attempt to yank plaintext URLs if Huffman compression isn't engaged.
    const raw = decryptedPayload.toString('utf8');

    let method = null;
    let url = null;
    let status = null;

    if (raw.includes('GET ')) method = 'GET';
    else if (raw.includes('POST ')) method = 'POST';

    // Heuristics for URL sniffing inside literal frames
    const match = raw.match(/(https?:\/\/[^\s\x00-\x1F]+)/);
    if (match) url = match[1];

    if (raw.includes('200 OK')) status = 200;

    return { method, url, status, byteLength: decryptedPayload.length };
}
