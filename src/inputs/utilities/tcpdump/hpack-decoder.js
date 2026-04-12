/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview Pure browser-native HPACK decoder (RFC 7541) for HTTP/2 header decompression.
 * Operates entirely on Uint8Array — zero Node.js Buffer dependency.
 *
 * Replaces the third-party `hpack.js` library which depends on Node Duplex streams
 * and Buffer, making it incompatible with browser environments without polyfills.
 *
 * Uses the same RFC 7541 Huffman encoding table already present in qpack-decoder.js
 * (HPACK and QPACK share the identical Huffman code table from RFC 7541 Appendix B).
 */

// ─── HPACK Static Table (RFC 7541 Appendix A) ───────────────────────────────
// Index 0 is unused. Indices 1–61 are the predefined header fields.
const STATIC_TABLE = [
    null, // 0: unused
    { name: ':authority', value: '' },
    { name: ':method', value: 'GET' },
    { name: ':method', value: 'POST' },
    { name: ':path', value: '/' },
    { name: ':path', value: '/index.html' },
    { name: ':scheme', value: 'http' },
    { name: ':scheme', value: 'https' },
    { name: ':status', value: '200' },
    { name: ':status', value: '204' },
    { name: ':status', value: '206' },
    { name: ':status', value: '304' },
    { name: ':status', value: '400' },
    { name: ':status', value: '404' },
    { name: ':status', value: '500' },
    { name: 'accept-charset', value: '' },
    { name: 'accept-encoding', value: 'gzip, deflate' },
    { name: 'accept-language', value: '' },
    { name: 'accept-ranges', value: '' },
    { name: 'accept', value: '' },
    { name: 'access-control-allow-origin', value: '' },
    { name: 'age', value: '' },
    { name: 'allow', value: '' },
    { name: 'authorization', value: '' },
    { name: 'cache-control', value: '' },
    { name: 'content-disposition', value: '' },
    { name: 'content-encoding', value: '' },
    { name: 'content-language', value: '' },
    { name: 'content-length', value: '' },
    { name: 'content-location', value: '' },
    { name: 'content-range', value: '' },
    { name: 'content-type', value: '' },
    { name: 'cookie', value: '' },
    { name: 'date', value: '' },
    { name: 'etag', value: '' },
    { name: 'expect', value: '' },
    { name: 'expires', value: '' },
    { name: 'from', value: '' },
    { name: 'host', value: '' },
    { name: 'if-match', value: '' },
    { name: 'if-modified-since', value: '' },
    { name: 'if-none-match', value: '' },
    { name: 'if-range', value: '' },
    { name: 'if-unmodified-since', value: '' },
    { name: 'last-modified', value: '' },
    { name: 'link', value: '' },
    { name: 'location', value: '' },
    { name: 'max-forwards', value: '' },
    { name: 'proxy-authenticate', value: '' },
    { name: 'proxy-authorization', value: '' },
    { name: 'range', value: '' },
    { name: 'referer', value: '' },
    { name: 'refresh', value: '' },
    { name: 'retry-after', value: '' },
    { name: 'server', value: '' },
    { name: 'set-cookie', value: '' },
    { name: 'strict-transport-security', value: '' },
    { name: 'transfer-encoding', value: '' },
    { name: 'user-agent', value: '' },
    { name: 'vary', value: '' },
    { name: 'via', value: '' },
    { name: 'www-authenticate', value: '' }
];

// ─── RFC 7541 Huffman Encoding Table (Appendix B) ───────────────────────────
// Identical to the table used in qpack-decoder.js. Each entry is [bitLength, code].
// Symbol 256 is EOS.
const ENCODE_TABLE = [
    [13,8184],[23,8388568],[28,268435426],[28,268435427],[28,268435428],[28,268435429],
    [28,268435430],[28,268435431],[28,268435432],[24,16777194],[30,1073741820],[28,268435433],
    [28,268435434],[30,1073741821],[28,268435435],[28,268435436],[28,268435437],[28,268435438],
    [28,268435439],[28,268435440],[28,268435441],[28,268435442],[30,1073741822],[28,268435443],
    [28,268435444],[28,268435445],[28,268435446],[28,268435447],[28,268435448],[28,268435449],
    [28,268435450],[28,268435451],[6,20],[10,1016],[10,1017],[12,4090],[13,8185],[6,21],[8,248],
    [11,2042],[10,1018],[10,1019],[8,249],[11,2043],[8,250],[6,22],[6,23],[6,24],[5,0],[5,1],
    [5,2],[6,25],[6,26],[6,27],[6,28],[6,29],[6,30],[6,31],[7,92],[8,251],[15,32764],[6,32],
    [12,4091],[10,1020],[13,8186],[6,33],[7,93],[7,94],[7,95],[7,96],[7,97],[7,98],[7,99],
    [7,100],[7,101],[7,102],[7,103],[7,104],[7,105],[7,106],[7,107],[7,108],[7,109],[7,110],
    [7,111],[7,112],[7,113],[7,114],[8,252],[7,115],[8,253],[13,8187],[19,524272],[13,8188],
    [14,16380],[6,34],[15,32765],[5,3],[6,35],[5,4],[6,36],[5,5],[6,37],[6,38],[6,39],[5,6],
    [7,116],[7,117],[6,40],[6,41],[6,42],[5,7],[6,43],[7,118],[6,44],[5,8],[5,9],[6,45],
    [7,119],[7,120],[7,121],[7,122],[7,123],[15,32766],[11,2044],[14,16381],[13,8189],
    [28,268435452],[20,1048550],[22,4194258],[20,1048551],[20,1048552],[22,4194259],
    [22,4194260],[22,4194261],[23,8388569],[22,4194262],[23,8388570],[23,8388571],
    [23,8388572],[23,8388573],[23,8388574],[24,16777195],[23,8388575],[24,16777196],
    [24,16777197],[22,4194263],[23,8388576],[24,16777198],[23,8388577],[23,8388578],
    [23,8388579],[23,8388580],[21,2097116],[22,4194264],[23,8388581],[22,4194265],
    [23,8388582],[23,8388583],[24,16777199],[22,4194266],[21,2097117],[20,1048553],
    [22,4194267],[22,4194268],[23,8388584],[23,8388585],[21,2097118],[23,8388586],
    [22,4194269],[22,4194270],[24,16777200],[21,2097119],[22,4194271],[23,8388587],
    [23,8388588],[21,2097120],[21,2097121],[22,4194272],[21,2097122],[23,8388589],
    [22,4194273],[23,8388590],[23,8388591],[20,1048554],[22,4194274],[22,4194275],
    [22,4194276],[23,8388592],[22,4194277],[22,4194278],[23,8388593],[26,67108832],
    [26,67108833],[20,1048555],[19,524273],[22,4194279],[23,8388594],[22,4194280],
    [25,33554412],[26,67108834],[26,67108835],[26,67108836],[27,134217694],[27,134217695],
    [26,67108837],[24,16777201],[25,33554413],[19,524274],[21,2097123],[26,67108838],
    [27,134217696],[27,134217697],[26,67108839],[27,134217698],[24,16777202],[21,2097124],
    [21,2097125],[26,67108840],[26,67108841],[28,268435453],[27,134217699],[27,134217700],
    [27,134217701],[20,1048556],[24,16777203],[20,1048557],[21,2097126],[22,4194281],
    [21,2097127],[21,2097128],[23,8388595],[22,4194282],[22,4194283],[25,33554414],
    [25,33554415],[24,16777204],[24,16777205],[26,67108842],[23,8388596],[26,67108843],
    [27,134217702],[26,67108844],[26,67108845],[27,134217703],[27,134217704],[27,134217705],
    [27,134217706],[27,134217707],[28,268435454],[27,134217708],[27,134217709],[27,134217710],
    [27,134217711],[27,134217712],[26,67108846],[30,1073741823]
];

// ─── Build Huffman decoding tree at module load time ─────────────────────────
class HuffmanNode {
    constructor() {
        this.children = []; // [0] = left, [1] = right
        this.symbol = -1;   // -1 if non-leaf
    }
}

const huffRoot = new HuffmanNode();
for (let i = 0; i < ENCODE_TABLE.length; i++) {
    const [bits, code] = ENCODE_TABLE[i];
    let node = huffRoot;
    for (let b = bits - 1; b >= 0; b--) {
        const bit = (code >>> b) & 1;
        if (!node.children[bit]) node.children[bit] = new HuffmanNode();
        node = node.children[bit];
    }
    node.symbol = i;
}

/**
 * Decodes a Huffman-encoded Uint8Array to a UTF-8 string per RFC 7541 Appendix B.
 * @param {Uint8Array} buffer
 * @returns {string}
 */
function decodeHuffman(buffer) {
    let node = huffRoot;
    const decoded = [];
    for (let i = 0; i < buffer.length; i++) {
        const b = buffer[i];
        for (let bit = 7; bit >= 0; bit--) {
            const val = (b >>> bit) & 1;
            node = node.children[val];
            if (!node) return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(decoded));
            if (node.symbol !== -1) {
                if (node.symbol === 256) break; // EOS
                decoded.push(node.symbol);
                node = huffRoot;
            }
        }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(decoded));
}

// ─── HPACK Integer Decoding (RFC 7541 Section 5.1) ──────────────────────────
/**
 * Decodes an HPACK integer starting at `offset` in `buffer`.
 * The integer uses `prefixBits` bits of the first byte (masked by `firstByteMask`).
 * Returns { value, newOffset } or null if truncated.
 *
 * @param {Uint8Array} buffer
 * @param {number} offset
 * @param {number} prefixBits - Number of prefix bits (1-8)
 * @param {number} firstByteMask - Bitmask for the prefix bits
 * @returns {{ value: number, newOffset: number }|null}
 */
function readInt(buffer, offset, prefixBits, firstByteMask) {
    if (offset >= buffer.length) return null;
    let v = buffer[offset] & firstByteMask;
    const maxPrefix = (1 << prefixBits) - 1;

    if (v < maxPrefix) {
        return { value: v, newOffset: offset + 1 };
    }

    let m = 0;
    let p = offset + 1;

    while (p < buffer.length) {
        const b = buffer[p++];
        v += (b & 0x7F) << m;
        m += 7;
        if ((b & 0x80) === 0) {
            return { value: v, newOffset: p };
        }
    }
    return null; // truncated
}

// ─── HPACK String Decoding (RFC 7541 Section 5.2) ───────────────────────────
/**
 * Decodes an HPACK string literal starting at `offset`.
 * The high bit of the first byte (bit 7) indicates Huffman encoding.
 * The remaining 7 bits encode the string length as an integer with 7-bit prefix.
 *
 * @param {Uint8Array} buffer
 * @param {number} offset
 * @returns {{ value: string, newOffset: number }|null}
 */
function readString(buffer, offset) {
    if (offset >= buffer.length) return null;
    const isHuffman = (buffer[offset] & 0x80) !== 0;
    const lenRes = readInt(buffer, offset, 7, 0x7F);
    if (!lenRes) return null;

    const len = lenRes.value;
    const strStart = lenRes.newOffset;
    if (strStart + len > buffer.length) return null;

    const raw = buffer.subarray(strStart, strStart + len);

    let str;
    if (isHuffman) {
        try {
            str = decodeHuffman(raw);
        } catch (e) {
            // Graceful fallback for malformed Huffman data
            str = new TextDecoder('utf-8', { fatal: false }).decode(raw);
        }
    } else {
        str = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    }

    return { value: str, newOffset: strStart + len };
}

// ─── HPACK Decoder (RFC 7541) ────────────────────────────────────────────────
/**
 * Stateful HPACK header decompressor.
 * Maintains a dynamic table and decodes header block fragments from HTTP/2 frames.
 *
 * Usage:
 *   const decoder = new HpackDecoder();
 *   const headers = decoder.decode(headerBlockFragment); // returns [{name, value}]
 *
 * Each call to decode() processes one header block and returns the decoded headers.
 * The dynamic table state persists across calls (as required by HTTP/2 — one
 * decoder per connection direction).
 */
export class HpackDecoder {
    constructor(options = {}) {
        this.dynamicTable = [];
        this.maxTableSize = options.maxSize || 4096;
        this.currentTableSize = 0;
    }

    /**
     * Looks up a header by its 1-based HPACK index.
     * Indices 1–61 map to the static table; indices >= 62 map to the dynamic table.
     *
     * @param {number} index - 1-based HPACK index
     * @returns {{ name: string, value: string }|null}
     */
    _lookup(index) {
        if (index <= 0) return null;
        if (index < STATIC_TABLE.length) {
            return STATIC_TABLE[index];
        }
        // Dynamic table is a LIFO stack — most recently inserted entry is index 62
        const dynamicIndex = index - STATIC_TABLE.length;
        if (dynamicIndex < this.dynamicTable.length) {
            return this.dynamicTable[dynamicIndex];
        }
        return null;
    }

    /**
     * Inserts a header into the dynamic table, evicting entries as needed
     * to stay within the max table size (RFC 7541 Section 4.4).
     *
     * Each entry's size is defined as: name.length + value.length + 32
     *
     * @param {string} name
     * @param {string} value
     */
    _insert(name, value) {
        const entrySize = name.length + value.length + 32;

        // Evict entries from the end (oldest) until the new entry fits
        while (this.currentTableSize + entrySize > this.maxTableSize && this.dynamicTable.length > 0) {
            const evicted = this.dynamicTable.pop();
            this.currentTableSize -= (evicted.name.length + evicted.value.length + 32);
        }

        // If the entry itself is larger than the table, just clear the table
        if (entrySize > this.maxTableSize) {
            this.dynamicTable = [];
            this.currentTableSize = 0;
            return;
        }

        // Insert at the front (newest entry = lowest dynamic index)
        this.dynamicTable.unshift({ name, value });
        this.currentTableSize += entrySize;
    }

    /**
     * Decodes a complete header block fragment (Uint8Array) into an array of
     * { name, value } header pairs.
     *
     * Implements all four HPACK header field representations:
     *   - Indexed Header Field (Section 6.1)
     *   - Literal Header Field with Incremental Indexing (Section 6.2.1)
     *   - Literal Header Field without Indexing (Section 6.2.2)
     *   - Literal Header Field Never Indexed (Section 6.2.3)
     *   - Dynamic Table Size Update (Section 6.3)
     *
     * @param {Uint8Array} buffer - Header block fragment
     * @returns {Array<{ name: string, value: string }>}
     */
    decode(buffer) {
        const headers = [];
        let offset = 0;

        while (offset < buffer.length) {
            const b = buffer[offset];

            if (b & 0x80) {
                // ── Indexed Header Field (Section 6.1) ──
                // Pattern: 1xxxxxxx  — 7-bit prefix index
                const res = readInt(buffer, offset, 7, 0x7F);
                if (!res) break;
                offset = res.newOffset;

                const entry = this._lookup(res.value);
                if (entry) {
                    headers.push({ name: entry.name, value: entry.value });
                }

            } else if ((b & 0xC0) === 0x40) {
                // ── Literal Header Field with Incremental Indexing (Section 6.2.1) ──
                // Pattern: 01xxxxxx  — 6-bit prefix index (0 = new name)
                const idxRes = readInt(buffer, offset, 6, 0x3F);
                if (!idxRes) break;
                offset = idxRes.newOffset;

                let name;
                if (idxRes.value === 0) {
                    // New name
                    const nameRes = readString(buffer, offset);
                    if (!nameRes) break;
                    name = nameRes.value;
                    offset = nameRes.newOffset;
                } else {
                    const entry = this._lookup(idxRes.value);
                    name = entry ? entry.name : 'unknown';
                }

                const valRes = readString(buffer, offset);
                if (!valRes) break;
                offset = valRes.newOffset;

                headers.push({ name, value: valRes.value });
                this._insert(name, valRes.value);

            } else if ((b & 0xF0) === 0x00 || (b & 0xF0) === 0x10) {
                // ── Literal Header Field without Indexing (Section 6.2.2) ──
                // Pattern: 0000xxxx  — 4-bit prefix index
                // ── Literal Header Field Never Indexed (Section 6.2.3) ──
                // Pattern: 0001xxxx  — 4-bit prefix index
                // Both are decoded the same way; they differ only in caching semantics
                // which are irrelevant for offline analysis.
                const idxRes = readInt(buffer, offset, 4, 0x0F);
                if (!idxRes) break;
                offset = idxRes.newOffset;

                let name;
                if (idxRes.value === 0) {
                    const nameRes = readString(buffer, offset);
                    if (!nameRes) break;
                    name = nameRes.value;
                    offset = nameRes.newOffset;
                } else {
                    const entry = this._lookup(idxRes.value);
                    name = entry ? entry.name : 'unknown';
                }

                const valRes = readString(buffer, offset);
                if (!valRes) break;
                offset = valRes.newOffset;

                headers.push({ name, value: valRes.value });
                // Not added to dynamic table

            } else if ((b & 0xE0) === 0x20) {
                // ── Dynamic Table Size Update (Section 6.3) ──
                // Pattern: 001xxxxx  — 5-bit prefix for new max size
                const sizeRes = readInt(buffer, offset, 5, 0x1F);
                if (!sizeRes) break;
                offset = sizeRes.newOffset;

                this.maxTableSize = sizeRes.value;
                // Evict entries exceeding the new max
                while (this.currentTableSize > this.maxTableSize && this.dynamicTable.length > 0) {
                    const evicted = this.dynamicTable.pop();
                    this.currentTableSize -= (evicted.name.length + evicted.value.length + 32);
                }

            } else {
                // Unknown representation — skip byte to prevent infinite loops
                offset++;
            }
        }

        return headers;
    }
}
