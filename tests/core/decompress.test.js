/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { decompressBody } from '../../src/core/decompress.js';

/**
 * Test fixtures: the string "Hello, World! This is a test of content-encoding
 * decompression.\n" compressed with each algorithm, base64-encoded.
 */
const PLAIN_TEXT = 'Hello, World! This is a test of content-encoding decompression.\n';

const GZIP_B64 =
    'H4sICD3h2mkAA3Rlc3QtYm9keS50eHQADcLBCYBADATAv1Wsf7UOCxB8SxI1cGblkv7RYVZr' +
    'jRN29qYjttsT/wNlWeAJYZRFzRZC9bigJnzebpnOWIYP2XgIlUAAAAA=';

const BROTLI_B64 =
    'ofgBAG2kTB3fWgEkjEyHtLiUAYccOHxpbWcKNuDIw2BJ5sYqBdAQb0YSgXUF/gUY';

const ZSTD_B64 =
    'KLUv/SRA1QEAAoQNE6CrAwZ+5FzRklRUg6vuJ5FfFysAcTdEp4Z5+VQ5O6/zkOe8V5M30Vmk' +
    'aEVbjAYHpR8VjpCLAABGtoo=';

/** Decode a base64 string into a Uint8Array. */
function b64ToUint8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Decode a Uint8Array to a UTF-8 string. */
function uint8ToStr(arr) {
    return new TextDecoder().decode(arr);
}

describe('decompressBody', () => {

    it('decompresses gzip content-encoding', async () => {
        const result = await decompressBody(b64ToUint8(GZIP_B64), 'gzip');
        expect(uint8ToStr(result)).toBe(PLAIN_TEXT);
    });

    it('decompresses gzip with x-gzip alias', async () => {
        const result = await decompressBody(b64ToUint8(GZIP_B64), 'x-gzip');
        expect(uint8ToStr(result)).toBe(PLAIN_TEXT);
    });

    it('decompresses brotli (br) content-encoding', async () => {
        const result = await decompressBody(b64ToUint8(BROTLI_B64), 'br');
        expect(uint8ToStr(result)).toBe(PLAIN_TEXT);
    });

    it('decompresses zstd content-encoding', async () => {
        const result = await decompressBody(b64ToUint8(ZSTD_B64), 'zstd');
        expect(uint8ToStr(result)).toBe(PLAIN_TEXT);
    });

    it('handles case-insensitive encoding values', async () => {
        const result = await decompressBody(b64ToUint8(BROTLI_B64), '  BR  ');
        expect(uint8ToStr(result)).toBe(PLAIN_TEXT);
    });

    it('returns data unchanged for unrecognised encoding', async () => {
        const raw = new Uint8Array([1, 2, 3, 4]);
        const result = await decompressBody(raw, 'identity');
        expect(result).toEqual(raw);
    });

    it('returns data unchanged for empty encoding', async () => {
        const raw = new Uint8Array([10, 20, 30]);
        const result = await decompressBody(raw, '');
        expect(result).toEqual(raw);
    });
});
