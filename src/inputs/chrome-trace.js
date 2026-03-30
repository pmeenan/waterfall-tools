import { Netlog, normalizeNetlogToHAR } from './netlog.js';
const PRIORITY_MAP = {
    "VeryHigh": "Highest",
    "HIGHEST": "Highest",
    "MEDIUM": "High",
    "LOW": "Medium",
    "LOWEST": "Low",
    "IDLE": "Lowest",
    "VeryLow": "Lowest"
};

function isGzip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export async function processChromeTraceFileNode(input, options = {}) {
    const { JSONParser } = await import('@streamparser/json');

    let stream = input;
    let isGz = options.isGz === true;
    let hasTraceEventsWrapper = options.hasTraceEventsWrapper === true;
    let nodeFsStream = null;
    let reader = null;

    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import('node:fs');
            
            const header = new Uint8Array(2);
            let peekSource = fs.createReadStream(input);
            try {
                const fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }
            
            isGz = isGzip(header);
            
            // Only peek if wrapper state isn't explicitly passed
            if (options.hasTraceEventsWrapper === undefined) {
                let peekStream = peekSource;
                if (isGz) {
                    const zlib = await import('node:zlib');
                    peekStream = peekSource.pipe(zlib.createGunzip());
                }
                
                let prefix = await new Promise((res) => {
                    let result = '';
                    peekStream.on('error', () => {});
                    peekStream.on('data', (d) => {
                        result += d.toString('utf-8');
                        if (result.length > 20) {
                            peekStream.destroy();
                            peekSource.destroy();
                            res(result);
                        }
                    });
                    peekStream.on('end', () => {
                        peekSource.destroy();
                        res(result);
                    });
                });
                
                hasTraceEventsWrapper = prefix.replace(/\s/g, '').startsWith('{"traceEvents":');
            } else {
                peekSource.destroy();
            }
            
            const { Readable } = await import('node:stream');
            nodeFsStream = fs.createReadStream(input);
            stream = Readable.toWeb(nodeFsStream);
        }

        if (isGz) {
            stream = stream.pipeThrough(new DecompressionStream('gzip'));
        }

        const netlog = new Netlog();
        const timeline_requests = {};
        
        let start_time = null;
        let marked_start_time = null;
        let pageTimings = { onLoad: -1, onContentLoad: -1, _startRender: -1 };

        // Wall-clock epoch estimation: Chrome traces use CLOCK_MONOTONIC (system uptime)
        // for all ts values. We need a real UNIX epoch for HAR startedDateTime generation.
        // Strategy: extract the first HTTP "date:" response header from netlog events,
        // pair it with the monotonic ts at which the response was received, and compute
        // the offset (real_epoch_us - monotonic_ts_us). This offset converts any monotonic
        // timestamp to real wall-clock time.
        let monotonicToEpochOffsetUs = null; // microseconds: add to monotonic ts to get epoch

        const targetPaths = hasTraceEventsWrapper ? ['$.traceEvents.*'] : ['$.*'];
        const parser = new JSONParser({ paths: targetPaths, keepStack: false });

        parser.onValue = ({ value: trace_event }) => {
            try {
                if (trace_event.ts) trace_event.ts = parseInt(trace_event.ts);
                const cat = trace_event.cat || '';
                const name = trace_event.name || '';
                
                // 1. Process Netlog
                if (cat === 'netlog' || cat.includes('netlog')) {
                    netlog.addTraceEvent(trace_event);
                    
                    // Attempt wall-clock extraction from the first HTTP response "date:" header
                    // that appears in netlog HEADERS_RECEIVED events.
                    if (monotonicToEpochOffsetUs === null && trace_event.ts > 0 &&
                        trace_event.args && trace_event.args.params && trace_event.args.params.headers) {
                        const headers = trace_event.args.params.headers;
                        if (Array.isArray(headers)) {
                            for (const h of headers) {
                                if (typeof h === 'string' && h.toLowerCase().startsWith('date:')) {
                                    const dateVal = h.substring(5).trim();
                                    const parsed = Date.parse(dateVal);
                                    if (!isNaN(parsed) && parsed > 946684800000) { // sanity: after year 2000
                                        // parsed is real epoch in ms, trace_event.ts is monotonic in µs
                                        monotonicToEpochOffsetUs = (parsed * 1000) - trace_event.ts;
                                    }
                                    break;
                                }
                            }
                        }
                    }
                    return;
                }
                
                // 2. Process User Timings & Navigations
                if (cat.includes('blink.user_timing') || cat.includes('rail') || cat.includes('loading') || cat.includes('navigation')) {
                    if (marked_start_time === null && name.includes('navigationStart')) {
                        if (start_time === null || trace_event.ts < start_time) {
                            start_time = trace_event.ts;
                        }
                    }
                    if (name.includes('domContentLoadedEventStart') || name === 'domContentLoaded') {
                        if (start_time !== null) pageTimings.onContentLoad = (trace_event.ts - start_time) / 1000.0;
                    }
                    if (name.includes('loadEventStart') || name === 'load') {
                        if (start_time !== null) pageTimings.onLoad = (trace_event.ts - start_time) / 1000.0;
                    }
                    if (name.includes('firstContentfulPaint') || name === 'firstContentfulPaint') {
                        if (start_time !== null) pageTimings._startRender = (trace_event.ts - start_time) / 1000.0;
                    }
                }
                
                // 3. Process Timeline requests
                if (cat === 'devtools.timeline' || cat.includes('devtools.timeline') || cat.includes('blink.resource')) {
                    if (name === 'ResourceSendRequest' && trace_event.args && trace_event.args.data && trace_event.args.data.url === 'http://127.0.0.1:8888/wpt-start-recording') {
                        marked_start_time = trace_event.ts;
                        start_time = trace_event.ts;
                    }

                    let request_id = null;
                    if (trace_event.args && trace_event.args.data && trace_event.args.data.requestId) {
                        request_id = trace_event.args.data.requestId;
                    } else if (trace_event.args && trace_event.args.url) {
                        request_id = trace_event.args.url;
                    }
                    
                    if (request_id) {
                        if (!timeline_requests[request_id]) timeline_requests[request_id] = { bytesIn: 0 };
                        const req = timeline_requests[request_id];
                        
                        if (trace_event.args && trace_event.args.url) req.url = trace_event.args.url;
                        
                        const data = trace_event.args && trace_event.args.data ? trace_event.args.data : null;
                        
                        if (name === 'ResourceSendRequest' && data) {
                            req.requestTime = trace_event.ts / 1000.0;
                            if (data.priority) {
                                req.priority = data.priority;
                                if (PRIORITY_MAP[req.priority]) req.priority = PRIORITY_MAP[req.priority];
                            }
                            if (data.renderBlocking !== undefined) req.renderBlocking = data.renderBlocking;
                            if (data.frame) req.frame = data.frame;
                            if (data.url && !req.url) req.url = data.url;
                            if (data.requestMethod) req.method = data.requestMethod;
                            if (data.initiator) req.initiator = data.initiator;
                            if (data.resourceType) req.resourceType = data.resourceType;
                        } else if (name === 'ResourceReceiveResponse' && data) {
                            if (data.statusCode) req.status = data.statusCode;
                            if (data.mimeType) req.mimeType = data.mimeType;
                            if (data.headers) req.responseHeaders = data.headers;
                            if (data.timing) {
                                req.timing = data.timing;
                                // Fallback wall-clock extraction from devtools.timeline timing.requestTime
                                // timing.requestTime is in seconds from CLOCK_MONOTONIC
                                // We can also check response headers for a Date header here
                                if (monotonicToEpochOffsetUs === null && data.timing.requestTime > 0 && data.headers) {
                                    for (const hdr of Object.values(data.headers)) {
                                        if (typeof hdr === 'string' && (hdr.toLowerCase().startsWith('date:') || hdr.toLowerCase().startsWith('date'))) {
                                            const dateStr = hdr.replace(/^date:\s*/i, '').trim();
                                            const parsed = Date.parse(dateStr);
                                            if (!isNaN(parsed) && parsed > 946684800000) {
                                                // timing.requestTime is in seconds, convert to µs
                                                monotonicToEpochOffsetUs = (parsed * 1000) - (data.timing.requestTime * 1000000);
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                        } else if (name === 'ResourceReceivedData' && data) {
                            if (data.encodedDataLength) req.bytesIn += data.encodedDataLength;
                        } else if (name === 'ResourceFinish' && data) {
                            if (data.encodedDataLength && req.bytesIn === 0) req.bytesIn = data.encodedDataLength;
                            req.finishTime = data.finishTime ? data.finishTime * 1000 : trace_event.ts / 1000.0;
                        } else if (name === 'Network.requestIntercepted' && data && data.overwrittenURL) {
                            req.overwrittenURL = data.overwrittenURL;
                        }
                    }
                }
            } catch (e) {
                // Ignore single event errors
            }
        };
        
        const pipeline = stream.pipeThrough(new TextDecoderStream());
        reader = pipeline.getReader();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.write(value);
        }
        if (options.debug) console.log(`[chrome-trace.js] Finished reading stream stream.`);

        const results = netlog.postProcessEvents();
        let requests = results ? (results.requests || []) : [];
        let unlinked_sockets = results ? (results.unlinked_sockets || []) : [];
        let unlinked_dns = results ? (results.unlinked_dns || []) : [];
        
        let offset = 0;
        if (results && results.start_time !== undefined && start_time !== null) {
            offset = results.start_time - start_time;
        }

        if (offset !== 0 && requests.length > 0) {
            const times = ['dns_start', 'dns_end', 'connect_start', 'connect_end', 'ssl_start', 'ssl_end', 'start', 'created', 'first_byte', 'end'];
            for (const req of requests) {
                for (const tname of times) {
                    if (req[tname] !== undefined) req[tname] += offset;
                }
            }
        }
        
        // final_start_time is in MILLISECONDS (from microsecond start_time / 1000)
        // But it's still in monotonic time. We need to convert to real epoch.
        let final_start_time = (start_time !== null) ? (start_time / 1000.0) : ((results && results.start_time !== undefined) ? (results.start_time / 1000.0) : 0);

        // Apply monotonic-to-epoch offset if we extracted one from HTTP date headers.
        // monotonicToEpochOffsetUs is in microseconds. Convert us -> ms and add to final_start_time.
        if (monotonicToEpochOffsetUs !== null) {
            final_start_time += monotonicToEpochOffsetUs / 1000.0;
            if (options.debug) console.log(`[chrome-trace.js] Applied monotonic-to-epoch offset: ${monotonicToEpochOffsetUs} µs. Epoch start: ${new Date(final_start_time).toISOString()}`);
        } else {
            // Fallback: use Date.now() as an approximation. The relative timings will be correct
            // but absolute wall-clock dates will be approximate.
            if (final_start_time < 946684800000) { // looks like monotonic, not epoch
                const now = Date.now();
                if (options.debug) console.log(`[chrome-trace.js] No wall-clock reference found. Using Date.now() as epoch approximation.`);
                final_start_time = now;
            }
        }

        // Create a quick lookup for timeline requests by URL
        const timeline_by_url = new Map();
        for (const tl_req of Object.values(timeline_requests)) {
            if (tl_req.url) timeline_by_url.set(tl_req.url, tl_req);
            if (tl_req.overwrittenURL) timeline_by_url.set(tl_req.overwrittenURL, tl_req);
        }

        // Augment netlog requests with timeline data and mark as matched
        for (const req of requests) {
            if (!req.url) continue;
            const matched_timeline_req = timeline_by_url.get(req.url);
            
            if (matched_timeline_req) {
                matched_timeline_req._matched = true;
                if (matched_timeline_req.priority && !req.priority) req.priority = matched_timeline_req.priority;
                if (matched_timeline_req.renderBlocking !== undefined) req.renderBlocking = matched_timeline_req.renderBlocking;
                if (matched_timeline_req.frame) req.frame = matched_timeline_req.frame;
                if (matched_timeline_req.initiator) req.initiator = matched_timeline_req.initiator;
                if (req.type === undefined && matched_timeline_req.resourceType) req.type = matched_timeline_req.resourceType;
                if ((!req.bytesIn || req.bytesIn === 0) && matched_timeline_req.bytesIn) req.bytesIn = matched_timeline_req.bytesIn;
                if (!req.mimeType && matched_timeline_req.mimeType) req.mimeType = matched_timeline_req.mimeType;
            }
        }

        // Determine base_time in microseconds natively allowing fallback loop subtraction
        let base_time_microseconds = (start_time !== null) ? start_time : ((results && results.start_time !== undefined) ? results.start_time : 0);

        if (base_time_microseconds === 0) {
            let earliest_ms = Number.MAX_VALUE;
            for (const tl of Object.values(timeline_requests)) {
                if (tl.requestTime !== undefined && tl.requestTime < earliest_ms) {
                    earliest_ms = tl.requestTime; // in MILLISECONDS
                }
            }
            if (earliest_ms !== Number.MAX_VALUE) {
                base_time_microseconds = earliest_ms * 1000.0; // scale back to MICROSECONDS
                final_start_time = earliest_ms; // map back for HAR entries natively
                
                // Critical step: If netlog events bypassed absolute start_time subtraction earlier
                // due to start_time missing from raw chunks, apply the subtracted base fallback now
                for (const req of requests) {
                    const times = ['dns_start', 'dns_end', 'connect_start', 'connect_end', 'ssl_start', 'ssl_end', 'start', 'created', 'first_byte', 'end'];
                    for (const tname of times) {
                        if (req[tname] !== undefined) req[tname] -= base_time_microseconds;
                    }
                    if (req.chunks_in) {
                        for (const chunk of req.chunks_in) {
                            chunk.ts -= base_time_microseconds;
                        }
                    }
                    if (req.chunks_out) {
                        for (const chunk of req.chunks_out) {
                            chunk.ts -= base_time_microseconds;
                        }
                    }
                }
            }
        }

        // Synthesize any devtools requests that missed matched netlog mapping paths cleanly
        for (const [reqId, tl_req] of Object.entries(timeline_requests)) {
            if (tl_req._matched) continue; // Already merged into a netlog request
            if (tl_req.requestTime === undefined) continue; // Prevent NaN propagation
            
            const r = {
                _id: reqId,
                netlog_id: reqId,
                url: tl_req.url,
                method: tl_req.method || 'GET',
                status: tl_req.status || 0,
                priority: tl_req.priority || 'Lowest',
                renderBlocking: tl_req.renderBlocking,
                frame: tl_req.frame,
                initiator: tl_req.initiator,
                type: tl_req.resourceType,
                mimeType: tl_req.mimeType,
                bytesIn: tl_req.bytesIn || 0,
                responseHeaders: tl_req.responseHeaders || []
            };
            
            // Expected bounds track strictly microsecond ranges relative to base arrays naturally.
            r.start = (tl_req.requestTime * 1000.0) - base_time_microseconds;
            r.end = ((tl_req.finishTime || tl_req.requestTime) * 1000.0) - base_time_microseconds;
            r.first_byte = r.end;
            
            if (tl_req.timing) {
                const rt = (tl_req.timing.requestTime * 1000000.0) - base_time_microseconds;
                r.start = rt;
                
                if (tl_req.timing.receiveHeadersEnd > 0) r.first_byte = rt + (tl_req.timing.receiveHeadersEnd * 1000.0);
                if (tl_req.timing.dnsStart >= 0) r.dns_start = rt + (tl_req.timing.dnsStart * 1000.0);
                if (tl_req.timing.dnsEnd >= 0) r.dns_end = rt + (tl_req.timing.dnsEnd * 1000.0);
                if (tl_req.timing.connectStart >= 0) r.connect_start = rt + (tl_req.timing.connectStart * 1000.0);
                if (tl_req.timing.connectEnd >= 0) r.connect_end = rt + (tl_req.timing.connectEnd * 1000.0);
                if (tl_req.timing.sslStart >= 0) r.ssl_start = rt + (tl_req.timing.sslStart * 1000.0);
                if (tl_req.timing.sslEnd >= 0) r.ssl_end = rt + (tl_req.timing.sslEnd * 1000.0);
            }
            
            requests.push(r);
        }
        
        if (options.debug) console.log(`[chrome-trace.js] Successfully normalized Netlog data. Synthesized ${requests.length} requests.`);

        // Scale ALL internal times from MICROSECONDS to MILLISECONDS since HAR mappings require ms natively.
        const scaleTimes = ['dns_start', 'dns_end', 'connect_start', 'connect_end', 'ssl_start', 'ssl_end', 'start', 'created', 'first_byte', 'end'];
        for (const req of requests) {
             for (const tname of scaleTimes) {
                 if (req[tname] !== undefined) req[tname] /= 1000.0;
             }
             if (req.chunks_in) { for (const c of req.chunks_in) if (c.ts !== undefined) c.ts /= 1000.0; }
             if (req.chunks_out) { for (const c of req.chunks_out) if (c.ts !== undefined) c.ts /= 1000.0; }
        }
        for (const s of unlinked_sockets) {
             for (const tname of scaleTimes) {
                 if (s[tname] !== undefined) s[tname] /= 1000.0;
             }
        }
        for (const d of unlinked_dns) {
             if (d.start !== undefined) d.start /= 1000.0;
             if (d.end !== undefined) d.end /= 1000.0;
        }

        // normalizeNetlogToHAR natively expects `run_start_epoch` in SECONDS
        // We divide `final_start_time` (ms) by 1000.0 to securely map it natively
        const har = normalizeNetlogToHAR(requests, unlinked_sockets, unlinked_dns, final_start_time / 1000.0);
        
        // Add minimal layout mapping overrides for Chrome trace
        if (har.log && har.log.pages.length > 0) {
            const page = har.log.pages[0];
            page.title = 'Chrome Trace Default View';
            if (!page.pageTimings) page.pageTimings = {};
            if (pageTimings.onLoad > 0) page.pageTimings.onLoad = pageTimings.onLoad;
            if (pageTimings.onContentLoad > 0) page.pageTimings.onContentLoad = pageTimings.onContentLoad;
            if (pageTimings._startRender > 0) page.pageTimings._startRender = pageTimings._startRender;
        }
        
        if (options.debug) console.log(`[chrome-trace.js] Finished applying HAR generation successfully.`);
        
        const { buildWaterfallDataFromHar } = await import('../core/har-converter.js');
        return buildWaterfallDataFromHar(har.log, 'chrome-trace');

    } catch (e) {
        throw e;
    } finally {
        if (reader) try { reader.releaseLock(); } catch (e) {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }
}
