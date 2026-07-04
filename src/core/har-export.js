/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { VERSION } from './version.js';

/*
 * Relational-data → Extended HAR conversion, extracted verbatim from
 * `WaterfallTools.getPage()` / `WaterfallTools.getHar()` so raw-Node consumers (the
 * per-format CLI wrappers under `src/inputs/cli/`) can emit true HAR without importing
 * the `WaterfallTools` class — whose import chain hits the `platform-storage-impl`
 * build alias and is therefore unimportable outside a bundler/vitest context. The class
 * methods now delegate here; both depend only on the relational `data` object.
 */

/**
 * Get an individual page with associated timings mapped dynamically.
 * @param {Object} data - The relational data object ({metadata, pages, tcp_connections, ...})
 * @param {string} pageId
 * @param {Object} options - { includeRequests: boolean }
 * @returns {Object} The flattened page object
 */
export function getPageFromData(data, pageId, options = { includeRequests: false }) {
    if (!data.pages[pageId]) return null;

    const page = JSON.parse(JSON.stringify(data.pages[pageId])); // deep copy baseline

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

            // Filter out non-http protocols strictly
            const u = req.url ? req.url.toLowerCase() : '';
            if (!u.startsWith('http://') && !u.startsWith('https://')) {
                delete page.requests[reqId];
                continue;
            }

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
                if (data.tcp_connections && data.tcp_connections[req.connection_id]) {
                    connObj = data.tcp_connections[req.connection_id];
                } else if (data.quic_connections && data.quic_connections[req.connection_id]) {
                    connObj = data.quic_connections[req.connection_id];
                }
            }

            let dnsObj = null;
            if (req.dns_query_id && data.dns && data.dns[req.dns_query_id]) {
                dnsObj = data.dns[req.dns_query_id];
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
            const reqTimeStartMs = req.time_start;
            const firstDataMs = req.first_data_time > 0 ? req.first_data_time : req.time_end;
            const lastDataMs = req.time_end;

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
 * Compiles standard Extended HAR 1.2 Format strictly derived from internal Relational mapping
 * @param {Object} data - The relational data object ({metadata, pages, tcp_connections, ...})
 * @param {Object} _options
 * @returns {Object} `{ log: { version, creator, pages, entries } }`
 */
export function relationalToHar(data, _options = {}) {
    const pagesOut = [];
    const entriesOut = [];

    for (const [pageId, pData] of Object.entries(data.pages)) {
        const page = getPageFromData(data, pageId, { includeRequests: true });

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
            const getLoadStartMs = (req) => {
                const hasAbsoluteTimings = req._load_start !== undefined || req._dns_start !== undefined || req._ttfb_start !== undefined;

                if (hasAbsoluteTimings) {
                    const baseEpoch = globalEarliestMs;
                    const blockedEnd = baseEpoch + (req._load_start !== undefined ? req._load_start : (req._ttfb_start !== undefined ? req._ttfb_start : 0));

                    const dnsStart = (req._dns_start !== undefined && req._dns_start >= 0) ? baseEpoch + req._dns_start : blockedEnd;
                    const dnsEnd = (req._dns_end !== undefined && req._dns_end >= 0) ? baseEpoch + req._dns_end : dnsStart;

                    const connectStart = (req._connect_start !== undefined && req._connect_start >= 0) ? baseEpoch + req._connect_start : dnsEnd;
                    const connectEnd = (req._connect_end !== undefined && req._connect_end >= 0) ? baseEpoch + req._connect_end : connectStart;

                    const sslStart = (req._ssl_start !== undefined && req._ssl_start >= 0) ? baseEpoch + req._ssl_start : connectEnd;
                    const sslEnd = (req._ssl_end !== undefined && req._ssl_end >= 0) ? baseEpoch + req._ssl_end : sslStart;

                    const requestStart = baseEpoch + (req._load_start !== undefined ? req._load_start : (req._ttfb_start !== undefined ? req._ttfb_start : (sslEnd - baseEpoch)));

                    return Math.max(requestStart, connectEnd);
                }

                // Fallback to time_start plus blocking/DNS/TCP delays modeling TTFB request start
                let delay = 0;
                if (req.timings) {
                    if (req.timings.blocked > 0) delay += req.timings.blocked;
                    if (req.timings.dns > 0) delay += req.timings.dns;
                    if (req.timings.connect > 0) delay += req.timings.connect;
                    if (req.timings.send > 0) delay += req.timings.send;
                }
                return req.time_start + delay;
            };

            reqArray.sort((a, b) => getLoadStartMs(a) - getLoadStartMs(b));

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
                        content: Object.assign({
                            size: req.bytes_in || 0,
                            mimeType: req.mimeType || '',
                            compression: 0
                        }, req.body !== undefined ? { text: req.body, encoding: req.bodyEncoding || undefined } : {}),
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

                // WebPageTest compatibility tracking fallbacks cleanly preserving mapped metrics
                if (req.time_start > 0 && entry._load_start === undefined) entry._load_start = Math.floor(req.time_start - globalEarliestMs);
                if (req._dnsTimeMs > 0 && entry._dns_start === undefined) entry._dns_start = Math.floor(req._dnsTimeMs - globalEarliestMs);
                if (req._dnsEndTimeMs > 0 && entry._dns_end === undefined) entry._dns_end = Math.floor(req._dnsEndTimeMs - globalEarliestMs);
                if (req._connectTimeMs > 0 && entry._connect_start === undefined) entry._connect_start = Math.floor(req._connectTimeMs - globalEarliestMs);
                if (req._connectEndTimeMs > 0 && entry._connect_end === undefined) entry._connect_end = Math.floor(req._connectEndTimeMs - globalEarliestMs);
                if (req._sslStartTimeMs > 0 && entry._ssl_start === undefined) entry._ssl_start = Math.floor(req._sslStartTimeMs - globalEarliestMs);
                if (req.time_start > 0 && req.timings.ssl > 0 && entry._ssl_end === undefined) entry._ssl_end = entry._load_start;
                if (req.time_start > 0 && entry._ttfb_start === undefined) entry._ttfb_start = entry._load_start;
                if (req.first_data_time > 0 && entry._ttfb_end === undefined) entry._ttfb_end = Math.floor(req.first_data_time - globalEarliestMs);
                if (req.first_data_time > 0 && entry._download_start === undefined) entry._download_start = entry._ttfb_end;
                if (req.time_end > 0 && entry._download_end === undefined) {
                    entry._download_end = Math.floor(req.time_end - globalEarliestMs);
                    if (entry._all_end === undefined) entry._all_end = entry._download_end;
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
                version: VERSION
            },
            pages: pagesOut,
            entries: entriesOut
        }
    };
}
