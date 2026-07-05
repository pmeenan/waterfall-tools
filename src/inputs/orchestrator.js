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
import { processRumcapNode } from './rumcap.js';
import { processQlogNode } from './qlog.js';
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
    'wptagent': processWptagentZip,
    'rumcap': processRumcapNode,
    'qlog': processQlogNode
};

function isGzip(buf) {
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

const SNIFF_SIZE = 65536;

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
    if (minText.includes('{"log":{"version":') || minText.includes('{"log":{"creator":') || minText.includes('{"log":{"pages":')) return resolve({ format: 'har' });
    // qlog plain JSON (.qlog): the qlog_version token (draft era) and the
    // urn:ietf:params:qlog schema URNs (spec-final, e.g. quiche) identify qlog
    // payloads. HAR is checked first because qlog-derived Extended HAR exports
    // legitimately preserve qlog URNs in page._qlogTraces metadata.
    if (minText.includes('"qlog_version"') || minText.includes('urn:ietf:params:qlog')) return resolve({ format: 'qlog' });
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

    resolve({ format: 'unknown' });
}

async function gunzipPrefixFromBuffer(buf) {
    // `chunks`/`totalLen` live OUTSIDE the try so a mid-stream decode error still
    // returns what was already decoded. When `buf` is only the first SNIFF_SIZE
    // compressed bytes of a large, incompressible payload (e.g. a user-gzipped
    // .rcap.gz whose inner body is already gzipped, or a .cap.gz of encrypted
    // traffic), the truncated gzip errors before a clean end — but the format
    // magic sits at the very start of the decoded output, so the partial prefix
    // is exactly what the sniffer needs. Returning raw `buf` here would hide it.
    const chunks = [];
    let totalLen = 0;
    try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(buf).catch(() => {});
        writer.close().catch(() => {});

        const reader = ds.readable.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new Uint8Array(value);
            chunks.push(chunk);
            totalLen += chunk.length;
            if (totalLen >= SNIFF_SIZE) {
                try { await reader.cancel(); } catch {}
                break;
            }
        }
    } catch {
        // Truncated/corrupt stream — fall through and keep whatever decoded.
    }
    return totalLen > 0 ? concatUint8Arrays(chunks).subarray(0, SNIFF_SIZE) : buf;
}

async function gunzipPrefixFromFile(filePath) {
    const fs = await import(/* @vite-ignore */ 'node:fs');
    const zlib = await import(/* @vite-ignore */ 'node:zlib');
    return new Promise((resolve) => {
        const input = fs.createReadStream(filePath);
        const gunzip = zlib.createGunzip();
        const chunks = [];
        let totalLen = 0;
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            input.destroy();
            gunzip.destroy();
            resolve(result);
        };

        gunzip.on('data', chunk => {
            const arr = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            chunks.push(new Uint8Array(arr));
            totalLen += arr.length;
            if (totalLen >= SNIFF_SIZE) {
                finish(concatUint8Arrays(chunks).subarray(0, SNIFF_SIZE));
            }
        });
        gunzip.on('end', () => {
            finish(totalLen > 0 ? concatUint8Arrays(chunks).subarray(0, SNIFF_SIZE) : new Uint8Array());
        });
        // On a truncated/corrupt stream keep whatever already decoded — the format
        // magic lives at the start of the payload (mirrors gunzipPrefixFromBuffer).
        gunzip.on('error', () => finish(totalLen > 0 ? concatUint8Arrays(chunks).subarray(0, SNIFF_SIZE) : new Uint8Array()));
        input.on('error', () => finish(totalLen > 0 ? concatUint8Arrays(chunks).subarray(0, SNIFF_SIZE) : new Uint8Array()));
        input.pipe(gunzip);
    });
}

function sniffFormatBytes(textBuf, isGz, options = {}) {
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

    // rumcap (.rcap) cleartext magic: 0xF5 then ASCII "RUM" (0x52 0x55 0x4D).
    if (textBuf.length >= 4 &&
        textBuf[0] === 0xf5 && textBuf[1] === 0x52 && textBuf[2] === 0x55 && textBuf[3] === 0x4d) {
        return { format: 'rumcap', isGz };
    }

    // qlog JSON-SEQ (.sqlog, RFC 7464): require a leading 0x1E record separator
    // and a qlog identity token within the decompressed sniff window.
    if (textBuf.length >= 1 && textBuf[0] === 0x1e) {
        const seqDecoder = new TextDecoder('utf-8', { fatal: false });
        const seqText = seqDecoder.decode(textBuf.subarray(0, SNIFF_SIZE));
        if (seqText.includes('"qlog_version"') || seqText.includes('urn:ietf:params:qlog')) {
            return { format: 'qlog', isGz };
        }
    }

    // Heuristically detect Perfetto by checking first TracePacket tag bytes safely
    if (textBuf.length >= 4 && textBuf[0] === 0x0a) {
        let len = 0; let shift = 0; let o = 1;
        while(o < textBuf.length && o < 5) {
            const b = textBuf[o++];
            len |= (b & 0x7f) << shift;
            shift += 7;
            if (!(b & 0x80)) break;
        }
        if (textBuf.length > o + len && textBuf[o + len] === 0x0a) {
            return { format: 'perfetto', isGz };
        }
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const textToSniff = decoder.decode(textBuf.subarray(0, SNIFF_SIZE));
    let result;
    finishSniffing(textToSniff, (sniffed) => {
        result = sniffed;
    });
    if (options.debug) console.log(`[orchestrator.js] Sniffed buffer and determined format: '${result.format}'`);
    result.isGz = isGz;
    return result;
}

export async function identifyFormat(filePath, options = {}) {
    if (typeof filePath !== 'string') {
        throw new Error('identifyFormat currently only supports file paths. For streams, pass the format explicitly via options.format.');
    }

    // Dynamically import node modules so browser bundle doesn't crash if explicitly bypassing node paths
    const fs = await import(/* @vite-ignore */ 'node:fs');

    // Read up to 64KB for format sniffing using a Uint8Array (not Node Buffer)
    const sniffBuf = new Uint8Array(SNIFF_SIZE);
    const fd = fs.openSync(filePath, 'r');
    // fs.readSync accepts Uint8Array natively in modern Node
    const bytesRead = fs.readSync(fd, sniffBuf, 0, SNIFF_SIZE, 0);
    fs.closeSync(fd);

    const buf = sniffBuf.subarray(0, bytesRead);
    const isGz = isGzip(buf);
    const textBuf = isGz ? await gunzipPrefixFromFile(filePath) : buf;
    const result = sniffFormatBytes(textBuf.length > 0 ? textBuf : buf, isGz, options);
    if (options.debug) console.log(`[orchestrator.js] Identified format '${result.format}' from ${filePath}`);
    return result.format;
}

export async function identifyFormatFromBuffer(buffer, options = {}) {
    const buf = toUint8Array(buffer);
    const isGz = isGzip(buf);

    const textBuf = isGz ? await gunzipPrefixFromBuffer(buf) : buf;
    return sniffFormatBytes(textBuf, isGz, options);
}
