/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { JSONParser } from '@streamparser/json';
import { buildWaterfallDataFromHar } from '../core/har-converter.js';
import { normalizeWPT } from './wpt-json.js';

const PRIORITY_MAP = {
    "VeryHigh": "Highest",
    "HIGHEST": "Highest",
    "MEDIUM": "High",
    "LOW": "Medium",
    "LOWEST": "Low",
    "IDLE": "Lowest",
    "VeryLow": "Lowest"
};

class DevToolsParser {
    constructor() {
        this.result = { pageData: {}, requests: [] };
        this.script_ids = {};
        this.request_ids = {};
        this.noheaders = false;
    }

    process(raw_events) {
        const { net_requests, page_data } = this.extract_net_requests(raw_events);
        if (net_requests.length || Object.keys(page_data).length) {
            this.process_requests(net_requests, page_data);
        }
        
        // Return matching format to WPT-json normalizer natively
        return this.result;
    }

    merge_devtools_headers(headers, devtools_headers) {
        // Port merge_devtools_headers if we need it
        const result = { ...headers };
        for (const [key, value] of Object.entries(devtools_headers)) {
            let found = false;
            for (const h of Object.keys(result)) {
                if (h.toLowerCase() === key.toLowerCase()) {
                    result[h] = value;
                    found = true;
                    break;
                }
            }
            if (!found) {
                result[key] = value;
            }
        }
        return result;
    }

    extract_net_requests(raw_events) {
        let has_request_headers = false;
        let net_requests = [];
        let page_data = { endTime: 0 };
        let first_timestamp = null;
        let raw_requests = {};
        let extra_headers = {};
        let id_map = {};

        // To match Python script exactly, events are processed in order
        for (const raw_event of raw_events) {
            if (raw_event.method && raw_event.params) {
                const method = raw_event.method;
                const params = raw_event.params;
                let request_id = null;
                let original_id = null;

                if (params.requestId !== undefined) {
                    request_id = params.requestId;
                    original_id = request_id;
                    if (id_map[request_id] !== undefined) {
                        request_id += '-' + id_map[request_id];
                    }
                }

                if (method === 'Debugger.scriptParsed' && params.scriptId) {
                    const script_id = params.scriptId;
                    let script_url = null;
                    if (this.script_ids[script_id] === undefined) {
                        if (params.stackTrace && params.stackTrace.callFrames) {
                            for (const frame of params.stackTrace.callFrames) {
                                if (frame.url) {
                                    if (script_url === null) script_url = frame.url;
                                    if (frame.scriptId && this.script_ids[frame.scriptId] === undefined) {
                                        this.script_ids[frame.scriptId] = script_url;
                                    }
                                }
                            }
                        }
                        if (script_url === null && params.url) {
                            script_url = params.url;
                        }
                        if (script_url !== null) {
                            this.script_ids[script_id] = script_url;
                        }
                    }
                }

                if (method === 'Page.frameNavigated' && params.frame && params.frame.id && params.frame.parentId === undefined) {
                    page_data.main_frame = params.frame.id;
                }
                
                if (method === 'Network.requestServedFromCache' && params.requestId && request_id && raw_requests[request_id]) {
                    raw_requests[request_id].fromNet = false;
                    raw_requests[request_id].fromCache = true;
                }
                
                if (method === 'Network.requestIntercepted' && params.requestId && request_id && raw_requests[request_id]) {
                    if (params.__overwrittenURL) {
                        raw_requests[request_id].overwrittenURL = params._overwrittenURL;
                    }
                }

                if (first_timestamp === null && params.timestamp && method.startsWith('Network.requestWillBeSent')) {
                    first_timestamp = params.timestamp;
                }

                if (first_timestamp !== null && params.timestamp) {
                    if (params.timestamp >= first_timestamp) {
                        params.timestamp -= first_timestamp;
                        params.timestamp *= 1000.0;
                    } else {
                        continue;
                    }
                }

                if (method === 'Page.loadEventFired' && params.timestamp && 
                    (page_data.onload === undefined || params.timestamp > page_data.onload)) {
                    page_data.onload = params.timestamp;
                }

                if (request_id && method.indexOf('ExtraInfo') > 0) {
                    if (extra_headers[request_id] === undefined) extra_headers[request_id] = {};
                    const headers_entry = extra_headers[request_id];
                    if (method === 'Network.requestWillBeSentExtraInfo') {
                        if (params.headers) headers_entry.request = params.headers;
                    }
                    if (method === 'Network.responseReceivedExtraInfo') {
                        if (params.headers) headers_entry.response = params.headers;
                        if (params.headersText !== undefined) headers_entry.responseText = params.headersText;
                    }
                }

                if (params.timestamp && request_id) {
                    const timestamp = params.timestamp;
                    if (method === 'Network.requestWillBeSent' && params.request && params.request.url && params.request.url.substring(0,4) === 'http') {
                        const request = params.request;
                        request.raw_id = original_id;
                        request.startTime = timestamp;
                        if (params.frameId) request.frame_id = params.frameId;
                        else if (page_data.main_frame) request.frame_id = page_data.main_frame;
                        
                        if (params.initiator) request.initiator = params.initiator;
                        if (params.documentURL) request.documentURL = params.documentURL;
                        if (params.isLinkPreload !== undefined) request.isLinkPreload = params.isLinkPreload;
                        if (params.isSameSite !== undefined) request.isSameSite = params.isSameSite;
                        if (params.isAdRelated !== undefined) request.isAdRelated = params.isAdRelated;
                        
                        // Redirect handling
                        if (raw_requests[request_id]) {
                            if (params.redirectResponse) {
                                if (raw_requests[request_id].endTime === undefined || timestamp > raw_requests[request_id].endTime) {
                                    raw_requests[request_id].endTime = timestamp;
                                }
                                if (raw_requests[request_id].firstByteTime === undefined) {
                                    raw_requests[request_id].firstByteTime = timestamp;
                                }
                                raw_requests[request_id].fromNet = false;
                                if (params.redirectResponse.fromDiskCache !== undefined && 
                                    !params.redirectResponse.fromDiskCache && 
                                    raw_requests[request_id].headers && 
                                    Object.keys(raw_requests[request_id].headers).length) {
                                    raw_requests[request_id].fromNet = true;
                                }
                                raw_requests[request_id].response = params.redirectResponse;
                            }
                            let count = 0;
                            if (id_map[original_id] !== undefined) count = id_map[original_id];
                            id_map[original_id] = count + 1;
                            const new_id = original_id + '-' + id_map[original_id];
                            request_id = new_id;
                        }
                        
                        request.id = request_id;
                        raw_requests[request_id] = { ...request };
                    } else if (raw_requests[request_id]) {
                        const request = raw_requests[request_id];
                        if (request.endTime === undefined || timestamp > request.endTime) {
                            request.endTime = timestamp;
                        }
                        
                        if (method === 'Network.dataReceived') {
                            if (request.firstByteTime === undefined) request.firstByteTime = timestamp;
                            if (request.bytesInData === undefined) request.bytesInData = 0;
                            if (params.dataLength) request.bytesInData += params.dataLength;
                            if (request.bytesInEncoded === undefined) request.bytesInEncoded = 0;

                            // CDP reports both encoded (wire) and decoded (uncompressed) lengths per
                            // dataReceived event. Track both on the chunk as `bytes` (wire) and
                            // `inflated` (decoded) so downstream renderers can slice the decompressed
                            // body by delivery time. Only emit `inflated` when it differs from `bytes`.
                            if (params.encodedDataLength && params.encodedDataLength > 0) {
                                if (request.bytesFinished === undefined) {
                                    request.bytesInEncoded += params.encodedDataLength;
                                    if (request.chunks === undefined) request.chunks = [];
                                    const chunk = { ts: timestamp, bytes: params.encodedDataLength };
                                    if (params.dataLength && params.dataLength !== params.encodedDataLength) {
                                        chunk.inflated = params.dataLength;
                                    }
                                    request.chunks.push(chunk);
                                }
                            } else if (params.dataLength && params.dataLength > 0) {
                                if (request.chunks === undefined) request.chunks = [];
                                request.chunks.push({ ts: timestamp, bytes: params.dataLength });
                            }
                        }
                        
                        if (method === 'Network.responseReceived' && params.response) {
                            if (params.type) request.request_type = params.type;
                            if (!has_request_headers && params.response.requestHeaders) has_request_headers = true;
                            if (request.firstByteTime === undefined) request.firstByteTime = timestamp;
                            if (request.fromCache !== undefined && params.response.timing) {
                                delete params.response.timing; // Bogus timing for cached items
                            }
                            request.fromNet = false;
                            if (params.response.fromDiskCache !== undefined && 
                                !params.response.fromDiskCache && 
                                request.headers && Object.keys(request.headers).length) {
                                request.fromNet = true;
                            }
                            if (params.response.source && ['network', 'unknown'].includes(params.response.source)) {
                                request.fromNet = true;
                            }
                            request.response = params.response;
                        }
                        
                        if (method === 'Network.loadingFinished') {
                            if (params.metrics) {
                                request.metrics = params.metrics;
                                if (params.metrics.requestHeaders) {
                                    if (request.response === undefined) request.response = {};
                                    request.response.requestHeaders = params.metrics.requestHeaders;
                                    has_request_headers = true;
                                }
                            }
                            if (request.firstByteTime === undefined) request.firstByteTime = timestamp;
                            if (params.encodedDataLength !== undefined) {
                                request.bytesInEncoded = params.encodedDataLength;
                                request.bytesFinished = true;
                            }
                        }
                        
                        if (method === 'Network.loadingFailed' && request.response === undefined && 
                            (request.fromCache === undefined || !request.fromCache)) {
                            if (params.blockedReason === undefined && (params.canceled === undefined || !params.canceled)) {
                                if (params.errorText && params.errorText.includes('ERR_CONNECTION_REFUSED')) {
                                    request.fromNet = false;
                                } else {
                                    request.fromNet = true;
                                    request.errorCode = 12999;
                                    if (request.firstByteTime === undefined) request.firstByteTime = timestamp;
                                    if (params.errorText) request.error = params.errorText;
                                    if (params.error) request.errorCode = params.error;
                                }
                            } else {
                                request.fromNet = false;
                            }
                        }
                    }
                }
                
                if (method === 'Page.domContentEventFired' && params.timestamp && page_data.domContentLoadedEventStart === undefined) {
                    page_data.domContentLoadedEventStart = params.timestamp;
                    page_data.domContentLoadedEventEnd = params.timestamp;
                }
            }
        }

        // Add extra headers to events
        for (const [request_id, extra] of Object.entries(extra_headers)) {
            if (raw_requests[request_id]) {
                const request = raw_requests[request_id];
                if (extra.request) {
                    if (request.headers === undefined) request.headers = {};
                    request.headers = this.merge_devtools_headers(request.headers, extra.request);
                }
                if (extra.response && request.response) {
                    if (request.response.headers === undefined) request.response.headers = {};
                    request.response.headers = this.merge_devtools_headers(request.response.headers, extra.response);
                }
                if (extra.responseText && request.response && request.response.headersText === undefined) {
                    request.response.headersText = extra.responseText;
                }
            }
        }

        // Error-out any requests that started but never got a response or error
        for (const request of Object.values(raw_requests)) {
            if (request.endTime === undefined) {
                request.fromNet = true;
                request.errorCode = 12999;
            }
        }

        // Pull out just the requests that were served on the wire
        for (const request of Object.values(raw_requests)) {
            if (request.fromCache === undefined && request.response && request.response.timing && request.startTime !== undefined) {
                let min_time = null;
                for (const [key, val] of Object.entries(request.response.timing)) {
                    let value = parseFloat(val);
                    if (key !== 'requestTime' && value >= 0) {
                        value += request.startTime;
                        request.response.timing[key] = value;
                        if (min_time === null || value < min_time) min_time = value;
                    }
                }
                if (min_time !== null && min_time > request.startTime) {
                    request.startTime = min_time;
                }
                if (page_data.startTime === undefined || request.startTime < page_data.startTime) {
                    page_data.startTime = request.startTime;
                }
            }
            if (request.endTime !== undefined && (page_data.endTime === undefined || request.endTime > page_data.endTime)) {
                page_data.endTime = request.endTime;
            }
            if (request.fromNet) {
                net_requests.push({ ...request });
            }
        }

        if (net_requests.length) {
            net_requests.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
        }

        return { net_requests, page_data: page_data };
    }

    get_response_header(raw_request, header) {
        if (raw_request.response && raw_request.response.headers) {
            for (const [key, val] of Object.entries(raw_request.response.headers)) {
                if (key.toLowerCase() === header.toLowerCase()) return val.toString();
            }
        }
        return '';
    }

    process_requests(raw_requests, raw_page_data) {
        this.result = { pageData: {}, requests: [] };
        if (raw_page_data.startTime === undefined) raw_page_data.startTime = 0;
        
        const page_data = this.result.pageData;
        const requests = this.result.requests;
        
        page_data.loadTime = 0;
        page_data.docTime = 0;
        page_data.fullyLoaded = 0;
        page_data.bytesOut = 0;
        page_data.bytesOutDoc = 0;
        page_data.bytesIn = 0;
        page_data.bytesInDoc = 0;
        page_data.requests = 0;
        page_data.requestsFull = 0;
        page_data.requestsDoc = 0;
        page_data.responses_200 = 0;
        page_data.responses_404 = 0;
        page_data.responses_other = 0;
        page_data.result = 0;
        page_data.testStartOffset = 0;
        page_data.cached = 0;
        page_data.optimization_checked = 0;
        
        if (raw_page_data.main_frame !== undefined) page_data.main_frame = raw_page_data.main_frame;
        if (raw_page_data.onload !== undefined) {
            page_data.loadTime = Math.round(raw_page_data.onload - raw_page_data.startTime);
            page_data.docTime = page_data.loadTime;
            page_data.loadEventStart = page_data.loadTime;
            page_data.loadEventEnd = page_data.loadTime;
        }
        if (raw_page_data.domContentLoadedEventStart !== undefined) {
            page_data.domContentLoadedEventStart = Math.round(raw_page_data.domContentLoadedEventStart - raw_page_data.startTime);
            if (raw_page_data.domContentLoadedEventEnd !== undefined) {
                page_data.domContentLoadedEventEnd = Math.round(raw_page_data.domContentLoadedEventEnd - raw_page_data.startTime);
            } else {
                page_data.domContentLoadedEventEnd = page_data.domContentLoadedEventStart;
            }
        }
        if (raw_page_data.loadEventStart !== undefined) {
            page_data.loadEventStart = Math.round(raw_page_data.loadEventStart - raw_page_data.startTime);
            if (raw_page_data.loadEventEnd !== undefined) {
                page_data.loadEventEnd = Math.round(raw_page_data.loadEventEnd - raw_page_data.startTime);
            } else {
                page_data.loadEventEnd = page_data.loadEventStart;
            }
        }

        const connections = {};
        const dns_times = {};

        for (const raw_request of raw_requests) {
            if (raw_request.url) {
                const urlObj = new URL(raw_request.url.split('#')[0]);
                const request = { type: 3, id: raw_request.id, request_id: raw_request.id };
                request.ip_addr = '';
                request.full_url = urlObj.href;
                request.is_secure = urlObj.protocol === 'https:' ? 1 : 0;
                request.method = raw_request.method || '';
                request.host = urlObj.host;
                request.url = urlObj.pathname + urlObj.search;
                
                if (raw_request.overwrittenURL) {
                    request.full_url = raw_request.overwrittenURL;
                    request.original_url = raw_request.url;
                    const overwrittenObj = new URL(raw_request.overwrittenURL.split('#')[0]);
                    request.host = overwrittenObj.host;
                    request.url = overwrittenObj.pathname + overwrittenObj.search;
                }
                
                if (raw_request.raw_id) request.raw_id = raw_request.raw_id;
                if (raw_request.frame_id) request.frame_id = raw_request.frame_id;
                if (raw_request.documentURL) request.documentURL = raw_request.documentURL;
                if (raw_request.isLinkPreload !== undefined) request.isLinkPreload = raw_request.isLinkPreload;
                if (raw_request.isSameSite !== undefined) request.isSameSite = raw_request.isSameSite;
                if (raw_request.isAdRelated !== undefined) request.isAdRelated = raw_request.isAdRelated;
                
                request.responseCode = -1;
                if (raw_request.response && raw_request.response.status !== undefined) {
                    request.responseCode = raw_request.response.status;
                }
                if (raw_request.request_type) request.request_type = raw_request.request_type;
                request.load_ms = -1;
                
                let start_time = raw_request.startTime;
                if (raw_request.response && raw_request.response.timing && raw_request.response.timing.sendStart >= 0) {
                    start_time = raw_request.response.timing.sendStart;
                    if (page_data.fullyLoaded === undefined || start_time > page_data.fullyLoaded) {
                        page_data.fullyLoaded = Math.round(start_time);
                    }
                }
                if (raw_request.endTime !== undefined) {
                    const end_time = raw_request.endTime;
                    request.load_ms = Math.round(end_time - start_time);
                    if (page_data.fullyLoaded === undefined || (end_time - raw_page_data.startTime) > page_data.fullyLoaded) {
                        page_data.fullyLoaded = Math.round(end_time - raw_page_data.startTime);
                    }
                }
                
                request.ttfb_ms = -1;
                if (raw_request.firstByteTime !== undefined) {
                    request.ttfb_ms = Math.round(raw_request.firstByteTime - raw_request.startTime);
                }
                
                request.load_start = Math.round(start_time - raw_page_data.startTime);
                request.load_start_float = start_time - raw_page_data.startTime;
                request.bytesIn = 0;
                request.objectSize = '';
                
                if (raw_request.bytesIn !== undefined) request.bytesIn = Math.round(raw_request.bytesIn);
                if (raw_request.bytesInEncoded !== undefined && raw_request.bytesInEncoded > 0) {
                    request.objectSize = Math.round(raw_request.bytesInEncoded).toString();
                    request.bytesIn = Math.round(raw_request.bytesInEncoded);
                }
                if (raw_request.bytesInData !== undefined) {
                    if (request.objectSize === '') request.objectSize = Math.round(raw_request.bytesInData).toString();
                    if (request.bytesIn === 0) request.bytesIn = Math.round(raw_request.bytesInData);
                    request.objectSizeUncompressed = Math.round(raw_request.bytesInData);
                }
                if (raw_request.chunks) {
                    request.chunks = raw_request.chunks.map(chunk => {
                        const out = {
                            ts: Math.round(chunk.ts - raw_page_data.startTime),
                            bytes: chunk.bytes
                        };
                        if (chunk.inflated !== undefined) out.inflated = chunk.inflated;
                        return out;
                    });
                }
                
                if (request.bytesIn === 0 && raw_request.response && raw_request.response.headers && raw_request.response.headers['Content-Length']) {
                    const clMatch = raw_request.response.headers['Content-Length'].match(/\d+/);
                    if (clMatch) request.bytesIn = parseInt(clMatch[0], 10);
                }
                
                request.expires = this.get_response_header(raw_request, 'Expires').replace(/\n/g, ", ").replace(/\r/g, "");
                request.cacheControl = this.get_response_header(raw_request, 'Cache-Control').replace(/\n/g, ", ").replace(/\r/g, "");
                request.contentType = this.get_response_header(raw_request, 'Content-Type').split(';')[0];
                request.contentEncoding = this.get_response_header(raw_request, 'Content-Encoding').replace(/\n/g, ", ").replace(/\r/g, "");
                
                const object_size = this.get_response_header(raw_request, 'Content-Length').split("\n")[0].replace("\r", "");
                if (object_size) request.objectSize = object_size;
                if (!request.objectSize) request.objectSize = request.bytesIn.toString();
                if (request.objectSize) {
                    const osMatch = request.objectSize.toString().match(/\d+/);
                    if (osMatch) request.objectSize = parseInt(osMatch[0], 10);
                }
                
                request.socket = -1;
                if (raw_request.response && raw_request.response.connectionId !== undefined) request.socket = raw_request.response.connectionId;
                else if (raw_request.metrics && raw_request.metrics.connectionIdentifier !== undefined) request.socket = raw_request.metrics.connectionIdentifier;
                
                if (raw_request.response && raw_request.response.remoteIPAddress) request.ip_addr = raw_request.response.remoteIPAddress;
                else if (raw_request.metrics && raw_request.metrics.remoteAddress) {
                    const parts = raw_request.metrics.remoteAddress.split(':');
                    request.ip_addr = parts[0];
                    if (parts.length > 1) request.port = parts[1];
                }
                
                if (raw_request.response && raw_request.response.protocol) request.protocol = raw_request.response.protocol;
                else if (raw_request.metrics && raw_request.metrics.protocol) request.protocol = raw_request.metrics.protocol;
                if (request.protocol === 'h2') request.protocol = 'HTTP/2';
                
                request.dns_start = -1;
                request.dns_end = -1;
                request.connect_start = -1;
                request.connect_end = -1;
                request.ssl_start = -1;
                request.ssl_end = -1;
                
                if (raw_request.response && raw_request.response.timing) {
                    const timing = raw_request.response.timing;
                    if (timing.sendStart !== undefined && timing.receiveHeadersEnd !== undefined && timing.receiveHeadersEnd >= timing.sendStart) {
                        request.ttfb_ms = Math.round(timing.receiveHeadersEnd - timing.sendStart);
                        if (request.load_ms >= 0) request.load_ms = Math.max(request.ttfb_ms, request.load_ms);
                    }
                    if (request.socket !== -1 && connections[request.socket] === undefined && timing.domainLookupStart === undefined) {
                        connections[request.socket] = timing;
                        if (timing.dnsStart >= 0) {
                            const dns_key = request.host;
                            if (dns_times[dns_key] === undefined) {
                                dns_times[dns_key] = true;
                                request.dns_start = Math.round(timing.dnsStart - raw_page_data.startTime);
                                if (timing.dnsEnd >= 0) request.dns_end = Math.round(timing.dnsEnd - raw_page_data.startTime);
                            }
                        }
                        if (timing.connectStart >= 0) {
                            request.connect_start = Math.round(timing.connectStart - raw_page_data.startTime);
                            if (timing.connectEnd >= 0) request.connect_end = Math.round(timing.connectEnd - raw_page_data.startTime);
                        }
                        if (timing.sslStart >= 0) {
                            request.ssl_start = Math.round(timing.sslStart - raw_page_data.startTime);
                            if (request.connect_end > request.ssl_start) request.connect_end = request.ssl_start;
                            if (timing.sslEnd >= 0) request.ssl_end = Math.round(timing.sslEnd - raw_page_data.startTime);
                            if (raw_request.response.securityDetails) request.securityDetails = raw_request.response.securityDetails;
                        }
                    }
                    // Handle webkit timing logic here if needed (omitted for brevity unless required... wait, let's add it)
                    if (timing.domainLookupStart !== undefined || timing.secureConnectionStart !== undefined) {
                        if (timing.domainLookupStart >= 0) {
                            const dns_key = request.host;
                            if (dns_times[dns_key] === undefined) {
                                dns_times[dns_key] = true;
                                request.dns_start = Math.round(timing.domainLookupStart - raw_page_data.startTime);
                                if (timing.domainLookupEnd >= 0) request.dns_end = Math.round(timing.domainLookupEnd - raw_page_data.startTime);
                            }
                        }
                        if (timing.connectStart >= 0) {
                            request.connect_start = Math.round(timing.connectStart - raw_page_data.startTime);
                            if (timing.connectEnd >= 0) {
                                const old_load_start = request.load_start_float;
                                request.load_start_float = timing.connectEnd - raw_page_data.startTime;
                                if (request.load_start_float > old_load_start) {
                                    const connection_time = Math.round(request.load_start_float - old_load_start);
                                    if (request.load_ms !== undefined && request.load_ms > connection_time) {
                                        request.load_ms -= Math.round(connection_time);
                                    }
                                }
                                request.load_start = Math.round(request.load_start_float);
                                request.connect_end = request.load_start;
                            }
                        }
                        if (timing.secureConnectionStart >= 0) {
                            request.ssl_start = Math.round(timing.secureConnectionStart - raw_page_data.startTime);
                            if (request.connect_end > request.ssl_start) {
                                request.ssl_end = request.connect_end;
                                request.connect_end = request.ssl_start;
                            }
                        }
                    }
                }
                
                request.initiator = '';
                request.initiator_line = '';
                request.initiator_column = '';
                request.initiator_type = '';
                if (raw_request.initiator) {
                    if (raw_request.initiator.type) request.initiator_type = raw_request.initiator.type;
                    if (raw_request.initiator.url) {
                        request.initiator = raw_request.initiator.url;
                        if (raw_request.initiator.lineNumber !== undefined) request.initiator_line = raw_request.initiator.lineNumber;
                    } else if (raw_request.initiator.stack && raw_request.initiator.stack.callFrames && raw_request.initiator.stack.callFrames.length) {
                        for (const frame of raw_request.initiator.stack.callFrames) {
                            if (frame.url) {
                                request.initiator = frame.url;
                                if (frame.lineNumber !== undefined) request.initiator_line = frame.lineNumber;
                                if (frame.columnNumber !== undefined) request.initiator_column = frame.columnNumber;
                                if (frame.functionName) request.initiator_function = frame.functionName;
                                break;
                            } else if (frame.scriptId && this.script_ids[frame.scriptId]) {
                                request.initiator = this.script_ids[frame.scriptId];
                                break;
                            }
                        }
                    }
                }
                
                if (raw_request.initialPriority) {
                    if (PRIORITY_MAP[raw_request.initialPriority]) raw_request.initialPriority = PRIORITY_MAP[raw_request.initialPriority];
                    request.priority = raw_request.initialPriority;
                    request.initial_priority = raw_request.initialPriority;
                } else if (raw_request.metrics && raw_request.metrics.priority) {
                    if (PRIORITY_MAP[raw_request.metrics.priority]) raw_request.metrics.priority = PRIORITY_MAP[raw_request.metrics.priority];
                    request.priority = raw_request.metrics.priority;
                }
                
                request.headers = { request: [], response: [] };
                if (raw_request.response && raw_request.response.requestHeadersText) {
                    for (const line of raw_request.response.requestHeadersText.split('\n')) {
                        if (line.trim().length) request.headers.request.push(line.trim());
                    }
                } else if (raw_request.response && raw_request.response.requestHeaders) {
                    for (const [key, value] of Object.entries(raw_request.response.requestHeaders)) {
                        for (const line of value.split('\n')) {
                            request.headers.request.push(`${key}: ${line.trim()}`);
                        }
                    }
                } else if (raw_request.headers) { // Wait, the python code checks raw_request['headers'] which came from extra_headers
                    for (const [key, value] of Object.entries(raw_request.headers)) {
                        for (const line of value.split('\n')) {
                            request.headers.request.push(`${key}: ${line.trim()}`);
                        }
                    }
                }
                
                if (raw_request.response && raw_request.response.headersText) {
                    for (const line of raw_request.response.headersText.split('\n')) {
                        if (line.trim().length) request.headers.response.push(line.trim());
                    }
                } else if (raw_request.response && raw_request.response.headers) {
                    for (const [key, value] of Object.entries(raw_request.response.headers)) {
                        for (const line of value.split('\n')) {
                            request.headers.response.push(`${key}: ${line.trim()}`);
                        }
                    }
                }
                
                request.bytesOut = request.headers.request.join('\r\n').length;
                if (raw_request.metrics) {
                    let bytes_out = 0;
                    if (raw_request.metrics.requestHeaderBytesSent !== undefined) bytes_out += parseInt(raw_request.metrics.requestHeaderBytesSent, 10);
                    if (raw_request.metrics.requestBodyBytesSent !== undefined) bytes_out += parseInt(raw_request.metrics.requestBodyBytesSent, 10);
                    if (bytes_out > 0) request.bytesOut = bytes_out;
                    
                    let bytes_in = 0;
                    if (raw_request.metrics.responseHeaderBytesReceived !== undefined) bytes_in += parseInt(raw_request.metrics.responseHeaderBytesReceived, 10);
                    if (raw_request.metrics.responseBodyBytesReceived !== undefined) {
                        bytes_in += parseInt(raw_request.metrics.responseBodyBytesReceived, 10);
                        request.objectSize = parseInt(raw_request.metrics.responseBodyBytesReceived, 10);
                        request.objectSizeUncompressed = parseInt(raw_request.metrics.responseBodyBytesReceived, 10);
                    }
                    if (bytes_in > 0) request.bytesIn = bytes_in;
                    if (raw_request.metrics.responseBodyDecodedSize !== undefined) {
                        request.objectSizeUncompressed = parseInt(raw_request.metrics.responseBodyDecodedSize, 10);
                    }
                    if (raw_request.metrics.securityConnection) {
                        if (raw_request.metrics.securityConnection.protocol) request.tls_version = raw_request.metrics.securityConnection.protocol;
                        if (raw_request.metrics.securityConnection.cipher) request.tls_cipher_suite = raw_request.metrics.securityConnection.cipher;
                    }
                }
                
                
                if (request.dns_end >= 0 && request.dns_start >= 0 && request.dns_end >= request.dns_start) {
                    request.dns_ms = request.dns_end - request.dns_start;
                }
                if (request.connect_end >= 0 && request.connect_start >= 0 && request.connect_end >= request.connect_start) {
                    request.connect_ms = request.connect_end - request.connect_start;
                }
                if (request.ssl_end >= 0 && request.ssl_start >= 0 && request.ssl_end >= request.ssl_start) {
                    request.ssl_ms = request.ssl_end - request.ssl_start;
                }
                if (request.load_ms >= 0 && request.ttfb_ms >= 0 && request.load_ms >= request.ttfb_ms) {
                    request.download_ms = request.load_ms - request.ttfb_ms;
                } else if (request.load_ms >= 0 && request.ttfb_ms < 0) {
                    request.download_ms = request.load_ms;
                }
                if (request.load_ms >= 0) {
                    request.all_ms = request.load_ms;
                }
                request.created = raw_request.startTime - raw_page_data.startTime;

                requests.push(request);
            }
        }
    }
}

// isGzip native helper removed in favor of orchestration natively

/**
 * Node.js processor for Chrome DevTools Protocol JSON captures.
 * Handles extracting events from a file buffer and generating HAR format seamlessly.
 * 
 * @param {string} filePath - Path to .json or .json.gz file
 * @returns {Promise<import('../core/har-types.js').ExtendedHAR>}
 */
export async function processCDPFileNode(input, options = {}) {

    let stream = input;
    let isGz = options.isGz === true;
    let nodeFsStream = null;
    let reader = null;

    const onProgress = options.onProgress || (() => {});
    const totalBytes = options.totalBytes || 0;

    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import(/* @vite-ignore */ 'node:fs');
            
            const header = new Uint8Array(2);
            let fd;
            try {
                fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }
            
            isGz = header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b;
            
            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
            nodeFsStream = fs.createReadStream(input);
            stream = Readable.toWeb(nodeFsStream);
        }

        if (isGz) {
            stream = stream.pipeThrough(new DecompressionStream('gzip'));
        }

        const validPrefixes = ['Network.', 'Page.', 'Debugger.scriptParsed'];
        const events = [];

        const parser = new JSONParser({ paths: ['$.*'], keepStack: false });

        parser.onValue = ({ value }) => {
            if (value && value.method) {
                const isRelevant = validPrefixes.some(prefix => value.method.startsWith(prefix));
                if (isRelevant) {
                    events.push(value);
                }
            }
            return undefined; // flush natively
        };
        
        const pipeline = stream.pipeThrough(new TextDecoderStream());
        reader = pipeline.getReader();

        onProgress('Parsing CDP events...', 0);
        let bytesRead = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesRead += value.length;
            parser.write(value);
            if (totalBytes > 0) onProgress('Parsing CDP events...', Math.round((bytesRead / totalBytes) * 80));
        }
        onProgress('Processing events...', 80);

        if (options.debug) console.log(`[cdp.js] Successfully parsed ${events.length} CDP events.`);
        const devToolsParser = new DevToolsParser();
        const wptData = devToolsParser.process(events);
        
        const wptFormat = {
            data: {
                median: {
                    firstView: {
                        ...wptData.pageData,
                        requests: wptData.requests
                    }
                }
            }
        };
        
        const data = normalizeWPT(wptFormat);
        if (options.debug) console.log(`[cdp.js] Successfully normalized CDP to HAR.`);
        data.log.creator.name = "waterfall-tools (devtools)";
        
        // Use statically imported buildWaterfallDataFromHar
        const relational = buildWaterfallDataFromHar(data.log, 'cdp');
        
        const pageKeys = Object.keys(relational.pages);
        const hasRuns = pageKeys.some(id => !id.includes('_median_'));
        if (hasRuns) {
            for (const id of pageKeys) {
                if (id.includes('_median_')) delete relational.pages[id];
            }
        }
        
        return relational;

    } catch (e) {
        throw e;
    } finally {
        if (reader) try { reader.releaseLock(); } catch (e) {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }
}
