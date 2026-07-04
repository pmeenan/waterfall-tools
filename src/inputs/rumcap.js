/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview rumcap (.rcap) Input Processor
 *
 * Decodes rumcap field captures (RUM beacons carrying navigation/resource timing, paint
 * milestones, LCP/CLS/INP, long tasks, LoAF, User Timing, errors, a JS Self-Profiling call
 * tree, and app customEvents timelines) into the Extended HAR intermediary structure.
 *
 * Clock model: every rcap timeline value is a relative-ms offset (`RelMs`) from
 * `manifest.clock.timeOrigin` (epoch ms) — exactly the renderer's relative-ms model, so
 * `page zero == timeOrigin` and no epoch re-derivation ever happens here.
 *
 * Absence model: rumcap stores didn't-happen as ABSENT (never 0-filled), and its manifest is
 * TOTAL — every stream carries an explicit status. This parser mirrors that: an absent source
 * value produces an omitted `_` field, never a fabricated 0 (missing is better than wrong).
 */
import { unpack, checkConsistency } from 'rumcap/decode';
import { buildWaterfallDataFromHar } from '../core/har-converter.js';
import { computeSliceGridUsecs } from '../core/mainthread-categories.js';
import { VERSION } from '../core/version.js';

function isGzip(buf) {
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Collect an entire web ReadableStream into a single Uint8Array, reporting read progress.
 * @param {ReadableStream} stream
 * @param {function(string, number): void} onProgress
 * @param {number} totalBytes - 0 when unknown
 * @returns {Promise<Uint8Array>}
 */
async function collectStream(stream, onProgress, totalBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let bytesRead = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            bytesRead += value.length;
            if (totalBytes > 0) {
                onProgress('Reading rumcap capture...', Math.min(60, Math.round((bytesRead / totalBytes) * 60)));
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
    }
    const out = new Uint8Array(bytesRead);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

/**
 * Map an ALPN token (`nextHopProtocol`) to the HAR httpVersion / `_protocol` convention used
 * by the other parsers (netlog/cdp emit "HTTP/2", "HTTP/3", ...).
 * @param {string|undefined} alpn
 * @returns {string|null}
 */
function mapProtocol(alpn) {
    if (!alpn) return null;
    const lower = alpn.toLowerCase();
    if (lower === 'h3' || lower.startsWith('h3-')) return 'HTTP/3';
    if (lower === 'h2' || lower === 'spdy/3.1') return 'HTTP/2';
    if (lower === 'http/1.1') return 'HTTP/1.1';
    if (lower === 'http/1.0') return 'HTTP/1.0';
    return alpn;
}

/**
 * Cumulative Layout Shift with the standard max-session-window aggregation (web-vitals
 * semantics): only shifts with `hadRecentInput === false` count; a shift joins the current
 * session window when the gap since the previous shift is < 1000 ms AND the window span is
 * < 5000 ms, otherwise it starts a new window; CLS is the max window sum.
 * @param {Array<{startTime: number, value: number, hadRecentInput: boolean}>} shifts
 * @returns {number}
 */
export function computeClsFromShifts(shifts) {
    let max = 0;
    let sessionValue = 0;
    let firstTs = 0;
    let lastTs = 0;
    const sorted = shifts
        .filter(s => s && s.hadRecentInput === false && typeof s.value === 'number')
        .sort((a, b) => a.startTime - b.startTime);
    for (const s of sorted) {
        if (sessionValue > 0 && s.startTime - lastTs < 1000 && s.startTime - firstTs < 5000) {
            sessionValue += s.value;
        } else {
            sessionValue = s.value;
            firstTs = s.startTime;
        }
        lastTs = s.startTime;
        if (sessionValue > max) max = sessionValue;
    }
    return max;
}

/**
 * Interaction to Next Paint from raw Event Timing entries (web-vitals p98 estimator):
 * group events by nonzero `interactionId`, take the max duration per interaction, sort the
 * per-interaction durations descending, and report the value at index
 * `min(floor(interactionCount / 50), count - 1)` — the worst interaction below 50 total.
 * Returns null when there are no interactions (no interactions is NOT an INP of 0).
 * @param {Array<{interactionId?: number, duration: number}>} events
 * @returns {number|null}
 */
export function computeInpFromInteractions(events) {
    const byInteraction = new Map();
    for (const ev of events) {
        if (!ev || !ev.interactionId) continue; // 0 / absent = not an interaction
        const prev = byInteraction.get(ev.interactionId);
        if (prev === undefined || ev.duration > prev) {
            byInteraction.set(ev.interactionId, ev.duration);
        }
    }
    if (byInteraction.size === 0) return null;
    const durations = [...byInteraction.values()].sort((a, b) => b - a);
    const candidateIndex = Math.min(Math.floor(byInteraction.size / 50), durations.length - 1);
    return durations[candidateIndex];
}

/**
 * Fold the depth-0 profile slices into the renderer's `_mainThreadSlices` shape. A sampling
 * JS profiler only observes script execution, so all busy time honestly lands in the single
 * `EvaluateScript` category; the other four canonical categories are present but all-zero.
 * Only depth-0 slices count — children are contained within their parent's span, so adding
 * them would double-count CPU time.
 * @param {Object} profile - rumcap SliceProfile
 * @param {number} captureEndMs - clock.captureEnd (RelMs) — the span is 0 → captureEnd
 * @returns {{slice_usecs: number, total_usecs: number, slices: Object}|null}
 */
function buildMainThreadSlices(profile, captureEndMs) {
    if (!profile || !Array.isArray(profile.slices) || profile.slices.length === 0) return null;
    const spanUs = Math.ceil(captureEndMs * 1000);
    if (spanUs <= 0) return null;
    const { sliceUsecs, sliceCount } = computeSliceGridUsecs(spanUs);
    if (sliceCount <= 0) return null;

    const evaluateScript = new Array(sliceCount).fill(0);
    for (const slice of profile.slices) {
        if (slice.depth !== 0 || !(slice.duration > 0)) continue;
        const startUs = slice.start * 1000;
        const endUs = (slice.start + slice.duration) * 1000;
        if (!isFinite(startUs) || !isFinite(endUs) || endUs <= 0) continue;
        // Clip the slice span into each grid cell it overlaps.
        const first = Math.max(0, Math.floor(startUs / sliceUsecs));
        const last = Math.min(sliceCount - 1, Math.floor(endUs / sliceUsecs));
        for (let i = first; i <= last; i++) {
            const cellStart = i * sliceUsecs;
            const cellEnd = cellStart + sliceUsecs;
            const used = Math.min(endUs, cellEnd) - Math.max(startUs, cellStart);
            if (used > 0) evaluateScript[i] = Math.min(sliceUsecs, evaluateScript[i] + used);
        }
    }

    return {
        slice_usecs: sliceUsecs,
        total_usecs: sliceCount * sliceUsecs,
        slices: {
            ParseHTML: new Array(sliceCount).fill(0),
            Layout: new Array(sliceCount).fill(0),
            Paint: new Array(sliceCount).fill(0),
            EvaluateScript: evaluateScript.map(v => Math.round(v)),
            other: new Array(sliceCount).fill(0)
        }
    };
}

/**
 * Group the depth-0 profile slice intervals by the script URL their frame resolves to
 * (frame.resourceId → profile.resources[resourceId]).
 * @param {Object} profile - rumcap SliceProfile
 * @returns {Object<string, Array<[number, number]>>}
 */
function buildJsTimingByUrl(profile) {
    const perUrl = {};
    if (!profile || !Array.isArray(profile.slices) || profile.slices.length === 0) return perUrl;
    const frames = profile.frames || [];
    const resources = profile.resources || [];
    for (const slice of profile.slices) {
        if (slice.depth !== 0 || !(slice.duration > 0)) continue;
        const frame = frames[slice.frameId];
        if (!frame || frame.resourceId === undefined) continue;
        const url = resources[frame.resourceId];
        if (!url) continue;
        if (!perUrl[url]) perUrl[url] = [];
        perUrl[url].push([slice.start, slice.start + slice.duration]);
    }
    for (const url of Object.keys(perUrl)) {
        perUrl[url].sort((a, b) => a[0] - b[0]);
    }
    return perUrl;
}

/**
 * Build one Extended HAR entry from a rumcap ResourceTimingEntry (the NavigationTimingEntry
 * is a strict superset, so the navigation flows through here too).
 *
 * Every `_` timing extension is a relative-ms offset from page zero (timeOrigin) and is only
 * emitted when the source phase value is present — an absent phase must never become 0.
 * `_load_start` follows the WPT convention (start of the HTTP request phase): `requestStart`
 * when instrumented, degrading to `fetchStart` then `startTime` for TAO-restricted resources.
 *
 * @param {Object} r - ResourceTimingEntry / NavigationTimingEntry
 * @param {string} pageId
 * @param {number} timeOrigin - epoch ms
 * @param {boolean} isNavigation
 * @returns {Object} HAR entry
 */
function buildEntry(r, pageId, timeOrigin, isNavigation) {
    const startTime = r.startTime || 0;
    const endTime = r.responseEnd !== undefined ? r.responseEnd : startTime + (r.duration || 0);
    const protocol = mapProtocol(r.nextHopProtocol);

    // rumcap's responseStatus 0 is a PRESENT opaque/CORS-hidden status, not absence. HAR 0
    // renders as a canceled/error row and omission would let har-converter fabricate a 200,
    // so both 0 and absent map to -1 (the netlog unknown-status convention); the raw value is
    // preserved on `_responseStatus` whenever it was present.
    const status = (r.responseStatus !== undefined && r.responseStatus > 0) ? r.responseStatus : -1;

    // Standard HAR timings (informational — the renderer uses the absolute `_` fields):
    // -1 marks unknowable phases per HAR convention. `wait` is derived so that
    // startTime + blocked + dns + connect + wait lands exactly on responseStart, keeping
    // har-converter's sequential first_data_time fallback aligned with the wire truth.
    const dns = (r.domainLookupStart !== undefined && r.domainLookupEnd !== undefined)
        ? Math.max(0, r.domainLookupEnd - r.domainLookupStart) : -1;
    const connect = (r.connectStart !== undefined && r.connectEnd !== undefined)
        ? Math.max(0, r.connectEnd - r.connectStart) : -1;
    const ssl = (r.secureConnectionStart !== undefined && r.connectEnd !== undefined)
        ? Math.max(0, r.connectEnd - r.secureConnectionStart) : -1;
    const firstPhase = r.domainLookupStart !== undefined ? r.domainLookupStart
        : (r.connectStart !== undefined ? r.connectStart
            : (r.requestStart !== undefined ? r.requestStart : r.fetchStart));
    const blocked = firstPhase !== undefined ? Math.max(0, firstPhase - startTime) : -1;
    let wait = -1;
    let receive;
    if (r.responseStart !== undefined) {
        wait = Math.max(0, r.responseStart - startTime - Math.max(0, blocked) - Math.max(0, dns) - Math.max(0, connect));
        receive = Math.max(0, endTime - r.responseStart);
    } else {
        receive = Math.max(0, endTime - startTime - Math.max(0, blocked) - Math.max(0, dns) - Math.max(0, connect));
    }

    const entry = {
        startedDateTime: new Date(timeOrigin + startTime).toISOString(),
        time: Math.max(0, endTime - startTime),
        pageref: pageId,
        request: {
            method: 'GET',
            url: r.name,
            httpVersion: protocol || '',
            cookies: [],
            headers: [],
            queryString: [],
            headersSize: -1,
            bodySize: -1
        },
        response: {
            status,
            statusText: '',
            httpVersion: protocol || '',
            cookies: [],
            headers: [],
            content: {
                size: r.decodedBodySize !== undefined ? r.decodedBodySize : 0,
                mimeType: r.contentType || ''
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: r.encodedBodySize !== undefined ? r.encodedBodySize : -1
        },
        cache: {},
        timings: { blocked, dns, connect, ssl, send: 0, wait, receive }
    };

    entry._full_url = r.name;
    if (isNavigation) entry._is_base_page = true;
    if (protocol) entry._protocol = protocol;
    if (r.responseStatus !== undefined) entry._responseStatus = r.responseStatus;
    if (r.contentType !== undefined) entry._contentType = r.contentType;
    if (r.contentEncoding !== undefined) entry._contentEncoding = r.contentEncoding;
    if (r.initiatorType !== undefined) entry._initiator_type = r.initiatorType;
    if (r.renderBlockingStatus !== undefined) entry._renderBlocking = r.renderBlockingStatus;
    if (Array.isArray(r.serverTiming) && r.serverTiming.length > 0) entry._server_timing = r.serverTiming;

    // Sizes. `_bytesIn` prefers the wire transferSize, degrading to encodedBodySize; a present
    // zero (opaque/TAO-hidden) is kept — it is data, not absence.
    let bytesIn;
    if (r.transferSize !== undefined && r.transferSize > 0) bytesIn = r.transferSize;
    else if (r.encodedBodySize !== undefined && r.encodedBodySize > 0) bytesIn = r.encodedBodySize;
    else if (r.transferSize !== undefined) bytesIn = r.transferSize;
    else if (r.encodedBodySize !== undefined) bytesIn = r.encodedBodySize;
    if (bytesIn !== undefined) entry._bytesIn = bytesIn;
    if (r.encodedBodySize !== undefined) entry._objectSize = r.encodedBodySize;
    if (r.decodedBodySize !== undefined) entry._objectSizeUncompressed = r.decodedBodySize;

    // Absolute timing extensions (relative ms from page zero). The renderer's absolute-timings
    // geometry path (layout.js) keys on these, preserving parallel phases (e.g. DNS resolved
    // during a queue block) that sequential HAR timings cannot express.
    entry._created = startTime;          // queue start — layout draws the wait band from here
    entry._all_start = startTime;
    entry._all_end = endTime;
    if (r.duration !== undefined) entry._all_ms = r.duration;
    if (r.domainLookupStart !== undefined) entry._dns_start = r.domainLookupStart;
    if (r.domainLookupEnd !== undefined) entry._dns_end = r.domainLookupEnd;
    if (r.connectStart !== undefined) entry._connect_start = r.connectStart;
    if (r.connectEnd !== undefined) entry._connect_end = r.connectEnd;
    if (r.secureConnectionStart !== undefined) {
        entry._ssl_start = r.secureConnectionStart;
        if (r.connectEnd !== undefined) entry._ssl_end = r.connectEnd;
    }

    // WPT convention: `load_start` is the start of the HTTP request phase (ttfb is measured
    // from it). TAO-restricted resources hide requestStart — degrade to fetchStart, then to
    // startTime, so the bar still starts where the fetch demonstrably began.
    const loadStart = r.requestStart !== undefined ? r.requestStart
        : (r.fetchStart !== undefined ? r.fetchStart : startTime);
    entry._load_start = loadStart;
    if (r.responseEnd !== undefined) {
        entry._load_end = r.responseEnd;
        entry._load_ms = Math.max(0, r.responseEnd - loadStart);
    }
    if (r.requestStart !== undefined) entry._ttfb_start = r.requestStart;
    if (r.responseStart !== undefined) {
        entry._ttfb_end = r.responseStart;
        entry._download_start = r.responseStart;
        entry._ttfb_ms = Math.max(0, r.responseStart - loadStart);
    }
    if (r.responseEnd !== undefined) entry._download_end = r.responseEnd;
    if (r.firstInterimResponseStart !== undefined) entry._first_interim_response = r.firstInterimResponseStart;

    return entry;
}

/**
 * Build the single HAR page from the capture's navigation / rendering / interaction streams.
 * Every field only lands when its source stream (and value) is present — the rumcap manifest
 * is total, so "absent" always has a recorded reason and must never be rendered as 0.
 * @param {Object} capture - decoded rumcap Capture
 * @param {string} pageId
 * @returns {Object} HAR page
 */
function buildPage(capture, pageId) {
    const clock = capture.manifest.clock;
    const streams = capture.streams || {};
    const manifestStreams = capture.manifest.streams || {};
    const isPresent = (id) => manifestStreams[id] && manifestStreams[id].status === 'present';
    const nav = streams.navigation;

    const page = {
        id: pageId,
        title: (nav && nav.name) || '',
        startedDateTime: new Date(clock.timeOrigin).toISOString(),
        pageTimings: { onContentLoad: -1, onLoad: -1 }
    };

    if (nav) {
        if (nav.domContentLoadedEventStart !== undefined) {
            page.pageTimings.onContentLoad = nav.domContentLoadedEventStart;
            page._domContentLoadedEventStart = nav.domContentLoadedEventStart;
        }
        if (nav.domContentLoadedEventEnd !== undefined) page._domContentLoadedEventEnd = nav.domContentLoadedEventEnd;
        if (nav.loadEventStart !== undefined) {
            page.pageTimings.onLoad = nav.loadEventStart;
            page._loadEventStart = nav.loadEventStart;
        }
        if (nav.loadEventEnd !== undefined) page._loadEventEnd = nav.loadEventEnd;
        if (nav.domInteractive !== undefined) page._domInteractive = nav.domInteractive;
        // WPT "Doc Complete" — time to the load event (matching the CDP parser's docTime).
        const docTime = nav.loadEventEnd !== undefined ? nav.loadEventEnd
            : (nav.loadEventStart !== undefined ? nav.loadEventStart : nav.responseEnd);
        if (docTime !== undefined) page._docTime = docTime;
    }
    if (clock.captureEnd !== undefined) page._fullyLoaded = clock.captureEnd;

    // Paint milestones
    if (isPresent('paint') && streams.paint) {
        if (streams.paint.firstPaint && streams.paint.firstPaint.startTime !== undefined) {
            page._render = streams.paint.firstPaint.startTime;
        }
        if (streams.paint.firstContentfulPaint && streams.paint.firstContentfulPaint.startTime !== undefined) {
            page._firstContentfulPaint = streams.paint.firstContentfulPaint.startTime;
        }
    }

    // LCP — the final candidate defines the metric. renderTime is withheld for cross-origin
    // images without Timing-Allow-Origin; loadTime then carries the usable timing.
    if (isPresent('lcp') && streams.lcp && streams.lcp.final) {
        const lcp = streams.lcp.final;
        const lcpTime = lcp.renderTime !== undefined ? lcp.renderTime
            : (lcp.loadTime !== undefined ? lcp.loadTime : lcp.startTime);
        if (lcpTime !== undefined) page._LargestContentfulPaint = lcpTime;
    }

    // CLS — a present stream with zero shifts is a real CLS of 0.
    if (isPresent('cls') && streams.cls && Array.isArray(streams.cls.shifts)) {
        page._CumulativeLayoutShift = computeClsFromShifts(streams.cls.shifts);
    }

    // INP — no interactions means "no INP", not 0.
    if (isPresent('interactions') && streams.interactions && Array.isArray(streams.interactions.events)) {
        const inp = computeInpFromInteractions(streams.interactions.events);
        if (inp !== null) page._InteractionToNextPaint = inp;
    }

    // Long tasks tri-state: entries when found, [] when the stream ran and saw none, omitted
    // entirely when the manifest says it wasn't collected — the renderer keys the Long Tasks
    // band's existence on Array.isArray(page._longTasks).
    if (isPresent('longTasks') && streams.longTasks && Array.isArray(streams.longTasks.tasks)) {
        page._longTasks = streams.longTasks.tasks
            .map(t => [t.startTime, t.startTime + t.duration])
            .sort((a, b) => a[0] - b[0]);
    }

    // User Timing — the renderer's vertical-mark shape is a name → time map (values may also
    // be {time} objects, which lets measures carry their duration alongside).
    if (isPresent('userTiming') && streams.userTiming) {
        const marks = {};
        for (const m of streams.userTiming.marks || []) {
            if (m && m.name !== undefined && m.startTime !== undefined) marks[m.name] = m.startTime;
        }
        for (const m of streams.userTiming.measures || []) {
            if (m && m.name !== undefined && m.startTime !== undefined) {
                marks[m.name] = { time: m.startTime, duration: m.duration };
            }
        }
        page._user_timing = marks;
    }

    // Main-thread band from the JS self-profiling call tree (depth-0 slices only). Omitted
    // when the profile stream is absent OR present-but-empty (zero slices — nothing to fold).
    if (isPresent('profile') && streams.profile) {
        const slices = buildMainThreadSlices(streams.profile, clock.captureEnd || 0);
        if (slices) page._mainThreadSlices = slices;
    }

    // Non-rendered capture context for the details UI — only when the stream is present.
    page._rumcapManifest = capture.manifest.streams;
    if (isPresent('environment') && streams.environment) page._rumcapEnvironment = streams.environment;
    if (capture.metadata !== undefined) page._rumcapMetadata = capture.metadata;
    if (isPresent('errors') && streams.errors) page._rumcapErrors = streams.errors;
    if (isPresent('visibility') && streams.visibility) page._rumcapVisibility = streams.visibility;
    if (isPresent('loaf') && streams.loaf) page._rumcapLoaf = streams.loaf;
    if (isPresent('interactions') && streams.interactions) page._rumcapInteractions = streams.interactions;
    if (isPresent('elementTiming') && streams.elementTiming) page._rumcapElementTiming = streams.elementTiming;
    if (isPresent('customEvents') && streams.customEvents) page._rumcapCustomEvents = streams.customEvents;

    return page;
}

/**
 * Build the Extended HAR `log` object from a decoded rumcap Capture. Exported so the
 * standalone CLI wrapper can emit true Extended HAR (`{ log }`) without routing through the
 * `WaterfallTools` class (whose `platform-storage-impl` build alias makes it unimportable in
 * raw Node — only the bundled `bin/waterfall-tools.js` path can use `getHar()`).
 * @param {Object} capture - decoded rumcap Capture (`unpack()` output)
 * @param {Object} options
 * @returns {Object} Extended HAR log
 */
export function buildRumcapHarLog(capture, options = {}) {
    const clock = capture.manifest.clock;
    const timeOrigin = clock.timeOrigin;
    const streams = capture.streams || {};
    const pageId = 'page_1';

    const page = buildPage(capture, pageId);

    // The navigation IS the document request — it leads the entry list; resources follow.
    const entries = [];
    if (streams.navigation) {
        entries.push(buildEntry(streams.navigation, pageId, timeOrigin, true));
    }
    for (const r of streams.resources || []) {
        entries.push(buildEntry(r, pageId, timeOrigin, false));
    }

    // Per-request JS execution overlays from the profile's depth-0 slices, attributed by
    // frame → resourceId → URL, first-match-wins with the same $used de-dup as wptagent so a
    // script's slices never paint on every duplicate of its URL.
    const manifestStreams = capture.manifest.streams || {};
    if (manifestStreams.profile && manifestStreams.profile.status === 'present' && streams.profile) {
        const perUrl = buildJsTimingByUrl(streams.profile);
        const used = new Set();
        for (const entry of entries) {
            const url = entry._full_url;
            if (!url || used.has(url)) continue;
            const pairs = perUrl[url];
            if (!pairs) continue;
            entry._js_timing = pairs;
            used.add(url);
        }
    }

    const log = {
        version: '1.2',
        creator: { name: 'waterfall-tools (rumcap)', version: VERSION },
        pages: [page],
        entries
    };

    if (options.debug) {
        console.log(`[rumcap.js] Built HAR: 1 page, ${entries.length} entries (formatVersion ${capture.formatVersion}).`);
    }

    return log;
}

/**
 * Convert a decoded rumcap Capture into the relational waterfall data structure.
 * @param {Object} capture
 * @param {Object} options
 * @returns {Object} relational data from buildWaterfallDataFromHar
 */
function captureToWaterfallData(capture, options = {}) {
    return buildWaterfallDataFromHar(buildRumcapHarLog(capture, options), 'rumcap');
}

/**
 * Node/browser processor for rumcap (.rcap) captures.
 * Accepts a file path, a Node Readable, a web ReadableStream, or a raw buffer. Detects a
 * user-applied OUTER gzip layer by magic bytes (a plain .rcap starts with the cleartext
 * 0xF5 "RUM" magic — its internal gzip sits after that header, so only user-gzipped files
 * lead with 1f 8b) and inflates it before handing bytes to rumcap's `unpack`.
 *
 * @param {string|ReadableStream|Uint8Array|ArrayBuffer} input
 * @param {Object} options - { debug, onProgress, totalBytes, isGz }
 * @returns {Promise<Object>} relational waterfall data (with `_rumcapCapture` retained)
 */
export async function processRumcapNode(input, options = {}) {
    const onProgress = options.onProgress || (() => {});
    let totalBytes = options.totalBytes || 0;

    // Isomorphic workaround for Node 22 Web Stream premature event loop exit bug
    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;
    let nodeFsStream = null;

    try {
        let bytes = null;

        if (typeof input === 'string') {
            const fs = await import(/* @vite-ignore */ 'node:fs');
            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
            if (!totalBytes) {
                try { totalBytes = fs.statSync(input).size; } catch { /* progress stays coarse */ }
            }
            nodeFsStream = fs.createReadStream(input);
            bytes = await collectStream(Readable.toWeb(nodeFsStream), onProgress, totalBytes);
        } else if (input instanceof Uint8Array) {
            bytes = input;
        } else if (input instanceof ArrayBuffer) {
            bytes = new Uint8Array(input);
        } else if (input && typeof input.getReader === 'function') {
            bytes = await collectStream(input, onProgress, totalBytes);
        } else if (input && typeof input.pipe === 'function') {
            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
            bytes = await collectStream(Readable.toWeb(input), onProgress, totalBytes);
        } else {
            throw new Error('Unsupported input type for rumcap parser');
        }

        // Outer gunzip by magic bytes (never by extension) — user-gzipped .rcap.gz only.
        if (isGzip(bytes)) {
            onProgress('Decompressing rumcap capture...', 62);
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            bytes = await collectStream(stream, () => {}, 0);
        }

        onProgress('Decoding rumcap capture...', 70);
        const capture = await unpack(bytes);

        if (options.debug) {
            const complaints = checkConsistency(capture);
            if (complaints.length) {
                console.log(`[rumcap.js] checkConsistency reported ${complaints.length} issue(s):`);
                for (const c of complaints) console.log(`[rumcap.js]   - ${c}`);
            } else {
                console.log('[rumcap.js] checkConsistency: clean.');
            }
        }

        onProgress('Building waterfall...', 90);
        const data = captureToWaterfallData(capture, options);

        // Retain the decoded Capture top-level on the relational data (NOT on a page `_`
        // field — those round-trip into getHar() output) for Phase 10c trace synthesis.
        data._rumcapCapture = capture;

        onProgress('Building waterfall...', 100);
        return data;
    } finally {
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }
}
