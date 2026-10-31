/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview Shared streaming-progress helpers for the input parsers.
 *
 * `options.totalBytes` (injected by `loadBuffer()`) is the size of the *raw* input, so
 * progress has to be measured on the raw byte stream — before any gzip
 * `DecompressionStream` and before `TextDecoderStream` turns bytes into UTF-16 chars.
 * Counting decoded chars against the compressed size used to push gz inputs far past
 * 100%. Isomorphic: Web Streams only.
 */

/**
 * Pipe `stream` through a pass-through TransformStream that tallies raw bytes into
 * `counter.bytes`. Chunks are forwarded unchanged (no copies).
 *
 * @param {ReadableStream} stream
 * @param {{bytes: number}} counter - mutated in place
 * @returns {ReadableStream}
 */
export function countRawBytes(stream, counter) {
    return stream.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (chunk) counter.bytes += (chunk.byteLength !== undefined ? chunk.byteLength : chunk.length) || 0;
            controller.enqueue(chunk);
        }
    }));
}

/**
 * Percentage of `scale` represented by `done / total`, clamped to `[0, scale]`. Returns
 * 0 when `total` is unknown so callers can report unconditionally.
 *
 * @param {number} done
 * @param {number} total
 * @param {number} scale - upper bound of this phase (e.g. 80 for "parsing = 0-80%")
 * @returns {number}
 */
export function scaledProgress(done, total, scale) {
    if (!(total > 0) || !(done > 0)) return 0;
    return Math.min(scale, Math.round((done / total) * scale));
}
