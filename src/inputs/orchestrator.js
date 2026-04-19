/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processHARFileNode } from './har.js';
import { processWPTFileNode } from './wpt-json.js';
import { processCDPFileNode } from './cdp.js';
import { processChromeTraceFileNode } from './chrome-trace.js';
import { processNetlogFileNode } from './netlog.js';

import { processWptagentZip } from './wptagent.js';
import { processPerfettoFileNode } from './perfetto.js';
import { decompressBody, decompressBodyPerChunk } from '../core/decompress.js';
import { sniffMimeType } from '../core/har-converter.js';

export const parsers = {
    'har': processHARFileNode,
    'wpt': processWPTFileNode,
    'cdp': processCDPFileNode,
    'chrome-trace': processChromeTraceFileNode,
    'perfetto': processPerfettoFileNode,
    'netlog': processNetlogFileNode,
    'tcpdump': async (input, options) => {
        try {
            const module = await import('./tcpdump.js');
            if (!options.deps) options.deps = {};
            options.deps.decompressBody = decompressBody;
            options.deps.decompressBodyPerChunk = decompressBodyPerChunk;
            options.deps.sniffMimeType = sniffMimeType;
            return await module.processTcpdumpNode(input, options);
        } catch (e) {
            console.warn('TCPDump parser not included or failed to dynamically load:', e);
            throw new Error('TCPDump decoding support is missing or not packaged in this build.', { cause: e });
        }
    },
    'wptagent': processWptagentZip
};

function isGzip(buf) {
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Converts any input (ArrayBuffer, Uint8Array, or Node Buffer) to a plain Uint8Array.
 * This ensures all downstream logic works isomorphically without Node-specific Buffer methods.
 * @param {ArrayBuffer|Uint8Array|Buffer} input
 * @returns {Uint8Array}
 */
function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    // Fallback: convert from any array-like with .buffer (covers Node Buffer)
    if (input && input.buffer instanceof ArrayBuffer) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return new Uint8Array(input);
}

/**
 * Reads a 32-bit big-endian unsigned integer from a Uint8Array at the given offset.
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function readUint32BE(buf, offset) {
    return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

/**
 * Reads a 32-bit little-endian unsigned integer from a Uint8Array at the given offset.
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function readUint32LE(buf, offset) {
    return ((buf[offset + 3] << 24) | (buf[offset + 2] << 16) | (buf[offset + 1] << 8) | buf[offset]) >>> 0;
}

/**
 * Concatenates multiple Uint8Array chunks into a single Uint8Array.
 * @param {Uint8Array[]} arrays
 * @returns {Uint8Array}
 */
function concatUint8Arrays(arrays) {
    let totalLen = 0;
    for (const a of arrays) totalLen += a.length;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const a of arrays) {
        result.set(a, offset);
        offset += a.length;
    }
    return result;
}

/**
 * Distinctive wptagent member filenames. A valid wptagent bundle's first
 * 64KB is expected to contain at least one of these substrings (they appear
 * inside the zip's local file headers). Keep in sync with the list in
 * cloudflare-worker/worker.js.
 */
const WPTAGENT_FILENAME_TOKENS = [
    'testinfo.json',
    'testinfo.ini',
    'video_1/ms_',
    'video_1_cached/ms_',
    '_devtools_requests.json',
    '_netlog_requests.json',
    '_page_data.json',
    '_visual_progress.json',
    '_timed_events.json',
    '_script_timing.json',
    '_trace.json.gz',
    '_timeline_cpu.json',
    '_long_tasks.json',
    '_interactive.json',
    'lighthouse.json.gz',
    '_bodies.zip',
];

function looksLikeWptagentZip(buf) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(buf.subarray(0, Math.min(buf.length, 65536)));
    for (const token of WPTAGENT_FILENAME_TOKENS) {
        if (text.includes(token)) return true;
    }
    return false;
}

function finishSniffing(text, resolve) {
    const minText = text.replace(/\s/g, '');

    // Perfetto binary parsing sniff: It frequently contains typical Perfetto metadata strings
    // even though it is mostly binary characters natively.
    if (text.includes('org.chromium.trace_metadata') || text.includes('Perfetto v') || text.includes('TracePacket')) return resolve({ format: 'perfetto' });

    if (minText.includes('{"constants":') && minText.includes('"logEventTypes":')) return resolve({ format: 'netlog' });
    if (minText.includes('CLIENT_RANDOM') || minText.includes('CLIENT_HANDSHAKE_TRAFFIC_SECRET') || minText.includes('CLIENT_TRAFFIC_SECRET_0')) return resolve({ format: 'keylog' });
    if ((minText.startsWith('{"data":{') || minText.includes('"data":{')) && (minText.includes('"median":') || minText.includes('"runs":') || minText.includes('"testRuns":') || minText.includes('"average":'))) return resolve({ format: 'wpt' });
    // Chrome trace JSON wrapper form. Plain captures are `{"traceEvents":[...]}`, but
    // DevTools-saved traces put `metadata` first (`{"metadata":{...},"traceEvents":[...]}`)
    // and individual events may lead with any key (e.g. `{"args":..., "cat":..., "pid":...}`),
    // so a substring check on the `traceEvents` key is the only reliable wrapper signal.
    const hasTraceEventsWrapper = minText.includes('"traceEvents":[');
    if (hasTraceEventsWrapper || (minText.includes('{"pid":') && minText.includes('"ts":') && minText.includes('"cat":'))) {
        return resolve({ format: 'chrome-trace', hasTraceEventsWrapper });
    }
    if (minText.startsWith('[{"pid":') || minText.startsWith('[{"cat":') || minText.startsWith('[{"name":') || minText.startsWith('[{"args":')) return resolve({ format: 'chrome-trace', hasTraceEventsWrapper: false });
    if (minText.startsWith('[{"method":"') || minText.includes('{"method":"Network.')) return resolve({ format: 'cdp' });
    if (minText.includes('{"log":{"version":') || minText.includes('{"log":{"creator":') || minText.includes('{"log":{"pages":')) return resolve({ format: 'har' });

    resolve({ format: 'unknown' });
}

export async function identifyFormat(filePath, options = {}) {
    if (typeof filePath !== 'string') {
        throw new Error('identifyFormat currently only supports file paths. For streams, pass the format explicitly via options.format.');
    }

    // Dynamically import node modules so browser bundle doesn't crash if explicitly bypassing node paths
    const fs = await import(/* @vite-ignore */ 'node:fs');

    // Read up to 64KB for format sniffing using a Uint8Array (not Node Buffer)
    const sniffBuf = new Uint8Array(65536);
    const fd = fs.openSync(filePath, 'r');
    // fs.readSync accepts Uint8Array natively in modern Node
    const bytesRead = fs.readSync(fd, sniffBuf, 0, 65536, 0);
    fs.closeSync(fd);

    const buf = sniffBuf.subarray(0, bytesRead);
    const result = await identifyFormatFromBuffer(buf, options);
    if (options.debug) console.log(`[orchestrator.js] Identified format '${result.format}' from ${filePath}`);
    return result.format;
}

export async function identifyFormatFromBuffer(buffer, options = {}) {
    const buf = toUint8Array(buffer);
    const isGz = isGzip(buf);

    let textBuf = buf;
    if (isGz) {
        try {
            const ds = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            writer.write(buf.subarray(0, Math.min(buf.length, 65536))).catch(() => {});
            writer.close().catch(() => {});

            const reader = ds.readable.getReader();
            const chunks = [];
            let totalLen = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = new Uint8Array(value);
                chunks.push(chunk);
                totalLen += chunk.length;
                if (totalLen >= 65536) {
                    try { await reader.cancel(); } catch {}
                    break;
                }
            }
            const sniffed = concatUint8Arrays(chunks);
            textBuf = sniffed.length > 0 ? sniffed : buf;
        } catch {
            // Return gracefully if stream aborts randomly
            textBuf = buf;
        }
    }

    // Check for ZIP magic bytes (PK\x03\x04). Require at least one
    // distinctive wptagent member filename in the first 64KB so we don't
    // claim arbitrary zips as wptagent archives. The central directory lives
    // at the end of the archive, but each member is preceded by a local file
    // header containing its filename — that's what we scan for here.
    if (textBuf.length >= 4) {
        const magic = readUint32BE(textBuf, 0);
        if (magic === 0x504b0304 && looksLikeWptagentZip(textBuf)) {
            return { format: 'wptagent', isGz: false };
        }
    }

    // Check for PCAP/PCAPNG magic bytes using DataView-free integer reads
    if (textBuf.length >= 4) {
        const magic = readUint32BE(textBuf, 0);
        const magicLE = readUint32LE(textBuf, 0);
        if ([0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a].includes(magic) || [0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a].includes(magicLE)) {
            return { format: 'tcpdump', isGz };
        }
    }

    // Heuristically detect Perfetto by checking first TracePacket tag bytes safely
    if (textBuf.length >= 4 && textBuf[0] === 0x0a) {
        // Tag 0x0a is Field 1 (TracePacket), WireType 2 (length-delimited).
        // Let's decode the length varint.
        let len = 0; let shift = 0; let o = 1;
        while(o < textBuf.length && o < 5) {
            const b = textBuf[o++];
            len |= (b & 0x7f) << shift;
            shift += 7;
            if (!(b & 0x80)) break;
        }
        // If length fits reasonably or if we see another TracePacket soon, it is highly likely Perfetto.
        if (textBuf.length > o + len) {
            if (textBuf[o + len] === 0x0a) {
                 return { format: 'perfetto', isGz };
            }
        }
    }

    return new Promise((resolve) => {
        // Decode the sniffed bytes to a UTF-8 string using the isomorphic TextDecoder API
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const textToSniff = decoder.decode(textBuf.subarray(0, 65536));
        finishSniffing(textToSniff, (result) => {
            if (options.debug) console.log(`[orchestrator.js] Sniffed buffer and determined format: '${result.format}'`);
            result.isGz = isGz;
            resolve(result);
        });
    });
}
