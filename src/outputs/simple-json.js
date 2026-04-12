/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * Generates a simplified, flat JSON representation from an Extended HAR object.
 * This distills the complex HAR schema down to a simple array of objects 
 * focusing on URLs, timings, sizes, and basic connection stats,
 * making it ideal for generic JS applications or data tables.
 *
 * @param {import('../core/har-types.js').ExtendedHAR} extendedHar - The source HAR object
 * @returns {Array<Object>} Flat array of simplified requests
 */
export function generateSimpleJSON(extendedHar) {
    if (!extendedHar || !extendedHar.log || !extendedHar.log.entries) {
        return [];
    }

    return extendedHar.log.entries.map((entry, index) => {
        const req = entry.request || {};
        const res = entry.response || {};

        return {
            index: index,
            url: req.url || entry._url || '',
            full_url: entry._full_url || req.url || entry._url || '',
            host: entry._host || '',
            method: req.method || entry._method || 'GET',
            status: res.status !== undefined ? res.status : (entry._responseCode || 0),
            protocol: entry._protocol || '',
            ip: entry.serverIPAddress || entry._ip_addr || '',
            startedDateTime: entry.startedDateTime,
            time: entry.time,
            type: entry._type || entry._request_type || '',
            contentType: entry._contentType || (res.content ? res.content.mimeType : ''),
            bytesIn: entry._bytesIn !== undefined ? entry._bytesIn : (res.bodySize && res.bodySize > 0 ? res.bodySize : 0),
            bytesOut: entry._bytesOut !== undefined ? entry._bytesOut : (req.headersSize && req.headersSize > 0 ? req.headersSize : 0),
            objectSize: entry._objectSize !== undefined ? entry._objectSize : (res.content && res.content.size > 0 ? res.content.size : 0),
            ttfb_ms: entry._ttfb_ms !== undefined ? entry._ttfb_ms : -1,
            load_ms: entry._load_ms !== undefined ? entry._load_ms : -1,
            download_ms: entry._download_ms !== undefined ? entry._download_ms : -1,
            dns_ms: entry._dns_ms !== undefined ? entry._dns_ms : -1,
            connect_ms: entry._connect_ms !== undefined ? entry._connect_ms : -1,
            ssl_ms: entry._ssl_ms !== undefined ? entry._ssl_ms : -1,
            error: res._error || null
        };
    });
}
