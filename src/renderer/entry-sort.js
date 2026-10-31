/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

/**
 * Chronological sort key used to order waterfall rows. Mirrors
 * `WaterfallCanvas.render()` so the interactive canvas and headless
 * `generateImage()` output produce identical row order.
 *
 * Entries with absolute timings (`_load_start` / `_start` / `_dns_start` / `_ttfb_start`)
 * sort by the later of the request-send point and the connection end — multiplexed
 * requests queued behind a socket setup land after the connect completes. Entries
 * without them fall back to `time_start` plus the positive pre-send HAR phases.
 * @param {Object} req - flattened request (from getPage(..., { includeRequests: true }))
 * @returns {number}
 */
export function getRenderSortEpoch(req) {
    const hasAbsoluteTimings = req._load_start !== undefined || req._start !== undefined || req._dns_start !== undefined || req._ttfb_start !== undefined;
    if (hasAbsoluteTimings) {
        const startOrigin = req._load_start !== undefined ? req._load_start : (req._start !== undefined ? req._start : undefined);
        const blockedEnd = startOrigin !== undefined ? startOrigin : (req._ttfb_start !== undefined ? req._ttfb_start : 0);
        const dnsStart = (req._dns_start !== undefined && req._dns_start >= 0) ? req._dns_start : blockedEnd;
        const dnsEnd = (req._dns_end !== undefined && req._dns_end >= 0) ? req._dns_end : dnsStart;
        const connectStart = (req._connect_start !== undefined && req._connect_start >= 0) ? req._connect_start : dnsEnd;
        const connectEnd = (req._connect_end !== undefined && req._connect_end >= 0) ? req._connect_end : connectStart;
        const sslStart = (req._ssl_start !== undefined && req._ssl_start >= 0) ? req._ssl_start : connectEnd;
        const sslEnd = (req._ssl_end !== undefined && req._ssl_end >= 0) ? req._ssl_end : sslStart;
        const requestStart = startOrigin !== undefined ? startOrigin : (req._ttfb_start !== undefined ? req._ttfb_start : sslEnd);
        return Math.max(requestStart, connectEnd);
    }

    let delay = 0;
    if (req.timings) {
        if (req.timings.blocked > 0) delay += req.timings.blocked;
        if (req.timings.dns > 0) delay += req.timings.dns;
        if (req.timings.connect > 0) delay += req.timings.connect;
        if (req.timings.send > 0) delay += req.timings.send;
    }
    return req.time_start + delay;
}

/**
 * Sort request entries in place into waterfall row order.
 * @param {Array<Object>} entries
 * @returns {Array<Object>} the same array
 */
export function sortEntriesForRender(entries) {
    return entries.sort((a, b) => getRenderSortEpoch(a) - getRenderSortEpoch(b));
}
