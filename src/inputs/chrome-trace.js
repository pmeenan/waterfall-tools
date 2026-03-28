import fs from 'node:fs';
import zlib from 'node:zlib';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { pick } from 'stream-json/filters/pick.js';
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

export async function processChromeTraceFileNode(filePath) {
    return new Promise(async (resolve, reject) => {
        let rs = fs.createReadStream(filePath, { start: 0, end: 1024 });
        
        const header = Buffer.alloc(2);
        let fd;
        try {
            fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, header, 0, 2, 0);
            fs.closeSync(fd);
        } catch (e) {
            return reject(e);
        }
        
        const isGz = isGzip(header);
        
        let peekSource = fs.createReadStream(filePath);
        let peekStream = peekSource;
        if (isGz) peekStream = peekSource.pipe(zlib.createGunzip());
        
        let prefix = await new Promise((resolve) => {
            let result = '';
            peekStream.on('error', () => {});
            peekStream.on('data', (d) => {
                result += d.toString('utf-8');
                if (result.length > 20) {
                    peekStream.destroy();
                    peekSource.destroy();
                    resolve(result);
                }
            });
            peekStream.on('end', () => {
                peekSource.destroy();
                resolve(result);
            });
        });
        
        let hasTraceEventsWrapper = prefix.replace(/\s/g, '').startsWith('{"traceEvents":');
        
        const fileStream = fs.createReadStream(filePath);
        let readStream = fileStream;
        if (isGz) {
            readStream = fileStream.pipe(zlib.createGunzip());
        }

        const netlog = new Netlog();
        const timeline_requests = {};
        
        let start_time = null;
        let marked_start_time = null;
        let pageTimings = { onLoad: -1, onContentLoad: -1, _startRender: -1 };

        let pipelineArgs = [readStream, parser()];
        if (hasTraceEventsWrapper) {
            pipelineArgs.push(pick({filter: 'traceEvents'}));
        }
        pipelineArgs.push(streamArray());

        const pipeline = chain(pipelineArgs);

        pipeline.on('data', ({ value: trace_event }) => {
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
                            if (data.timing) req.timing = data.timing;
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
        });

        pipeline.on('error', (err) => {
            reject(err);
        });

        pipeline.on('end', () => {
            try {
                const results = netlog.postProcessEvents();
                let requests = results ? (results.requests || []) : [];
                let unlinked_sockets = results ? (results.unlinked_sockets || []) : [];
                let unlinked_dns = results ? (results.unlinked_dns || []) : [];
                
                let final_start_time = (start_time !== null) ? start_time / 1000.0 : (results && results.start_time !== undefined ? results.start_time : 0);
                
                let offset = 0;
                if (results && results.start_time !== undefined && start_time !== null) {
                    offset = results.start_time - (start_time / 1000.0);
                }

                if (offset !== 0) {
                    const times = ['dns_start', 'dns_end', 'connect_start', 'connect_end', 'ssl_start', 'ssl_end', 'start', 'created', 'first_byte', 'end'];
                    for (const req of requests) {
                        for (const tname of times) {
                            if (req[tname] !== undefined) req[tname] += offset;
                        }
                    }
                }
                
                // Create a quick lookup for timeline requests by URL
                const timeline_by_url = new Map();
                for (const tl_req of Object.values(timeline_requests)) {
                    if (tl_req.url) timeline_by_url.set(tl_req.url, tl_req);
                    if (tl_req.overwrittenURL) timeline_by_url.set(tl_req.overwrittenURL, tl_req);
                }

                // Augment netlog requests with timeline data
                for (const req of requests) {
                    if (!req.url) continue;
                    const matched_timeline_req = timeline_by_url.get(req.url);
                    
                    if (matched_timeline_req) {
                        if (matched_timeline_req.priority && !req.priority) req.priority = matched_timeline_req.priority;
                        if (matched_timeline_req.renderBlocking !== undefined) req.renderBlocking = matched_timeline_req.renderBlocking;
                        if (matched_timeline_req.frame) req.frame = matched_timeline_req.frame;
                        if (matched_timeline_req.initiator) req.initiator = matched_timeline_req.initiator;
                        if (req.type === undefined && matched_timeline_req.resourceType) req.type = matched_timeline_req.resourceType;
                        if ((!req.bytesIn || req.bytesIn === 0) && matched_timeline_req.bytesIn) req.bytesIn = matched_timeline_req.bytesIn;
                        if (!req.mimeType && matched_timeline_req.mimeType) req.mimeType = matched_timeline_req.mimeType;
                    }
                }

                // If netlog events were entirely missing, synthesize the layout from timeline fallback
                if (requests.length === 0) {
                    for (const tl_req of Object.values(timeline_requests)) {
                        if (!tl_req.url || (!tl_req.url.startsWith('http') && !tl_req.url.startsWith('ws'))) continue;
                        let r = {
                            url: tl_req.overwrittenURL || tl_req.url,
                            method: tl_req.method || 'GET',
                            status: tl_req.status || 200,
                            bytesIn: tl_req.bytesIn || 0,
                            responseHeaders: tl_req.responseHeaders,
                            priority: tl_req.priority,
                            renderBlocking: tl_req.renderBlocking,
                            frame: tl_req.frame,
                            initiator: tl_req.initiator,
                            type: tl_req.resourceType,
                            mimeType: tl_req.mimeType
                        };
                        r.start = tl_req.requestTime;
                        r.end = tl_req.finishTime || tl_req.requestTime;
                        r.first_byte = r.end;
                        
                        if (tl_req.timing) {
                            const rt = tl_req.timing.requestTime * 1000.0; 
                            r.start = rt;
                            if (tl_req.timing.receiveHeadersEnd > 0) r.first_byte = rt + tl_req.timing.receiveHeadersEnd;
                            if (tl_req.timing.dnsStart >= 0) r.dns_start = rt + tl_req.timing.dnsStart;
                            if (tl_req.timing.dnsEnd >= 0) r.dns_end = rt + tl_req.timing.dnsEnd;
                            if (tl_req.timing.connectStart >= 0) r.connect_start = rt + tl_req.timing.connectStart;
                            if (tl_req.timing.connectEnd >= 0) r.connect_end = rt + tl_req.timing.connectEnd;
                            if (tl_req.timing.sslStart >= 0) r.ssl_start = rt + tl_req.timing.sslStart;
                            if (tl_req.timing.sslEnd >= 0) r.ssl_end = rt + tl_req.timing.sslEnd;
                        }
                        requests.push(r);
                    }
                    
                    // Synthesized requests are currently stamped using absolute timestamp bases (milliseconds).
                    // We need to apply 'offset' the same way netlog's absolute timestamp mode handles offsets internally if required.
                    // Wait, our loop earlier for `offset !== 0` applies to all `requests`, but we pushed to `requests` AFTER that loop!
                    // Let's re-run offset adjustments on the newly synthesized requests here if final_start_time is adjusted.
                    if (offset !== 0) {
                        const times = ['dns_start', 'dns_end', 'connect_start', 'connect_end', 'ssl_start', 'ssl_end', 'start', 'created', 'first_byte', 'end'];
                        for (const req of requests) {
                            for (const tname of times) {
                                if (req[tname] !== undefined) req[tname] += offset;
                            }
                        }
                    }
                }

                const har = normalizeNetlogToHAR(requests, unlinked_sockets, unlinked_dns, final_start_time);
                
                if (har.log && har.log.pages && har.log.pages.length > 0) {
                    const page = har.log.pages[0];
                    page.title = 'Chrome Trace Default View';
                    if (pageTimings.onLoad > 0) page.pageTimings.onLoad = pageTimings.onLoad;
                    if (pageTimings.onContentLoad > 0) page.pageTimings.onContentLoad = pageTimings.onContentLoad;
                    if (pageTimings._startRender > 0) page.pageTimings._startRender = pageTimings._startRender;
                }
                
                resolve(har);
            } catch (err) {
                reject(err);
            }
        });
    });
}
