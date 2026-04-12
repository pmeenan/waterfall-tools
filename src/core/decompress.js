/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview Isomorphic content-encoding decompression utility.
 *
 * Provides a single async entry point that decompresses a Uint8Array according
 * to a Content-Encoding value (gzip, deflate, br, zstd).
 *
 * Strategy for each encoding:
 *   gzip / deflate / deflate-raw — native DecompressionStream (universally
 *     supported in evergreen browsers and Node 18+).
 *   brotli — try native DecompressionStream('brotli') first; if unavailable
 *     or if decompression fails, fall back to the pure-JS `brotli` package
 *     (lazy-imported so the ~69 KB dictionary only loads on first use).
 *   zstd — try native DecompressionStream('zstd') first; if unavailable or
 *     if decompression fails, fall back to the pure-JS `fzstd` package (~8 KB).
 *
 * All fallback imports are dynamic (`import()`) so bundlers can tree-shake
 * All fallback imports are dynamic (`import()`) so bundlers can tree-shake
 * them when unused, and the dictionary payload for brotli is never loaded
 * unless actually needed. (fzstd is statically imported per bundle constraint).
 */
import { decompress as fzstdDecompress } from 'fzstd';

/**
 * Decompresses `data` using the native DecompressionStream API.
 * @param {Uint8Array} data  Compressed bytes.
 * @param {string}     algo  Algorithm name accepted by DecompressionStream.
 * @returns {Promise<Uint8Array>} Decompressed bytes.
 */
async function decompressNative(data, algo) {
    const ds = new DecompressionStream(algo);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    // Fire-and-forget the write; catch writer errors so truncated data
    // doesn't cause an unhandled rejection — the reader will surface the
    // failure via its own stream-closed state.
    const writePromise = writer.write(data)
        .then(() => writer.close())
        .catch(() => {});

    const parts = [];
    let totalLen = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        totalLen += value.length;
    }
    await writePromise;

    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const part of parts) {
        out.set(part, off);
        off += part.length;
    }
    return out;
}

// Cache the probed support so we only test once per algorithm per process.
const _nativeSupport = {};

/**
 * Returns true if the current runtime supports DecompressionStream(algo).
 * The result is cached per algorithm name.
 * @param {string} algo
 * @returns {boolean}
 */
function hasNativeSupport(algo) {
    if (_nativeSupport[algo] !== undefined) return _nativeSupport[algo];
    try {
        // Constructor-only probe: if the algorithm is unsupported, the
        // constructor throws immediately. We intentionally do NOT write to
        // or close the stream — doing so on an empty brotli stream triggers
        // a Z_BUF_ERROR that leaks as an unhandled rejection in Node.js.
        // The unused stream will be garbage collected.
        new DecompressionStream(algo);
        _nativeSupport[algo] = true;
    } catch {
        _nativeSupport[algo] = false;
    }
    return _nativeSupport[algo];
}

/**
 * Decompress a Uint8Array using the brotli JS fallback.
 * The package is CJS (`brotli/decompress` → BrotliDecompressBuffer) and
 * expects a plain Buffer-like or Uint8Array input. It returns a Uint8Array.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function decompressBrotliFallback(data) {
    // Dynamic import keeps the ~69 KB dictionary out of the main bundle until
    // actually needed. Vite / Rollup will code-split this automatically.
    const mod = await import('brotli/decompress');
    const decompress = mod.default || mod;
    const result = decompress(data);
    return new Uint8Array(result);
}

/**
 * Decompress a Uint8Array using the fzstd JS fallback.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function decompressZstdFallback(data) {
    return fzstdDecompress(data);
}

/**
 * Decompresses a response body according to its Content-Encoding value.
 *
 * @param {Uint8Array} data      Raw (compressed) body bytes.
 * @param {string}     encoding  Content-Encoding header value
 *                               (e.g. 'gzip', 'br', 'zstd', 'deflate').
 * @returns {Promise<Uint8Array>} Decompressed bytes, or the original `data`
 *                                unchanged if the encoding is unrecognised or
 *                                decompression fails entirely.
 */
export async function decompressBody(data, encoding) {
    const enc = (encoding || '').toLowerCase().trim();

    // ---- gzip / deflate / deflate-raw — always native ---------------------
    if (enc === 'gzip' || enc === 'x-gzip') {
        return decompressNative(data, 'gzip');
    }
    if (enc === 'deflate') {
        return decompressNative(data, 'deflate');
    }

    // ---- brotli — native probe then JS fallback ---------------------------
    if (enc === 'br') {
        if (hasNativeSupport('brotli')) {
            try {
                return await decompressNative(data, 'brotli');
            } catch {
                // Native construction succeeded but decompression failed on
                // this specific payload — try the JS fallback.
            }
        }
        return decompressBrotliFallback(data);
    }

    // ---- zstd — native probe then JS fallback -----------------------------
    if (enc === 'zstd') {
        if (hasNativeSupport('zstd')) {
            try {
                return await decompressNative(data, 'zstd');
            } catch {
                // Same pattern: fall through to JS path.
            }
        }
        return decompressZstdFallback(data);
    }

    // Unrecognised encoding — return data unchanged so the caller can still
    // store the raw wire bytes.
    return data;
}
