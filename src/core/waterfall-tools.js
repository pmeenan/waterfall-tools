/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { identifyFormat, identifyFormatFromBuffer, parsers } from '../inputs/orchestrator.js';
import { getPageFromData, relationalToHar } from './har-export.js';
import { ZipReader } from '../inputs/utilities/zip.js';
import { cleanupOrphans } from '../platforms/storage.js';
import { WaterfallCanvas } from '../renderer/canvas.js';
import { generateImage } from '../outputs/image.js';

export { identifyFormatFromBuffer };
export { Layout } from '../renderer/layout.js';
export { PerfettoDecoder } from '../inputs/utilities/perfetto/decoder.js';

// Formats whose parser accepts an ARRAY of inputs merged into a single page. Today that is
// only qlog (one file per QUIC connection — a page load over HTTP/3 produces several).
const MULTI_BUFFER_FORMATS = ['qlog'];
const QLOG_MIME_TYPE = 'application/qlog';

// Formats whose original input bytes back a getPageResource() route ('trace' for
// chrome-trace/perfetto, 'netlog' for netlog, 'qlog' for qlog). Every other format's raw
// buffer would just be a second full in-memory copy of the input that nothing reads, so
// loadBuffer() only retains it for these.
const RAW_BUFFER_FORMATS = new Set(['chrome-trace', 'perfetto', 'netlog', 'qlog']);

// Screenshot strings are untrusted HAR data. Only well-formed base64 image data URIs (or
// bare base64 that we prefix ourselves) are ever handed back as a URL — anything else
// (javascript:, text/html, quote/markup injection) is dropped.
const SCREENSHOT_DATA_URI_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const RAW_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validate an untrusted `_screenshot` value and normalize it to a safe data URI.
 * @param {*} value
 * @returns {{url: string, mimeType: string} | null}
 */
function sanitizeScreenshotDataUri(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    // Whitespace (line-wrapped base64) is never meaningful; strip before validating so the
    // returned URL is exactly what the strict pattern accepted.
    const str = value.replace(/\s+/g, '');
    if (str.startsWith('data:')) {
        const m = SCREENSHOT_DATA_URI_RE.exec(str);
        if (!m) return null;
        const mimeType = m[1] === 'jpg' ? 'image/jpeg' : `image/${m[1]}`;
        return { url: `data:${mimeType};base64,${m[2]}`, mimeType };
    }
    if (!RAW_BASE64_RE.test(str)) return null;
    // Sniff the base64-encoded magic bytes; legacy WPT screenshots are JPEG.
    let mimeType = 'image/jpeg';
    if (str.startsWith('iVBORw0KGgo')) mimeType = 'image/png';
    else if (str.startsWith('R0lGOD')) mimeType = 'image/gif';
    else if (str.startsWith('UklGR')) mimeType = 'image/webp';
    return { url: `data:${mimeType};base64,${str}`, mimeType };
}

/**
 * Object URLs only make sense where something can consume them (a DOM document). In Node
 * (and workers without a document) URL.createObjectURL exists but nothing ever revokes the
 * URL, so the backing Blob would leak for the process lifetime.
 * @returns {boolean}
 */
function canCreateObjectUrls() {
    return typeof document !== 'undefined'
        && typeof Blob !== 'undefined'
        && typeof URL !== 'undefined'
        && typeof URL.createObjectURL === 'function';
}

/**
 * Return a Uint8Array whose view spans its entire backing ArrayBuffer, so `result.buffer`
 * is the exact payload (callers that need an ArrayBuffer, e.g. postMessage consumers, can
 * use `.buffer` without slicing).
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Uint8Array}
 */
function toExactUint8Array(bytes) {
    const view = toUint8Array(bytes);
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view;
    return new Uint8Array(copyExactBuffer(view));
}

/**
 * Build the uniform getPageResource() result: `buffer` is always an exact-span Uint8Array;
 * `url` (a blob: object URL the caller must revoke) is only added in a DOM context.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {string} mimeType
 * @returns {{buffer: Uint8Array, mimeType: string, url?: string}}
 */
function makeBufferResource(bytes, mimeType) {
    const buffer = toExactUint8Array(bytes);
    const resource = { buffer, mimeType };
    if (canCreateObjectUrls()) {
        resource.url = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
    }
    return resource;
}

/**
 * Normalize ArrayBuffer / Uint8Array / Node Buffer / other TypedArray views to Uint8Array
 * without depending on the Node-specific Buffer class.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Uint8Array}
 */
function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array) {
        return buffer;
    } else if (buffer instanceof ArrayBuffer) {
        return new Uint8Array(buffer);
    } else if (buffer && buffer.buffer instanceof ArrayBuffer) {
        // Handles Node Buffer and other TypedArray views
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    return new Uint8Array(buffer);
}

function copyExactBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function getBufferName(options, index) {
    const names = Array.isArray(options.bufferNames) ? options.bufferNames : null;
    const name = names && names[index];
    if (typeof name === 'string' && name.trim()) {
        return name;
    }
    return `connection-${index + 1}.qlog`;
}

export class WaterfallTools {
    constructor() {
        this.instanceId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.floor(Math.random() * 1000000000).toString();
        this.data = {
            metadata: {},
            pages: {},
            tcp_connections: {},
            http2_connections: {},
            quic_connections: {},
            dns: {}
        };

        // Fire asynchronous background cleanup garbage collecting orphaned lock processes cleanly
        cleanupOrphans().catch(() => {});
    }

    /**
     * Cleans up staged archive resources and associated file handles.
     */
    async destroy() {
        await this._destroyCurrentData();
        this.data = null;
        this._sourceFormat = null;
        this._rawBuffer = null;
        this._rawBufferName = null;
        this._rawBuffers = null;
        this._rumcapTraceCache = null;
    }

    /**
     * Throws a clear error when no successful load backs this instance (never loaded,
     * destroyed, or the most recent load threw mid-parse).
     * @private
     */
    _requireData() {
        if (!this.data || !this.data.pages) {
            throw new Error('No data loaded: call loadFile()/loadBuffer()/loadStream() successfully first.');
        }
    }

    /**
     * Run a parser and leave the instance in a consistent "no data" state if it throws:
     * data stays null (so accessors throw a clear error instead of a TypeError) and the
     * format/raw-buffer state of the failed load is cleared.
     * @private
     */
    async _runParser(parser, input, options) {
        this.options = { debug: !!options.debug };
        try {
            this.data = await parser(input, options);
        } catch (e) {
            this.data = null;
            this._sourceFormat = null;
            this._rawBuffer = null;
            this._rawBufferName = null;
            this._rawBuffers = null;
            this._rumcapTraceCache = null;
            throw e;
        }
    }

    async _destroyCurrentData() {
        if (this.data && this.data._opfsStorage && typeof this.data._opfsStorage.destroy === 'function') {
            await this.data._opfsStorage.destroy();
        }
        this._rawBuffer = null;
        this._rawBufferName = null;
        this._rawBuffers = null;
        this._rumcapTraceCache = null;
    }

    /**
     * Processes a network trace file and stores it as the new relational format.
     * @param {string} filePath - Path to the file to process
     * @param {Object} options - Optional parameters
     * @returns {Promise<WaterfallTools>} This instance
     */
    async loadFile(filePath, options = {}) {
        let format = options.format;
        if (!format) {
            format = await identifyFormat(filePath, options);
        }
        
        if (format === 'unknown') {
            throw new Error(`Could not automatically identify format for file: ${filePath}`);
        }
        
        const parser = parsers[format];
        if (!parser) {
            throw new Error(`No parser registered for format: ${format}`);
        }

        await this._destroyCurrentData();
        this.data = null;

        // Format-gated resource routes (getPageResource 'trace'/'netlog') key on this — it must
        // be set on every load path, not just loadBuffer(). Reused-instance guard: the raw
        // buffer and synthesized-trace cache belong to the PREVIOUS load — a file load has no
        // backing buffer, so both must drop or the resource routes serve stale bytes.
        this._sourceFormat = format;
        this._rawBuffer = null;
        this._rawBufferName = null;
        this._rawBuffers = null;
        this._rumcapTraceCache = null;
        options.instanceId = this.instanceId;
        await this._runParser(parser, filePath, options);
        return this;
    }

    /**
     * Processes a network trace ReadableStream.
     * @param {ReadableStream} stream 
     * @param {Object} options 
     * @returns {Promise<WaterfallTools>}
     */
    async loadStream(stream, options = {}) {
        const format = options.format;
        if (!format) {
            throw new Error('For loadStream, you must explicitly provide options.format');
        }
        
        const parser = parsers[format];
        if (!parser) {
            throw new Error(`No parser registered for format: ${format}`);
        }

        await this._destroyCurrentData();
        this.data = null;

        // Same assignment as loadBuffer()/loadFile() — loadBuffer() delegates here, so the
        // double-assign of the identical resolved format is harmless. The stale-state clears
        // mirror loadFile(); loadBuffer() re-attaches its own buffer AFTER this returns.
        this._sourceFormat = format;
        this._rawBuffer = null;
        this._rawBufferName = null;
        this._rawBuffers = null;
        this._rumcapTraceCache = null;
        options.instanceId = this.instanceId;
        await this._runParser(parser, stream, options);
        return this;
    }

    /**
     * Processes a network trace from a raw Memory Buffer natively.
     * Accepts ArrayBuffer, Uint8Array, or Node Buffer — all handled isomorphically
     * without depending on the Node-specific Buffer class.
     * @param {ArrayBuffer|Uint8Array} buffer
     * @param {Object} options
     * @returns {Promise<WaterfallTools>}
     */
    async loadBuffer(buffer, options = {}) {
        // Normalize to Uint8Array without requiring Node's Buffer class
        const buf = toUint8Array(buffer);

        let format = options.format;
        let isGz = options.isGz;
        let hasTraceEventsWrapper = options.hasTraceEventsWrapper;

        if (!format) {
            const detected = await identifyFormatFromBuffer(buf, options);
            format = detected.format;
            if (isGz === undefined) {
                isGz = detected.isGz;
            }
            if (hasTraceEventsWrapper === undefined && detected.hasTraceEventsWrapper !== undefined) {
                hasTraceEventsWrapper = detected.hasTraceEventsWrapper;
            }
            if (format === 'unknown') {
                throw new Error('Could not automatically identify format from buffer');
            }
        }

        const stream = new Blob([buf]).stream();
        const streamOptions = { ...options, format, instanceId: this.instanceId };
        if (isGz !== undefined) streamOptions.isGz = isGz;
        if (hasTraceEventsWrapper !== undefined) streamOptions.hasTraceEventsWrapper = hasTraceEventsWrapper;

        // Pass total buffer size so stream-based parsers can estimate progress
        streamOptions.totalBytes = buf.byteLength;

        this._sourceFormat = format;
        const result = await this.loadStream(stream, streamOptions);
        // AFTER loadStream() — it clears the raw-buffer state as its reused-instance guard;
        // re-attach the bytes backing THIS load so trace/netlog/qlog passthrough works.
        // Only formats with a raw-buffer resource route keep a copy (see RAW_BUFFER_FORMATS).
        if (RAW_BUFFER_FORMATS.has(format)) {
            this._rawBuffer = copyExactBuffer(buf); // Store exact ArrayBuffer view
            this._rawBufferName = format === 'qlog' ? getBufferName(options, 0) : null;
        }
        return result;
    }

    /**
     * Processes MULTIPLE raw buffers as one merged load. Only formats whose parser accepts
     * an input array support this — today that is qlog, where each file carries a single
     * QUIC connection and a page load produces one file per origin.
     *
     * Every member is format-sniffed independently; the load fails loudly when members
     * disagree (never silently misparses a stray HAR mixed into a qlog drop) or when the
     * common format has no multi-input merge support.
     *
     * A single-member array delegates to loadBuffer() so it behaves exactly like a
     * conventional single-file load (including raw-buffer retention).
     * @param {Array<ArrayBuffer|Uint8Array>} buffers
     * @param {Object} options
     * @returns {Promise<WaterfallTools>}
     */
    async loadBuffers(buffers, options = {}) {
        if (!Array.isArray(buffers) || buffers.length === 0) {
            throw new Error('loadBuffers requires a non-empty array of buffers');
        }
        if (buffers.length === 1) {
            return await this.loadBuffer(buffers[0], options);
        }

        const bufs = buffers.map(toUint8Array);
        const formats = [];
        for (const buf of bufs) {
            formats.push((await identifyFormatFromBuffer(buf, options)).format);
        }

        const format = formats[0];
        if (!formats.every(f => f === format)) {
            throw new Error(`loadBuffers requires all buffers to share one format; detected: ${formats.join(', ')}`);
        }
        if (!MULTI_BUFFER_FORMATS.includes(format)) {
            throw new Error(`Format '${format}' does not support multi-buffer merging (supported: ${MULTI_BUFFER_FORMATS.join(', ')})`);
        }

        const parser = parsers[format];
        if (!parser) {
            throw new Error(`No parser registered for format: ${format}`);
        }

        // Same reused-instance guards as loadFile()/loadStream(). A merged load has no
        // single backing buffer, so the raw-buffer resource passthrough stays cleared.
        await this._destroyCurrentData();
        this.data = null;

        this._sourceFormat = format;
        this._rawBuffer = null;
        this._rawBufferName = null;
        this._rawBuffers = null;
        this._rumcapTraceCache = null;

        const parseOptions = {
            ...options,
            format,
            instanceId: this.instanceId,
            totalBytes: bufs.reduce((sum, b) => sum + b.byteLength, 0)
        };
        await this._runParser(parser, bufs, parseOptions);
        if (format === 'qlog') {
            this._rawBuffers = bufs.map((buf, index) => ({
                name: getBufferName(options, index),
                buffer: copyExactBuffer(buf)
            }));
        }
        return this;
    }

    /**
     * Processes an external network trace file by fetching it.
     * @param {string} url 
     * @param {Object} options 
     * @returns {Promise<WaterfallTools>}
     */
    async loadUrl(url, options = {}) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch URL ${url}: ${response.statusText}`);
        }
        
        if (options.format) {
             return await this.loadStream(response.body, options);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        return await this.loadBuffer(arrayBuffer, options);
    }

    /**
     * Get an individual page with associated timings mapped dynamically.
     * @param {string} pageId
     * @param {Object} options - { includeRequests: boolean }
     * @returns {Object} The flattened page object
     */
    getPage(pageId, options = { includeRequests: false }) {
        // Delegates to the raw-Node-safe extraction in har-export.js (shared with the
        // per-format CLI wrappers, which can't import this class).
        return getPageFromData(this.data, pageId, options);
    }

    /**
     * Get an individual request natively flattened
     * @param {string} pageId 
     * @param {string} requestId 
     * @param {Object} options - { includeBody: boolean }
     * @returns {Object} Target request
     */
    getRequest(pageId, requestId, options = { includeBody: false }) {
        const page = this.getPage(pageId, { includeRequests: true });
        if (!page || !page.requests || !page.requests[requestId]) return null;
        
        const req = page.requests[requestId];
        if (!options.includeBody) {
             delete req.body; // strip body specifically
        }
        return req;
    }

    /**
     * Gets an Object URL, raw buffer, or qlog file list for a specific raw asset dynamically.
     * Automatically retrieves assets securely natively from HAR mapping or generic OPFS extraction instances securely.
     * @param {string} pageId 
     * @param {string} resourceType - 'screenshot', 'trace', 'netlog', 'tcpdump', 'lighthouse', 'qlog'
     * Binary resources always return `buffer` as a Uint8Array spanning its whole backing
     * ArrayBuffer (so `buffer.buffer` is the exact payload). `url` is a blob: object URL that
     * is only created in a DOM context (`typeof document !== 'undefined'`); the caller owns
     * it and must `URL.revokeObjectURL()` it. Screenshot/Lighthouse strings from the HAR
     * return a `data:` URL only.
     * @returns {Promise<{ url?: string, buffer?: Uint8Array, files?: Array<{name: string, mimeType: string, buffer: ArrayBuffer}>, mimeType?: string } | null>}
     */
    async getPageResource(pageId, resourceType = 'screenshot') {
        this._requireData();
        const pageData = this.getPage(pageId);
        if (!pageData) {
            console.warn(`[getPageResource] pageData not found for ${pageId}`);
            return null;
        }
        if (resourceType === 'screenshot' && pageData._screenshot) {
            const safe = sanitizeScreenshotDataUri(pageData._screenshot);
            if (safe) return safe;
            // Malformed/untrusted value: never pass it through; fall back to the archive
            // lookup below (which misses quietly for non-archive formats).
            if (this.options && this.options.debug) {
                console.warn(`[getPageResource] Ignoring malformed _screenshot value for ${pageId}`);
            }
        }

        if (resourceType === 'lighthouse' && pageData._lighthouse) {
            const str = pageData._lighthouse;
            const url = `data:text/html;charset=utf-8,${encodeURIComponent(str)}`;
            return { url, mimeType: 'text/html' };
        }

        if (resourceType === 'qlog' && this._sourceFormat === 'qlog') {
            let files = [];
            if (Array.isArray(this._rawBuffers) && this._rawBuffers.length > 0) {
                files = this._rawBuffers
                    .filter(raw => raw && raw.buffer)
                    .map((raw, index) => ({
                        name: raw.name || `connection-${index + 1}.qlog`,
                        mimeType: QLOG_MIME_TYPE,
                        buffer: raw.buffer
                    }));
            } else if (this._rawBuffer) {
                files = [{
                    name: this._rawBufferName || 'connection-1.qlog',
                    mimeType: QLOG_MIME_TYPE,
                    buffer: this._rawBuffer
                }];
            }
            return files.length > 0 ? { files } : null;
        }

        if (resourceType === 'trace' && (this._sourceFormat === 'chrome-trace' || this._sourceFormat === 'perfetto') && this._rawBuffer) {
            const mimeType = this._sourceFormat === 'chrome-trace' ? 'application/json' : 'application/octet-stream';
            return makeBufferResource(this._rawBuffer, mimeType);
        }

        if ((resourceType === 'trace' || resourceType === 'perfetto-trace')
            && (this._sourceFormat === 'rumcap' || (this.data && this.data.metadata && this.data.metadata.format === 'rumcap'))
            && this.data && this.data._rumcapCapture) {
            // Trace is SYNTHESIZED from the retained Capture (there is no raw trace in a field
            // capture). Dynamic import keeps the synthesizer out of the base bundle — same
            // pattern as the tcpdump/decompress code-splits.
            if (!this._rumcapTraceCache) this._rumcapTraceCache = {};
            const cacheKey = resourceType === 'perfetto-trace' ? 'perfetto' : 'devtools';
            if (!this._rumcapTraceCache[cacheKey]) this._rumcapTraceCache[cacheKey] = {};
            let bytes = this._rumcapTraceCache[cacheKey][pageId];
            const mimeType = resourceType === 'perfetto-trace' ? 'application/octet-stream' : 'application/gzip';
            if (!bytes) {
                const { synthesizeChromeTrace, synthesizePerfettoProto } = await import('../inputs/utilities/rumcap/trace-synthesizer.js');
                if (resourceType === 'perfetto-trace') {
                    bytes = toExactUint8Array(synthesizePerfettoProto(this.data._rumcapCapture));
                } else {
                    const traceJson = JSON.stringify(synthesizeChromeTrace(this.data._rumcapCapture));
                    // Gzip so DevTools' loadFromFile takes its internal DecompressionStream path.
                    const gzStream = new Blob([new TextEncoder().encode(traceJson)]).stream()
                        .pipeThrough(new CompressionStream('gzip'));
                    bytes = new Uint8Array(await new Response(gzStream).arrayBuffer());
                }
                this._rumcapTraceCache[cacheKey][pageId] = bytes;
            }
            // Same contract as every other binary route: Uint8Array buffer (the cached bytes
            // themselves), object URL only in a DOM context.
            return makeBufferResource(bytes, mimeType);
        }

        if (resourceType === 'netlog' && this._sourceFormat === 'netlog' && this._rawBuffer) {
            return makeBufferResource(this._rawBuffer, 'application/json');
        }

        // Only these resource types have an archive-backed file naming convention. Types that
        // only exist as synthesized/raw-buffer resources (e.g. 'perfetto-trace' on a wptagent
        // zip) miss quietly — the viewer probes them unconditionally and falls back.
        if (!['screenshot', 'trace', 'netlog', 'tcpdump', 'lighthouse'].includes(resourceType)) {
            if (this.options && this.options.debug) {
                console.log(`[getPageResource] No archive-backed handler for resource type '${resourceType}'`);
            }
            return null;
        }

        if (!this.data._opfsStorage || !this.data._zipFiles) {
            if (this.options && this.options.debug) {
                console.warn(`[getPageResource] Aborting: Missing _opfsStorage (${!!this.data._opfsStorage}) or _zipFiles (${!!this.data._zipFiles})`);
            }
            return null;
        }

        const runNum = pageData._run || '1';
        const cachedStr = pageData._cached ? '_Cached' : '';

        let targetFile = null;
        let mimeType = 'application/octet-stream';

        if (resourceType === 'screenshot') {
            const jpgFile = `${runNum}${cachedStr}_screen.jpg`;
            const pngFile = `${runNum}${cachedStr}_screen.png`;
            targetFile = this.data._zipFiles.find(f => f === jpgFile || f.endsWith(`/${jpgFile}`));
            mimeType = 'image/jpeg';
            if (!targetFile) {
                targetFile = this.data._zipFiles.find(f => f === pngFile || f.endsWith(`/${pngFile}`));
                if (targetFile) mimeType = 'image/png';
            }
        } else if (resourceType === 'trace') {
            const traceFile = `${runNum}${cachedStr}_trace.json.gz`;
            targetFile = this.data._zipFiles.find(f => f === traceFile || f.endsWith(`/${traceFile}`));
            mimeType = 'application/json';
        } else if (resourceType === 'netlog') {
            const netlogFileJson = `${runNum}${cachedStr}_netlog.json.gz`;
            const netlogFileTxt = `${runNum}${cachedStr}_netlog.txt.gz`;
            targetFile = this.data._zipFiles.find(f => f === netlogFileJson || f.endsWith(`/${netlogFileJson}`));
            if (!targetFile) {
                 targetFile = this.data._zipFiles.find(f => f === netlogFileTxt || f.endsWith(`/${netlogFileTxt}`));
            }
            mimeType = 'application/json';
        } else if (resourceType === 'tcpdump') {
            const pcapFile = `${runNum}${cachedStr}_tcpdump.cap.gz`;
            targetFile = this.data._zipFiles.find(f => f === pcapFile || f.endsWith(`/${pcapFile}`));
            mimeType = 'application/vnd.tcpdump.pcap';
        } else if (resourceType === 'lighthouse') {
            const lhFile = `${runNum}${cachedStr}_lighthouse.html`;
            const lhGzFile = `${runNum}${cachedStr}_lighthouse.html.gz`;
            const genericLhFile = 'lighthouse.html';
            const genericLhGzFile = 'lighthouse.html.gz';
            targetFile = this.data._zipFiles.find(f => f === lhFile || f.endsWith(`/${lhFile}`));
            if (!targetFile) targetFile = this.data._zipFiles.find(f => f === lhGzFile || f.endsWith(`/${lhGzFile}`));
            if (!targetFile) targetFile = this.data._zipFiles.find(f => f === genericLhFile || f.endsWith(`/${genericLhFile}`));
            if (!targetFile) targetFile = this.data._zipFiles.find(f => f === genericLhGzFile || f.endsWith(`/${genericLhGzFile}`));
            mimeType = 'text/html';
        }

        if (!targetFile) {
            console.warn(`[getPageResource] Resource file not found in ZIP array for ${pageId}`);
            return null;
        }

        const zip = new ZipReader(this.data._opfsStorage);
        await zip.init();
        let stream = await zip.getFileStream(targetFile);
        if (!stream) {
            console.warn(`[getPageResource] getFileStream returned null for target: ${targetFile}`);
            return null;
        }

        if (resourceType === 'lighthouse' && targetFile.endsWith('.gz') && typeof DecompressionStream !== 'undefined') {
            stream = stream.pipeThrough(new DecompressionStream('gzip'));
        }

        const reader = stream.getReader();
        const chunks = [];
        let totalLen = 0;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalLen += value.length;
        }
        
        const fullArr = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
            fullArr.set(c, offset);
            offset += c.length;
        }
        
        return makeBufferResource(fullArr, mimeType);
    }

    /**
     * Compiles standard Extended HAR 1.2 Format strictly derived from internal Relational mapping
     * @param {Object} options 
     */
    getHar(_options = {}) {
        // Delegates to the raw-Node-safe extraction in har-export.js (shared with the
        // per-format CLI wrappers, which can't import this class).
        return relationalToHar(this.data, _options);
    }

    /**
     * Gets the default UI visualization layout options.
     * @returns {Object} Defaults configuration
     */
    static getDefaultOptions() {
        return {
            pageId: null,
            connectionView: false,
            thumbnailView: false,
            minWidth: 0,
            startTime: null,
            endTime: null,
            reqFilter: '',
            urlFilter: '',
            showPageMetrics: true,
            showMarks: false,
            showCpu: true,
            showBw: true,
            showMainthread: true,
            showLongtasks: true,
            showMissing: false,
            showLabels: true,
            showChunks: true,
            showJsTiming: true,
            showWait: true,
            showLegend: true,
            // Theming hooks. All `null`/`{}` defaults resolve to the
            // existing hard-coded values (background `#ffffff`, row stripe
            // `#f0f0f0`, border `#000000`, grid `rgb(192,192,192)`, etc.)
            // so the default visual is unchanged. Override individual
            // keys to retheme without forking the renderer.
            rowHeight: null,                // null → 18 (or 4 in thumbnail view)
            backgroundColor: null,          // null → '#ffffff'
            palette: {}                     // see canvas.js draw() for the resolved keys
        };
    }

    async renderTo(container, options = {}) {
        this._requireData();
        // Find default page if not specified
        let pageId = options.pageId;
        if (!pageId) {
            const keys = Object.keys(this.data.pages);
            if (keys.length === 0) throw new Error("No pages available to render.");
            pageId = keys[0];
        }
        
        // Retrieve the relational flattened layout recursively natively
        const pageData = this.getPage(pageId, { includeRequests: true });
        
        // Fire render
        const canvasRenderer = new WaterfallCanvas(container, options);
        canvasRenderer.render(pageData);
        return canvasRenderer;
    }

    /**
     * Headless generation of an image buffer (PNG/JPEG).
     * Works natively both in Browsers (via OffscreenCanvas/createElement) and Node.js (via optionally installed @napi-rs/canvas)
     * @param {string} pageId - Target page ID to render.
     * @param {Object} options - Configurable rendering constraints (e.g. { format: 'png', quality: 0.85, width: 1200 })
     * @returns {Promise<{ buffer: Uint8Array, mimeType: string, width: number, height: number }>}
     */
    async generateImage(pageId, options = {}) {
        this._requireData();
        if (!pageId) {
            const keys = Object.keys(this.data.pages);
            if (keys.length === 0) throw new Error("No pages available to render.");
            pageId = keys[0];
        }
        
        return await generateImage(this, pageId, options);
    }
}
