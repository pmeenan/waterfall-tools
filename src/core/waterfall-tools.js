import { identifyFormat, identifyFormatFromBuffer, parsers } from '../inputs/orchestrator.js';
import { ZipReader } from '../inputs/utilities/zip.js';
import { cleanupOrphans } from '../platforms/storage.js';

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
     * Cleans up managed resources, dropping associated file handlers safely natively
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

        return await this.loadStream(stream, streamOptions);
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
        if (!this.data.pages[pageId]) return null;

        const page = JSON.parse(JSON.stringify(this.data.pages[pageId])); // deep copy baseline
        
        if (!options.includeRequests) {
            delete page.requests;
            return page;
        }

        if (page.requests) {
            // First, find the "owner" requests for each connection and DNS lookup
            const connectionMap = {}; // conn_id -> earliest request_id
            const dnsMap = {}; // dns_id -> earliest request_id
            
            for (const [reqId, req] of Object.entries(page.requests)) {
                // Ensure internal data map key matches specifically as interaction payload property natively
                if (req.id !== undefined && req.id !== reqId) {
                    req.srcId = req.id;
                }
                req.id = reqId;

                if (req.connection_id && (!connectionMap[req.connection_id] || req.time_start < connectionMap[req.connection_id].time)) {
                    connectionMap[req.connection_id] = { id: reqId, time: req.time_start };
                }
                if (req.dns_query_id && (!dnsMap[req.dns_query_id] || req.time_start < dnsMap[req.dns_query_id].time)) {
                    dnsMap[req.dns_query_id] = { id: reqId, time: req.time_start };
                }
            }

            for (const [reqId, req] of Object.entries(page.requests)) {
                // Determine explicit bindings
                const isConnOwner = req.connection_id && connectionMap[req.connection_id]?.id === reqId;
                const isDnsOwner = req.dns_query_id && dnsMap[req.dns_query_id]?.id === reqId;

                req.timings = { dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 };
                
                let connObj = null;
                if (req.connection_id) {
                    if (this.data.tcp_connections && this.data.tcp_connections[req.connection_id]) {
                        connObj = this.data.tcp_connections[req.connection_id];
                    } else if (this.data.quic_connections && this.data.quic_connections[req.connection_id]) {
                        connObj = this.data.quic_connections[req.connection_id];
                    }
                }

                let dnsObj = null;
                if (req.dns_query_id && this.data.dns && this.data.dns[req.dns_query_id]) {
                    dnsObj = this.data.dns[req.dns_query_id];
                }

                if (isDnsOwner && dnsObj && dnsObj.end_time >= dnsObj.start_time) {
                    req.timings.dns = dnsObj.end_time - dnsObj.start_time;
                }

                if (isConnOwner && connObj && connObj.end_time >= connObj.start_time) {
                    req.timings.connect = connObj.end_time - connObj.start_time;
                    if (connObj.tls && connObj.tls.start_time) {
                        req.timings.ssl = Math.max(0, connObj.end_time - connObj.tls.start_time);
                    }
                }

                // Standard Wait / Receive Phase
                let reqTimeStartMs = req.time_start;
                let firstDataMs = req.first_data_time > 0 ? req.first_data_time : req.time_end;
                let lastDataMs = req.time_end;

                req.timings.wait = Math.max(0, firstDataMs - reqTimeStartMs);
                req.timings.receive = Math.max(0, lastDataMs - firstDataMs);

                // Additional flattened metadata for renderer parity
                if (dnsObj && isDnsOwner) {
                    req._dnsTimeMs = dnsObj.start_time;
                    req._dnsEndTimeMs = dnsObj.end_time;
                }
                
                if (connObj && isConnOwner) {
                    req._connectTimeMs = connObj.start_time;
                    req._connectEndTimeMs = connObj.end_time;
                    if (connObj.tls && connObj.tls.start_time) {
                        req._sslStartTimeMs = connObj.tls.start_time;
                    }
                }

                // Copy stream data if any mapping resolves
                if (req.stream_id && connObj && connObj.streams && connObj.streams[req.stream_id]) {
                    req._stream = connObj.streams[req.stream_id];
                }
            }
        }
        
        return page;
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
        
        console.log(`[getPageResource] Evaluated mapping bounds for ${pageId} - Run: ${pageData._run}, Cached: ${pageData._cached}`);

        if (resourceType === 'screenshot' && pageData._screenshot) {
            const str = pageData._screenshot;
            if (str.startsWith('data:image/')) {
                return { url: str, mimeType: str.substring(5, str.indexOf(';')) };
            } else {
                const url = `data:image/jpeg;base64,${str}`;
                return { url, mimeType: 'image/jpeg' };
            }
        }

        if (!this.data._opfsStorage || !this.data._zipFiles) {
            console.warn(`[getPageResource] Aborting: Missing _opfsStorage (${!!this.data._opfsStorage}) or _zipFiles (${!!this.data._zipFiles})`);
            return null;
        }

        const runNum = pageData._run || '1';
        const cachedStr = pageData._cached ? '_Cached' : '';

        let targetFile = null;
        let mimeType = 'application/octet-stream';

        if (resourceType === 'screenshot') {
            const jpgFile = `${runNum}${cachedStr}_screen.jpg`;
            const pngFile = `${runNum}${cachedStr}_screen.png`;
            console.log(`[getPageResource] Searching archive for '${jpgFile}' or '${pngFile}'`);
            targetFile = this.data._zipFiles.find(f => f === jpgFile || f.endsWith(`/${jpgFile}`));
            mimeType = 'image/jpeg';
            if (!targetFile) {
                targetFile = this.data._zipFiles.find(f => f === pngFile || f.endsWith(`/${pngFile}`));
                if (targetFile) mimeType = 'image/png';
            }
            console.log(`[getPageResource] Found targetFile mapping natively:`, targetFile || 'null');
        } else if (resourceType === 'trace') {
            const traceFile = `${runNum}${cachedStr}_trace.json.gz`;
            targetFile = this.data._zipFiles.find(f => f === traceFile || f.endsWith(`/${traceFile}`));
            mimeType = 'application/json';
        } else if (resourceType === 'netlog') {
            const netlogFile = `${runNum}${cachedStr}_netlog.json.gz`;
            targetFile = this.data._zipFiles.find(f => f === netlogFile || f.endsWith(`/${netlogFile}`));
            mimeType = 'application/json';
        } else if (resourceType === 'tcpdump') {
            const pcapFile = `${runNum}${cachedStr}_tcpdump.cap.gz`;
            targetFile = this.data._zipFiles.find(f => f === pcapFile || f.endsWith(`/${pcapFile}`));
            mimeType = 'application/vnd.tcpdump.pcap';
        } else if (resourceType === 'lighthouse') {
            const lhFile = `${runNum}${cachedStr}_lighthouse.html`;
            targetFile = this.data._zipFiles.find(f => f === lhFile || f.endsWith(`/${lhFile}`));
            mimeType = 'text/html';
        }

        if (!targetFile) {
            console.warn(`[getPageResource] Resource file not found in ZIP array for ${pageId}`);
            return null;
        }

        const zip = new ZipReader(this.data._opfsStorage);
        await zip.init();
        console.log(`[getPageResource] zip init resolved. fetching stream for ${targetFile}`);
        const stream = await zip.getFileStream(targetFile);
        if (!stream) {
            console.warn(`[getPageResource] getFileStream returned null for target: ${targetFile}`);
            return null;
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
        
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
            const blob = new Blob(chunks, { type: mimeType });
            return { url: URL.createObjectURL(blob), mimeType };
        }
        
        const fullArr = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
            fullArr.set(c, offset);
            offset += c.length;
        }
        
        return { buffer: fullArr, mimeType };
    }

    /**
     * Compiles standard Extended HAR 1.2 Format strictly derived from internal Relational mapping
     * @param {Object} options 
     */
    getHar(options = {}) {
        const pagesOut = [];
        const entriesOut = [];

        for (const [pageId, pData] of Object.entries(this.data.pages)) {
            const page = this.getPage(pageId, { includeRequests: true });
            
            let globalEarliestMs = Number.MAX_SAFE_INTEGER;
            if (page.requests) {
                for (const req of Object.values(page.requests)) {
                    if (req.time_start > 0 && req.time_start < globalEarliestMs) globalEarliestMs = req.time_start;
                    if (req._dnsTimeMs > 0 && req._dnsTimeMs < globalEarliestMs) globalEarliestMs = req._dnsTimeMs;
                    if (req._connectTimeMs > 0 && req._connectTimeMs < globalEarliestMs) globalEarliestMs = req._connectTimeMs;
                }
            }

            // Bind explicitly
            if (globalEarliestMs === Number.MAX_SAFE_INTEGER) {
                globalEarliestMs = pData.startedDateTime ? new Date(pData.startedDateTime).getTime() : Date.now();
            }

            const pageOut = {
                id: pageId,
                title: page.title || page.url,
                startedDateTime: new Date(globalEarliestMs).toISOString(),
                pageTimings: page.pageTimings || {}
            };

            for (const key of Object.keys(pData)) {
                if (key.startsWith('_')) {
                    pageOut[key] = pData[key];
                }
            }

            pagesOut.push(pageOut);

            if (page.requests) {
                const reqArray = Object.values(page.requests);
                reqArray.sort((a, b) => a.time_start - b.time_start);

                for (const req of reqArray) {
                    
                    let timeTotal = 0;
                    if (req.timings.dns > 0) timeTotal += req.timings.dns;
                    if (req.timings.connect > 0) timeTotal += req.timings.connect;
                    timeTotal += req.timings.wait;
                    timeTotal += req.timings.receive;

                    const entry = {
                        startedDateTime: new Date(req.time_start).toISOString(),
                        time: timeTotal,
                        pageref: pageId,
                        request: {
                            method: req.method || 'GET',
                            url: req.url || '',
                            httpVersion: req.httpVersion || 'HTTP/1.1',
                            cookies: [],
                            headers: req.headers || [],
                            queryString: [],
                            headersSize: -1,
                            bodySize: -1
                        },
                        response: {
                            status: req.status || 200,
                            statusText: req.statusText || '',
                            httpVersion: req.httpVersion || 'HTTP/1.1',
                            cookies: [],
                            headers: req.responseHeaders || [],
                            content: {
                                size: req.bytes_in || 0,
                                mimeType: req.mimeType || '',
                                compression: 0
                            },
                            redirectURL: "",
                            headersSize: -1,
                            bodySize: req.bytes_in || 0
                        },
                        cache: {},
                        timings: Object.assign({}, req.timings),
                        serverIPAddress: req.serverIp || '',
                        connection: req.connection_id ? req.connection_id.toString() : '',
                    };

                    // Intelligently map any trailing custom properties defined by parser outputs explicitly
                    for (const key of Object.keys(req)) {
                        if (key.startsWith('_') && entry[key] === undefined) {
                            entry[key] = req[key];
                        }
                    }

                    // WebPageTest compatibility tracking
                    if (req.time_start > 0) entry._load_start = Math.floor(req.time_start - globalEarliestMs);
                    if (req._dnsTimeMs > 0) entry._dns_start = Math.floor(req._dnsTimeMs - globalEarliestMs);
                    if (req._dnsEndTimeMs > 0) entry._dns_end = Math.floor(req._dnsEndTimeMs - globalEarliestMs);
                    if (req._connectTimeMs > 0) entry._connect_start = Math.floor(req._connectTimeMs - globalEarliestMs);
                    if (req._connectEndTimeMs > 0) entry._connect_end = Math.floor(req._connectEndTimeMs - globalEarliestMs);
                    if (req._sslStartTimeMs > 0) entry._ssl_start = Math.floor(req._sslStartTimeMs - globalEarliestMs);
                    if (req.time_start > 0 && req.timings.ssl > 0) entry._ssl_end = entry._load_start;
                    if (req.time_start > 0) entry._ttfb_start = entry._load_start;
                    if (req.first_data_time > 0) entry._ttfb_end = Math.floor(req.first_data_time - globalEarliestMs);
                    if (req.first_data_time > 0) entry._download_start = entry._ttfb_end;
                    if (req.time_end > 0) {
                        entry._download_end = Math.floor(req.time_end - globalEarliestMs);
                        entry._all_end = entry._download_end;
                    }
                    
                    entriesOut.push(entry);
                }
            }
        }

        return {
            log: {
                version: "1.2",
                creator: {
                    name: "waterfall-tools",
                    version: "0.2.0"
                },
                pages: pagesOut,
                entries: entriesOut
            }
        };
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
            showCpu: false,
            showBw: false,
            showMainthread: true,
            showLongtasks: true,
            showMissing: false,
            showLabels: true,
            showChunks: true,
            showJsTiming: true,
            showWait: true,
            showLegend: true
        };
    }

    async renderTo(container, options = {}) {
        // Dynamically load browser-only render implementations keeping Node targets pure
        const { WaterfallCanvas } = await import('../renderer/canvas.js');
        
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
}
