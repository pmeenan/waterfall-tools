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
import { decompress as fzstdDecompress, Decompress as FzstdDecompress } from 'fzstd';

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
 * Maps a Content-Encoding header value to the DecompressionStream format name.
 * Returns null for unrecognised encodings or ones that DecompressionStream
 * does not natively support on the current runtime (so callers can fall back).
 * @param {string} encoding
 * @returns {string|null}
 */
function toStreamFormat(encoding) {
    const enc = (encoding || '').toLowerCase().trim();
    if (enc === 'gzip' || enc === 'x-gzip') return 'gzip';
    if (enc === 'deflate') return 'deflate';
    if (enc === 'br') return 'brotli';
    if (enc === 'zstd') return 'zstd';
    return null;
}

/**
 * Decompresses a sequence of wire chunks incrementally, reporting per-chunk
 * uncompressed byte counts alongside the fully decompressed body.
 *
 * Each wire chunk is fed into a streaming decoder one at a time. The number
 * of decompressed bytes emitted in response to each write is attributed to
 * that wire chunk. This mirrors what a real decompressor does at the byte
 * level — most of the output may be emitted on the final chunks because the
 * decoder buffers internally until it has enough input to produce output.
 *
 * Streaming paths per encoding:
 *   - gzip / deflate — DecompressionStream (native everywhere).
 *   - brotli         — DecompressionStream when natively supported
 *                      (Node 22+, modern browsers). Pure-JS `brotli` fallback
 *                      does NOT support streaming — returns null in that case.
 *   - zstd           — DecompressionStream when natively supported, otherwise
 *                      fzstd streaming (`new fzstd.Decompress(...)` with
 *                      synchronous `push(chunk, isLast)` callbacks).
 *
 * Any decoder failure (malformed input, mid-stream error, or an encoding
 * without a streaming path) returns null so callers can decide whether to
 * fall back to a one-shot `decompressBody` for the body alone. We intentionally
 * never produce approximate per-chunk sizes — missing data is better than wrong
 * data for visualisations that slice the decoded body by chunk time.
 *
 * @param {Uint8Array[]} wireChunks  Ordered wire chunks (compressed bytes) as
 *                                   delivered on the network. Empty chunks are
 *                                   permitted but contribute 0 to their slot.
 * @param {string}       encoding    Content-Encoding header value.
 * @returns {Promise<{bytes: Uint8Array, perChunkInflated: number[]}|null>}
 *          On success: the full decompressed body plus a per-chunk array of
 *          uncompressed byte counts aligned 1:1 with `wireChunks` (sum equals
 *          `bytes.length`). On failure or unsupported streaming: null.
 */
export async function decompressBodyPerChunk(wireChunks, encoding) {
    if (!Array.isArray(wireChunks) || wireChunks.length === 0) return null;

    const fmt = toStreamFormat(encoding);
    if (!fmt) return null;

    // --- Native DecompressionStream path (gzip / deflate / brotli / zstd) ---
    if (hasNativeSupport(fmt)) {
        try {
            return await decompressStreamPerChunk(wireChunks, fmt);
        } catch {
            // Fall through for zstd-only: try fzstd. For gzip/deflate/brotli
            // there is no JS streaming fallback, so this becomes a null return.
            if (fmt !== 'zstd') return null;
        }
    }

    // --- zstd JS streaming fallback via fzstd ---------------------------------
    if (fmt === 'zstd') {
        try {
            return decompressZstdStreamPerChunk(wireChunks);
        } catch {
            return null;
        }
    }

    // brotli with no native support has no streaming JS fallback.
    return null;
}

/**
 * Per-chunk streaming decompression via DecompressionStream. Runs a parallel
 * read drain so decompressed output pushed by the zlib/brotli/zstd transform
 * is observed between successive writes. After each `await writer.write(chunk)`
 * we yield once to the macrotask queue (`setTimeout(0)`) so all pending
 * microtasks — including `reader.read()` resolutions — have drained before we
 * sample the cumulative output counter.
 */
async function decompressStreamPerChunk(wireChunks, fmt) {
    const ds = new DecompressionStream(fmt);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    const outputParts = [];
    let cumOutput = 0;

    const drainPromise = (async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                outputParts.push(value);
                cumOutput += value.length;
            }
        } catch {
            // Swallow reader errors — they surface as write-side rejections
            // caught below. Leaving this un-handled would leak as an unhandled
            // promise rejection when the stream enters its error state.
        }
    })();

    const perChunkInflated = new Array(wireChunks.length).fill(0);

    try {
        for (let i = 0; i < wireChunks.length; i++) {
            const bytes = wireChunks[i];
            if (!bytes || bytes.length === 0) continue;
            const before = cumOutput;
            await writer.write(bytes);
            // Yield to the event loop so the parallel drain picks up output
            // emitted by this write (microtasks drain before the macrotask fires).
            await new Promise(r => setTimeout(r, 0));
            perChunkInflated[i] = cumOutput - before;
        }
        await writer.close();
    } catch (e) {
        try { await writer.abort(e); } catch {}
        try { await drainPromise; } catch {}
        throw e;
    }

    await drainPromise;

    // Any trailing output emitted during close() (e.g. the final flush of
    // a block-based decoder) gets attributed to the last non-empty wire chunk.
    const sumAssigned = perChunkInflated.reduce((a, b) => a + b, 0);
    if (cumOutput > sumAssigned) {
        for (let i = wireChunks.length - 1; i >= 0; i--) {
            if (wireChunks[i] && wireChunks[i].length > 0) {
                perChunkInflated[i] += (cumOutput - sumAssigned);
                break;
            }
        }
    }

    const bytes = new Uint8Array(cumOutput);
    let off = 0;
    for (const part of outputParts) {
        bytes.set(part, off);
        off += part.length;
    }

    return { bytes, perChunkInflated };
}

/**
 * Per-chunk streaming zstd decompression via fzstd. fzstd's Decompress class
 * invokes its `ondata` callback synchronously from within each `push()` call,
 * so attribution to the currently-pushed wire chunk is exact without any yield
 * dance — a nice property relative to the DecompressionStream path.
 */
function decompressZstdStreamPerChunk(wireChunks) {
    const perChunkInflated = new Array(wireChunks.length).fill(0);
    const outputParts = [];
    let cumOutput = 0;
    let currentIdx = 0;

    const stream = new FzstdDecompress((out) => {
        perChunkInflated[currentIdx] += out.length;
        outputParts.push(out);
        cumOutput += out.length;
    });

    // Find the last non-empty chunk index to mark `isLast` correctly.
    let lastNonEmpty = -1;
    for (let i = wireChunks.length - 1; i >= 0; i--) {
        if (wireChunks[i] && wireChunks[i].length > 0) { lastNonEmpty = i; break; }
    }

    for (let i = 0; i < wireChunks.length; i++) {
        const bytes = wireChunks[i];
        if (!bytes || bytes.length === 0) continue;
        currentIdx = i;
        stream.push(bytes, i === lastNonEmpty);
    }

    const bytes = new Uint8Array(cumOutput);
    let off = 0;
    for (const part of outputParts) {
        bytes.set(part, off);
        off += part.length;
    }

    return { bytes, perChunkInflated };
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
