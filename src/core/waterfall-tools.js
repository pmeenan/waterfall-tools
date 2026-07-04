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
        if (this.data && this.data._opfsStorage && typeof this.data._opfsStorage.destroy === 'function') {
            await this.data._opfsStorage.destroy();
        }
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

        // Format-gated resource routes (getPageResource 'trace'/'netlog') key on this — it must
        // be set on every load path, not just loadBuffer(). Reused-instance guard: the raw
        // buffer and synthesized-trace cache belong to the PREVIOUS load — a file load has no
        // backing buffer, so both must drop or the resource routes serve stale bytes.
        this._sourceFormat = format;
        this._rawBuffer = null;
        this._rumcapTraceCache = null;
        options.instanceId = this.instanceId;
        this.data = await parser(filePath, options);
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

        // Same assignment as loadBuffer()/loadFile() — loadBuffer() delegates here, so the
        // double-assign of the identical resolved format is harmless. The stale-state clears
        // mirror loadFile(); loadBuffer() re-attaches its own buffer AFTER this returns.
        this._sourceFormat = format;
        this._rawBuffer = null;
        this._rumcapTraceCache = null;
        options.instanceId = this.instanceId;
        this.data = await parser(stream, options);
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
        let buf;
        if (buffer instanceof Uint8Array) {
            buf = buffer;
        } else if (buffer instanceof ArrayBuffer) {
            buf = new Uint8Array(buffer);
        } else if (buffer && buffer.buffer instanceof ArrayBuffer) {
            // Handles Node Buffer and other TypedArray views
            buf = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } else {
            buf = new Uint8Array(buffer);
        }

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
        // re-attach the bytes backing THIS load so trace/netlog passthrough works.
        this._rawBuffer = buf.buffer; // Store ArrayBuffer
        return result;
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
     * Gets an Object URL or raw buffer for a specific raw asset dynamically (e.g., screenshot, trace).
     * Automatically retrieves assets securely natively from HAR mapping or generic OPFS extraction instances securely.
     * @param {string} pageId 
     * @param {string} resourceType - 'screenshot', 'trace', 'netlog', 'tcpdump', 'lighthouse'
     * @returns {Promise<{ url?: string, buffer?: Uint8Array, mimeType: string } | null>} 
     */
    async getPageResource(pageId, resourceType = 'screenshot') {
        const pageData = this.getPage(pageId);
        if (!pageData) {
            console.warn(`[getPageResource] pageData not found for ${pageId}`);
            return null;
        }
        if (resourceType === 'screenshot' && pageData._screenshot) {
            const str = pageData._screenshot;
            if (str.startsWith('data:image/')) {
                return { url: str, mimeType: str.substring(5, str.indexOf(';')) };
            } else {
                const url = `data:image/jpeg;base64,${str}`;
                return { url, mimeType: 'image/jpeg' };
            }
        }

        if (resourceType === 'lighthouse' && pageData._lighthouse) {
            const str = pageData._lighthouse;
            const url = `data:text/html;charset=utf-8,${encodeURIComponent(str)}`;
            return { url, mimeType: 'text/html' };
        }

        if (resourceType === 'trace' && (this._sourceFormat === 'chrome-trace' || this._sourceFormat === 'perfetto') && this._rawBuffer) {
            const mimeType = this._sourceFormat === 'chrome-trace' ? 'application/json' : 'application/octet-stream';
            const blob = new Blob([this._rawBuffer], { type: mimeType });
            return { url: URL.createObjectURL(blob), mimeType, buffer: this._rawBuffer };
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
                    bytes = synthesizePerfettoProto(this.data._rumcapCapture);
                } else {
                    const traceJson = JSON.stringify(synthesizeChromeTrace(this.data._rumcapCapture));
                    // Gzip so DevTools' loadFromFile takes its internal DecompressionStream path.
                    const gzStream = new Blob([new TextEncoder().encode(traceJson)]).stream()
                        .pipeThrough(new CompressionStream('gzip'));
                    bytes = new Uint8Array(await new Response(gzStream).arrayBuffer());
                }
                this._rumcapTraceCache[cacheKey][pageId] = bytes;
            }
            // Same browser/Node contract as the generic ZIP extraction path below: object URL +
            // ArrayBuffer when Blob/URL exist, bare Uint8Array buffer otherwise (Node).
            if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
                const blob = new Blob([bytes], { type: mimeType });
                return { url: URL.createObjectURL(blob), mimeType, buffer: bytes.buffer };
            }
            return { buffer: bytes, mimeType };
        }

        if (resourceType === 'netlog' && this._sourceFormat === 'netlog' && this._rawBuffer) {
            const blob = new Blob([this._rawBuffer], { type: 'application/json' });
            return { url: URL.createObjectURL(blob), mimeType: 'application/json', buffer: this._rawBuffer };
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
        
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
            const blob = new Blob([fullArr], { type: mimeType });
            return { url: URL.createObjectURL(blob), mimeType, buffer: fullArr.buffer };
        }
        
        return { buffer: fullArr, mimeType };
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
        if (!pageId) {
            const keys = Object.keys(this.data.pages);
            if (keys.length === 0) throw new Error("No pages available to render.");
            pageId = keys[0];
        }
        
        return await generateImage(this, pageId, options);
    }
}
