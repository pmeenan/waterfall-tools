/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { Netlog, normalizeNetlogToHAR } from './netlog.js';
import { buildWaterfallDataFromHar } from '../core/har-converter.js';

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

    const onProgress = options.onProgress || (() => {});
    const totalBytes = options.totalBytes || 0;

    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import(/* @vite-ignore */ 'node:fs');

            const header = new Uint8Array(2);
            try {
                const fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }

            isGz = isGzip(header);

            // Only peek if wrapper state isn't explicitly passed.
            // When called via the Conductor/orchestrator, hasTraceEventsWrapper is already
            // detected during format sniffing. This path only fires from standalone CLI usage.
            if (options.hasTraceEventsWrapper === undefined) {
                const { Readable } = await import(/* @vite-ignore */ 'node:stream');
                let peekFsStream = fs.createReadStream(input);
                let peekWebStream = Readable.toWeb(peekFsStream);
                if (isGz) {
                    peekWebStream = peekWebStream.pipeThrough(new DecompressionStream('gzip'));
                }
                const peekReader = peekWebStream.pipeThrough(new TextDecoderStream()).getReader();
                let prefix = '';
                try {
                    while (prefix.length < 30) {
                        const { done, value } = await peekReader.read();
                        if (done) break;
                        prefix += value;
                    }
                } finally {
                    try { peekReader.cancel(); } catch (e) {}
                    peekFsStream.destroy();
                }
                hasTraceEventsWrapper = prefix.replace(/\s/g, '').startsWith('{"traceEvents":');
            }

            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
            nodeFsStream = fs.createReadStream(input);
            stream = Readable.toWeb(nodeFsStream);
        }

        if (isGz) {
            stream = stream.pipeThrough(new DecompressionStream('gzip'));
        }

        const netlog = new Netlog();
        const timeline_requests = {};
        const main_thread_events = []; // For advanced UI timeline visualizations
        
        let start_time = null;
        let marked_start_time = null;
        let pageTimings = { onLoad: -1, onContentLoad: -1, _startRender: -1 };
        let custom_user_marks = {};

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
                        if (start_time !== null) pageTimings.onContentLoad = trace_event.ts;
                    }
                    if (name.includes('loadEventStart') || name === 'load') {
                        if (start_time !== null) pageTimings.onLoad = trace_event.ts;
                    }
                    if (name.includes('firstContentfulPaint') || name === 'firstContentfulPaint') {
                        if (start_time !== null) {
                            pageTimings._startRender = trace_event.ts;
                            pageTimings._firstContentfulPaint = trace_event.ts;
                        }
                    }
                    if (name.includes('largestContentfulPaint::Candidate') || name === 'largestContentfulPaint::Candidate') {
                        if (start_time !== null) pageTimings._LargestContentfulPaint = trace_event.ts;
                    }
                    if (name === 'LayoutShift' && trace_event.args && trace_event.args.data && trace_event.args.data.score) {
                        pageTimings._CumulativeLayoutShift = (pageTimings._CumulativeLayoutShift || 0) + trace_event.args.data.score;
                    }
                    // Capture generic user marks (usually blink.user_timing)
                    if (cat.includes('blink.user_timing') && start_time !== null && trace_event.ts >= start_time) {
                        const standardIgnores = new Set(['navigationStart', 'domContentLoadedEventStart', 'domContentLoaded', 'loadEventStart', 'load', 'firstContentfulPaint', 'firstPaint', 'largestContentfulPaint::Candidate']);
                        if (!standardIgnores.has(name) && !name.startsWith('requestStart')) {
                            // Only capture instantaneous Marks (phase 'R', 'I' or just simple markers) or Starts
                            if (trace_event.ph === 'R' || trace_event.ph === 'I' || trace_event.ph === 'b') {
                                custom_user_marks[name] = trace_event.ts;
                            }
                        }
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
                            
                            if (data.headers) {
                                req.request_headers = [];
                                if (Array.isArray(data.headers)) {
                                    for (const h of data.headers) {
                                        req.request_headers.push(`${h.name}: ${h.value}`);
                                    }
                                } else {
                                    for (const [k, v] of Object.entries(data.headers)) {
                                        req.request_headers.push(`${k}: ${v}`);
                                    }
                                }
                            }
                        } else if (name === 'ResourceReceiveResponse' && data) {
                            if (data.statusCode) req.status = data.statusCode;
                            if (data.mimeType) req.mimeType = data.mimeType;
                            if (data.protocol) req.protocol = data.protocol;
                            
                            if (data.headers) {
                                req.response_headers = [];
                                if (Array.isArray(data.headers)) {
                                    for (const h of data.headers) {
                                        req.response_headers.push(`${h.name}: ${h.value}`);
                                    }
                                } else {
                                    for (const [k, v] of Object.entries(data.headers)) {
                                        req.response_headers.push(`${k}: ${v}`);
                                    }
                                }
                            }
                            
                            if (data.timing) {
                                req.timing = data.timing;
                                // Fallback wall-clock extraction removed to natively protect trace_event.ts monotonic scaling cleanly.
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
                
                // 4. Main Thread Activity extraction
                // `dur` is natively present on Complete (Ph: "X") events in micro-seconds natively
                if ((cat === 'toplevel' || cat.includes('devtools.timeline') || cat.includes('v8') || cat.includes('blink')) && (trace_event.dur > 0 || trace_event.ph === 'X')) {
                    if (trace_event.ts >= 0 && trace_event.name && !trace_event.name.includes('Resource')) {
                        main_thread_events.push({
                            _raw_ts: trace_event.ts,
                            duration: trace_event.dur / 1000.0, // Convert us to ms
                            source: trace_event.name
                        });
                    }
                }
            } catch (e) {
                // Ignore single event errors
            }
        };
        
        const pipeline = stream.pipeThrough(new TextDecoderStream());
        reader = pipeline.getReader();

        onProgress('Parsing trace...', 0);
        let bytesRead = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesRead += value.length;
            parser.write(value);
            if (totalBytes > 0) onProgress('Parsing trace...', Math.round((bytesRead / totalBytes) * 80));
        }
        onProgress('Processing events...', 80);
        if (options.debug) console.log(`[chrome-trace.js] Finished reading stream stream.`);

        const results = netlog.postProcessEvents();
        let requests = results ? (results.requests || []) : [];
        let unlinked_sockets = results ? (results.unlinked_sockets || []) : [];
        let unlinked_dns = results ? (results.unlinked_dns || []) : [];
        
        // Correct massive divergence offsets where Perfetto maps timeline threads natively as Epoch but network threads as Monotonic Uptime natively.
        let timeline_epoch_offset_ms = 0;
        for (const tl of Object.values(timeline_requests)) {
             if (tl.requestTime !== undefined && tl.timing && tl.timing.requestTime) {
                 const opaqueMs = tl.timing.requestTime * 1000.0;
                 const diffMs = opaqueMs - tl.requestTime;
                 if (Math.abs(diffMs) > 60000) { timeline_epoch_offset_ms = diffMs; }
                 break;
             }
        }
        
        if (timeline_epoch_offset_ms !== 0) {
            for (const [reqId, tl_req] of Object.entries(timeline_requests)) {
                // The base bounds (requestTime, finishTime) are already correctly zero-indexed.
                // The inner `timing` block natively preserves the massive OS clock string in args.
                // Thus, we subtract the massive diff to zero-index the inner timing array natively.
                if (tl_req.timing && tl_req.timing.requestTime) {
                    tl_req.timing.requestTime -= (timeline_epoch_offset_ms / 1000.0);
                }
                
                // DevTools natively stamps `finishTime` as monotonic uptime bounds exactly mirroring timeline alignments natively
                if (tl_req.finishTime && tl_req.finishTime > 10000000) {
                     tl_req.finishTime -= timeline_epoch_offset_ms;
                }
            }
        }

        let base_time_microseconds = Number.MAX_VALUE;
        if (start_time !== null && start_time < base_time_microseconds) base_time_microseconds = start_time;
        if (results && results.start_time !== undefined && results.start_time < base_time_microseconds) base_time_microseconds = results.start_time;
        for (const tl of Object.values(timeline_requests)) {
            if (tl.requestTime !== undefined && (tl.requestTime * 1000.0) < base_time_microseconds) base_time_microseconds = tl.requestTime * 1000.0;
            if (tl.timing && tl.timing.requestTime && (tl.timing.requestTime * 1000000.0) < base_time_microseconds) base_time_microseconds = tl.timing.requestTime * 1000000.0;
        }
        if (base_time_microseconds === Number.MAX_VALUE) base_time_microseconds = 0;

        let final_start_time = base_time_microseconds / 1000.0;

        // Apply monotonic-to-epoch offset if we extracted one from HTTP date headers.
        // Chrome traces use CLOCK_MONOTONIC (system uptime) for timestamps. To produce
        // valid absolute epoch values we need a mapping from monotonic → real time.
        // The netlog parser extracts this from the first HTTP "date:" response header.
        if (final_start_time < 946684800000) { // looks like monotonic, not epoch
            if (netlog.dateHeaderEpoch) {
                // dateHeaderEpoch.epochMs = real wall-clock ms when the date header was received
                // dateHeaderEpoch.monotonicMs = monotonic ms of that same event
                // final_start_time is in monotonic ms, so shift it to epoch ms
                const offsetMs = netlog.dateHeaderEpoch.epochMs - netlog.dateHeaderEpoch.monotonicMs;
                final_start_time = final_start_time + offsetMs;
            } else {
                // No date header found in the trace; fall back to Date.now() which will
                // produce non-deterministic absolute timestamps but keeps the relative
                // timing correct.
                final_start_time = Date.now();
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
                
                if ((!req.request_headers || req.request_headers.length === 0) && matched_timeline_req.request_headers && matched_timeline_req.request_headers.length > 0) {
                    req.request_headers = matched_timeline_req.request_headers;
                }
                if ((!req.response_headers || req.response_headers.length === 0) && matched_timeline_req.response_headers && matched_timeline_req.response_headers.length > 0) {
                    req.response_headers = matched_timeline_req.response_headers;
                }
            }
        }

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
                protocol: tl_req.protocol || '',
                status: tl_req.status || 0,
                priority: tl_req.priority || 'Lowest',
                renderBlocking: tl_req.renderBlocking,
                frame: tl_req.frame,
                initiator: tl_req.initiator,
                type: tl_req.resourceType,
                mimeType: tl_req.mimeType,
                bytesIn: tl_req.bytesIn || 0,
                request_headers: tl_req.request_headers || [],
                response_headers: tl_req.response_headers || []
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
            if (pageTimings.onLoad > 0) page.pageTimings.onLoad = (pageTimings.onLoad - base_time_microseconds) / 1000.0;
            if (pageTimings.onContentLoad > 0) page.pageTimings.onContentLoad = (pageTimings.onContentLoad - base_time_microseconds) / 1000.0;
            if (pageTimings._startRender > 0) page.pageTimings._startRender = (pageTimings._startRender - base_time_microseconds) / 1000.0;
            if (pageTimings._firstContentfulPaint > 0) page._firstContentfulPaint = (pageTimings._firstContentfulPaint - base_time_microseconds) / 1000.0;
            if (pageTimings._LargestContentfulPaint > 0) page._LargestContentfulPaint = (pageTimings._LargestContentfulPaint - base_time_microseconds) / 1000.0;
            if (pageTimings._CumulativeLayoutShift > 0) page._CumulativeLayoutShift = pageTimings._CumulativeLayoutShift;
            
            if (Object.keys(custom_user_marks).length > 0) {
                page._userTimes = {};
                for (const [evtName, evtTs] of Object.entries(custom_user_marks)) {
                    page._userTimes[evtName] = (evtTs - base_time_microseconds) / 1000.0;
                }
            }
            
            // Map main thread events securely
            page._mainThreadEvents = main_thread_events.map(evt => {
                const offset_time_ms = (evt._raw_ts - base_time_microseconds) / 1000.0;
                return {
                    time: final_start_time + offset_time_ms,
                    duration: evt.duration,
                    source: evt.source
                };
            }).filter(evt => evt.duration >= 0.1); // Discard ultra micro-events natively reducing bloat overhead
        }
        
        if (options.debug) console.log(`[chrome-trace.js] Finished applying HAR generation successfully.`);
        
        // Use statically imported buildWaterfallDataFromHar
        return buildWaterfallDataFromHar(har.log, 'chrome-trace');

    } catch (e) {
        throw e;
    } finally {
        if (reader) try { reader.releaseLock(); } catch (e) {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }
}
