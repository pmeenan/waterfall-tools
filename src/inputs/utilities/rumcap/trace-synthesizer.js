/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview rumcap Capture → Chrome-trace-format JSON synthesizer.
 *
 * Produces `{ traceEvents: [...], metadata: {...} }` — the object-wrapper form DevTools itself
 * saves — from a decoded rumcap Capture. One synthesizer feeds BOTH embedded viewers: the
 * Perfetto UI ingests Chrome JSON natively, and the DevTools Performance panel accepts it (as
 * gzipped JSON) through `TimelinePanel.loadFromFile`.
 *
 * Clock model: rcap timeline values are RelMs from `manifest.clock.timeOrigin`; the synthesized
 * trace uses a ZERO base — `ts = Math.round(startTime * 1000)` microseconds, so page timeOrigin
 * is ts 0. No epoch anchoring is needed (or wanted) — both viewers work on relative bounds.
 *
 * Every event shape below is grounded against real Chrome traces
 * (`Sample/Data/Chrome Traces/roadtrip-devtools.json.gz` — a DevTools Performance-panel
 * capture — and `trace_www.google.com.json.gz` — a wptagent capture) and, where the samples
 * had no instance (user-timing `detail`, extensibility tracks), against the DevTools trace
 * model in `@chrome-devtools/index` itself:
 *   - marks: detail is read from `args.data.detail` as a JSON *string*;
 *   - measures: detail is read from the async BEGIN event's `args.detail` JSON string;
 *   - a `devtools` key inside that parsed detail with `{ track }` (dataType defaults to
 *     'track-entry') creates a named custom track (the React 19 / Vue extensibility contract).
 *
 * DevTools hard requirements honored here (see AGENTS.md `DEVTOOLS_REQUIRED_ARG_PATHS`):
 * every `Resource*` event carries `args.data.requestId`; `TracingStartedInBrowser` carries a
 * frames array; `navigationStart` carries documentLoaderURL/isLoadingMainFrame/
 * isOutermostMainFrame/navigationId.
 */

// Fixed synthetic identity — one renderer process, main thread + optional profiler thread.
const PID = 1000;
const TID_MAIN = 1;
const TID_PROFILER = 2;
// 32-hex-char frame token, same shape as Chrome's real frame GUIDs.
const FRAME_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAARUMCAP';
const NAVIGATION_ID = 'BBBBBBBBBBBBBBBBBBBBBBBBBBRUMCAP';

/** RelMs → non-negative integer µs on the zero-based trace clock. */
function us(relMs) {
    return Math.max(0, Math.round(relMs * 1000));
}

/** RelMs → seconds (the unit `timing.requestTime` / `finishTime` use in real traces). */
function seconds(relMs) {
    return relMs / 1000;
}

/**
 * Is a stream usable for synthesis? The rumcap manifest is total, but hand-built captures
 * (tests) may omit entries — treat a missing manifest entry as present when data exists.
 */
function streamPresent(capture, id) {
    if (!capture.streams || capture.streams[id] === undefined) return false;
    const entry = capture.manifest && capture.manifest.streams && capture.manifest.streams[id];
    return !entry || entry.status === 'present';
}

/**
 * Map a resource onto DevTools' `resourceType` vocabulary (drives row coloring). Derived from
 * initiatorType first (authoritative for how the fetch was made), contentType second.
 */
function deriveResourceType(r, isNavigation) {
    if (isNavigation) return 'Document';
    const t = r.initiatorType || '';
    const ct = r.contentType || '';
    if (t === 'script' || ct.includes('javascript')) return 'Script';
    if (t === 'css' || t === 'link' || ct.includes('text/css')) return 'Stylesheet';
    if (t === 'img' || t === 'image' || ct.startsWith('image/')) return 'Image';
    if (ct.startsWith('font/') || ct.includes('font')) return 'Font';
    if (t === 'xmlhttprequest') return 'XHR';
    if (t === 'fetch') return 'Fetch';
    if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'Media';
    return 'Other';
}

/**
 * Chrome resource priority vocabulary: VeryHigh / High / Medium / Low / VeryLow. rumcap has no
 * wire priority, so derive a sane one: the document and render-blocking resources go VeryHigh
 * (matching Chrome's document/blocking-CSS behavior), scripts/styles/fonts High, images Low.
 */
function derivePriority(r, isNavigation) {
    if (isNavigation) return 'VeryHigh';
    if (r.renderBlockingStatus === 'blocking') return 'VeryHigh';
    const t = r.initiatorType || '';
    if (t === 'script' || t === 'css' || t === 'link') return 'High';
    if (t === 'img' || t === 'image') return 'Low';
    return 'Medium';
}

/**
 * Build the ResourceTiming-derived `timing` block the way real ResourceReceiveResponse events
 * carry it (grounded on trace_www.google.com.json.gz): `requestTime` is SECONDS on the trace
 * clock; every other field is a millisecond OFFSET from requestTime; -1 marks a phase that
 * did not happen (never 0 — 0 is a real "at requestTime" value, used only by push*).
 */
function buildTimingBlock(r) {
    const baseMs = r.fetchStart !== undefined ? r.fetchStart : (r.startTime || 0);
    const off = (v) => (v !== undefined ? Math.max(0, v - baseMs) : -1);
    return {
        requestTime: seconds(baseMs),
        proxyStart: -1,
        proxyEnd: -1,
        dnsStart: off(r.domainLookupStart),
        dnsEnd: off(r.domainLookupEnd),
        connectStart: off(r.connectStart),
        connectEnd: off(r.connectEnd),
        sslStart: off(r.secureConnectionStart),
        // ResourceTiming has no discrete TLS end; the handshake concludes at connectEnd.
        sslEnd: r.secureConnectionStart !== undefined ? off(r.connectEnd) : -1,
        workerStart: off(r.workerStart),
        workerReady: -1,
        sendStart: off(r.requestStart),
        sendEnd: off(r.requestStart),
        pushStart: 0,
        pushEnd: 0,
        receiveHeadersStart: off(r.responseStart),
        receiveHeadersEnd: off(r.responseStart)
    };
}

/** Last path segment of a URL, for profiler frame fallback names. */
function urlBasename(url) {
    if (!url) return null;
    try {
        const path = String(url).split('?')[0].split('#')[0];
        const seg = path.split('/').filter(Boolean).pop();
        return seg || url;
    } catch {
        return url;
    }
}

/**
 * Serialize a user-timing / custom-event detail the way DevTools reads it back: a JSON string.
 * Returns null when the detail cannot be serialized (never throw over telemetry payloads).
 */
function encodeDetail(detail) {
    try {
        return JSON.stringify(detail);
    } catch {
        return null;
    }
}

/**
 * Synthesize a Chrome-trace-format JSON object from a decoded rumcap Capture.
 * @param {Object} capture - decoded rumcap Capture (`unpack()` output)
 * @param {Object} [_options] - reserved
 * @returns {{traceEvents: Array<Object>, metadata: Object}}
 */
export function synthesizeChromeTrace(capture, _options = {}) {
    const streams = capture.streams || {};
    const nav = streamPresent(capture, 'navigation') ? streams.navigation : null;
    const navUrl = (nav && nav.name) || '';
    const events = [];
    // Monotonic id mint for async b/e pairs — unique across ALL async event families so no
    // (cat, id) collision can cross-pair unrelated begins/ends in either viewer.
    let nextAsyncId = 1;
    const mintId = () => `0x${(nextAsyncId++).toString(16)}`;

    const profile = streamPresent(capture, 'profile') ? streams.profile : null;
    const hasProfilerThread = !!(profile && Array.isArray(profile.slices) && profile.slices.length > 0);

    // ── Scaffolding ──────────────────────────────────────────────────────────────────────────
    events.push({ args: { name: 'Renderer' }, cat: '__metadata', name: 'process_name', ph: 'M', pid: PID, tid: 0, ts: 0 });
    events.push({ args: { name: 'CrRendererMain' }, cat: '__metadata', name: 'thread_name', ph: 'M', pid: PID, tid: TID_MAIN, ts: 0 });
    if (hasProfilerThread) {
        events.push({ args: { name: 'JS Self-Profiling' }, cat: '__metadata', name: 'thread_name', ph: 'M', pid: PID, tid: TID_PROFILER, ts: 0 });
    }

    // DevTools' MetaHandler requires the frames array to establish the main frame + renderer pid.
    events.push({
        args: {
            data: {
                frameTreeNodeId: 1,
                frames: [{
                    frame: FRAME_ID,
                    isInPrimaryMainFrame: true,
                    isOutermostMainFrame: true,
                    name: '',
                    processId: PID,
                    url: navUrl
                }]
            }
        },
        cat: 'disabled-by-default-devtools.timeline',
        name: 'TracingStartedInBrowser',
        ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: 0
    });

    events.push({
        args: {
            data: {
                documentLoaderURL: navUrl,
                isLoadingMainFrame: true,
                isOutermostMainFrame: true,
                navigationId: NAVIGATION_ID
            },
            frame: FRAME_ID
        },
        cat: 'blink.user_timing',
        name: 'navigationStart',
        ph: 'R', pid: PID, s: 't', tid: TID_MAIN, ts: us(nav ? (nav.startTime || 0) : 0)
    });

    // ── Network track ────────────────────────────────────────────────────────────────────────
    const resources = [];
    if (nav) resources.push({ r: nav, isNavigation: true });
    if (streamPresent(capture, 'resources')) {
        for (const r of streams.resources || []) resources.push({ r, isNavigation: false });
    }

    let requestSeq = 0;
    for (const { r, isNavigation } of resources) {
        const requestId = `rumcap.${++requestSeq}`;
        const startTs = us(r.startTime || 0);
        const sendMs = r.requestStart !== undefined ? r.requestStart
            : (r.fetchStart !== undefined ? r.fetchStart : (r.startTime || 0));
        const endMs = r.responseEnd !== undefined ? r.responseEnd : (r.startTime || 0) + (r.duration || 0);

        events.push({
            args: { data: { requestId } },
            cat: 'devtools.timeline', name: 'ResourceWillSendRequest',
            ph: 'I', pid: PID, s: 'p', tid: TID_MAIN, ts: startTs
        });

        events.push({
            args: {
                data: {
                    frame: FRAME_ID,
                    requestId,
                    url: r.name,
                    requestMethod: 'GET',
                    priority: derivePriority(r, isNavigation),
                    resourceType: deriveResourceType(r, isNavigation),
                    fetchPriorityHint: 'auto',
                    isLinkPreload: false,
                    initiator: { type: r.initiatorType || 'other' },
                    renderBlocking: r.renderBlockingStatus === 'blocking' ? 'blocking' : 'non_blocking'
                }
            },
            cat: 'devtools.timeline', name: 'ResourceSendRequest',
            ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(sendMs)
        });

        if (r.responseStart !== undefined) {
            events.push({
                args: {
                    data: {
                        frame: FRAME_ID,
                        requestId,
                        statusCode: r.responseStatus !== undefined ? r.responseStatus : 0,
                        mimeType: r.contentType || '',
                        encodedDataLength: r.transferSize !== undefined ? r.transferSize : 0,
                        fromCache: false,
                        fromServiceWorker: false,
                        connectionId: 0,
                        connectionReused: false,
                        protocol: r.nextHopProtocol || '',
                        timing: buildTimingBlock(r)
                    }
                },
                cat: 'devtools.timeline', name: 'ResourceReceiveResponse',
                ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(r.responseStart)
            });
        }

        events.push({
            args: {
                data: {
                    requestId,
                    didFail: false,
                    encodedDataLength: r.transferSize !== undefined ? r.transferSize
                        : (r.encodedBodySize !== undefined ? r.encodedBodySize : 0),
                    decodedBodyLength: r.decodedBodySize !== undefined ? r.decodedBodySize : 0,
                    finishTime: seconds(endMs)
                }
            },
            cat: 'devtools.timeline', name: 'ResourceFinish',
            ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(endMs)
        });
    }

    // ── Milestones & vitals ──────────────────────────────────────────────────────────────────
    const paintCat = 'loading,rail,devtools.timeline';
    if (streamPresent(capture, 'paint') && streams.paint) {
        const fp = streams.paint.firstPaint;
        if (fp && fp.startTime !== undefined) {
            events.push({
                args: { frame: FRAME_ID, data: { navigationId: NAVIGATION_ID } },
                cat: paintCat, name: 'firstPaint', ph: 'R', pid: PID, s: 't', tid: TID_MAIN, ts: us(fp.startTime)
            });
        }
        const fcp = streams.paint.firstContentfulPaint;
        if (fcp && fcp.startTime !== undefined) {
            events.push({
                args: { frame: FRAME_ID, data: { navigationId: NAVIGATION_ID } },
                cat: paintCat, name: 'firstContentfulPaint', ph: 'R', pid: PID, s: 't', tid: TID_MAIN, ts: us(fcp.startTime)
            });
        }
    }

    if (streamPresent(capture, 'lcp') && streams.lcp) {
        // Candidates in order, then the final if it isn't already the last candidate. Each
        // candidate supersedes the previous, mirroring Chrome's candidateIndex sequence.
        const list = [...(streams.lcp.candidates || [])];
        const fin = streams.lcp.final;
        if (fin) {
            const last = list[list.length - 1];
            if (!last || last.startTime !== fin.startTime || last.size !== fin.size) list.push(fin);
        }
        let candidateIndex = 0;
        for (const c of list) {
            if (!c || c.startTime === undefined) continue;
            const tMs = c.renderTime !== undefined ? c.renderTime
                : (c.loadTime !== undefined ? c.loadTime : c.startTime);
            const data = {
                candidateIndex: ++candidateIndex,
                isMainFrame: true,
                isOutermostMainFrame: true,
                navigationId: NAVIGATION_ID,
                size: c.size !== undefined ? c.size : 0,
                type: c.url !== undefined ? 'image' : 'text'
            };
            if (c.element && c.element.selector) data.nodeName = c.element.selector;
            events.push({
                args: { frame: FRAME_ID, data },
                cat: paintCat, name: 'largestContentfulPaint::Candidate',
                ph: 'R', pid: PID, s: 't', tid: TID_MAIN, ts: us(tMs)
            });
        }
    }

    if (streamPresent(capture, 'cls') && streams.cls && Array.isArray(streams.cls.shifts)) {
        // cumulative_score mirrors Chrome: running sum over non-recent-input shifts.
        let cumulative = 0;
        const sorted = [...streams.cls.shifts].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
        for (const s of sorted) {
            if (!s || s.startTime === undefined || typeof s.value !== 'number') continue;
            if (s.hadRecentInput === false) cumulative += s.value;
            const data = {
                cumulative_score: cumulative,
                had_recent_input: !!s.hadRecentInput,
                impacted_nodes: [],
                is_main_frame: true,
                score: s.value,
                weighted_score_delta: s.value
            };
            if (s.lastInputTime !== undefined) data.last_input_timestamp = us(s.lastInputTime);
            events.push({
                args: { frame: FRAME_ID, data },
                cat: 'loading', name: 'LayoutShift', ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(s.startTime)
            });
        }
    }

    if (nav) {
        if (nav.domContentLoadedEventStart !== undefined) {
            events.push({
                args: { data: { frame: FRAME_ID, isMainFrame: true, isOutermostMainFrame: true, page: FRAME_ID } },
                cat: 'devtools.timeline', name: 'MarkDOMContent',
                ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(nav.domContentLoadedEventStart)
            });
        }
        if (nav.loadEventStart !== undefined) {
            events.push({
                args: { data: { frame: FRAME_ID, isMainFrame: true, isOutermostMainFrame: true, page: FRAME_ID } },
                cat: 'devtools.timeline', name: 'MarkLoad',
                ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(nav.loadEventStart)
            });
        }
    }

    if (streamPresent(capture, 'interactions') && streams.interactions) {
        for (const ev of streams.interactions.events || []) {
            if (!ev || ev.startTime === undefined) continue;
            const id = mintId();
            const beginTs = us(ev.startTime);
            const endTs = us(ev.startTime + (ev.duration || 0));
            const data = {
                frame: FRAME_ID,
                type: ev.name,
                duration: ev.duration || 0,
                interactionId: ev.interactionId || 0,
                interactionOffset: 0,
                timeStamp: ev.startTime
            };
            if (ev.processingStart !== undefined) data.processingStart = ev.processingStart;
            if (ev.processingEnd !== undefined) data.processingEnd = ev.processingEnd;
            if (ev.cancelable !== undefined) data.cancelable = ev.cancelable;
            events.push({
                args: { data }, cat: 'devtools.timeline', id, name: 'EventTiming',
                ph: 'b', pid: PID, tid: TID_MAIN, ts: beginTs
            });
            events.push({
                args: {}, cat: 'devtools.timeline', id, name: 'EventTiming',
                ph: 'e', pid: PID, tid: TID_MAIN, ts: Math.max(endTs, beginTs)
            });
        }
    }

    if (streamPresent(capture, 'loaf') && streams.loaf) {
        for (const f of streams.loaf.frames || []) {
            if (!f || f.startTime === undefined) continue;
            const data = { duration: f.duration || 0 };
            if (f.blockingDuration !== undefined) data.blockingDuration = f.blockingDuration;
            if (f.renderStart !== undefined) data.renderStart = f.renderStart;
            if (f.styleAndLayoutStart !== undefined) data.styleAndLayoutStart = f.styleAndLayoutStart;
            if (Array.isArray(f.scripts)) data.numScripts = f.scripts.length;
            events.push({
                args: { data }, cat: 'devtools.timeline', name: 'LongAnimationFrame',
                ph: 'X', pid: PID, tid: TID_MAIN, ts: us(f.startTime), dur: us(f.duration || 0)
            });
        }
    }

    // ── Long tasks — the RunTask X shape DevTools candystripes ───────────────────────────────
    if (streamPresent(capture, 'longTasks') && streams.longTasks) {
        for (const t of streams.longTasks.tasks || []) {
            if (!t || t.startTime === undefined || !(t.duration >= 50)) continue;
            events.push({
                args: {}, cat: 'toplevel', name: 'RunTask',
                ph: 'X', pid: PID, tid: TID_MAIN, ts: us(t.startTime), dur: us(t.duration)
            });
        }
    }

    // ── User Timing ──────────────────────────────────────────────────────────────────────────
    if (streamPresent(capture, 'userTiming') && streams.userTiming) {
        for (const m of streams.userTiming.marks || []) {
            if (!m || m.name === undefined || m.startTime === undefined) continue;
            const data = { navigationId: NAVIGATION_ID, startTime: m.startTime };
            if (m.detail !== undefined) {
                // DevTools reads mark detail from args.data.detail as a JSON string.
                const enc = encodeDetail(m.detail);
                if (enc !== null) data.detail = enc;
            }
            events.push({
                args: { data }, cat: 'blink.user_timing', name: m.name,
                ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(m.startTime)
            });
        }
        for (const m of streams.userTiming.measures || []) {
            if (!m || m.name === undefined || m.startTime === undefined) continue;
            const id = mintId();
            const beginArgs = { startTime: m.startTime };
            if (m.detail !== undefined) {
                // DevTools reads measure detail from the async BEGIN event's args.detail JSON
                // string — a detail.devtools payload passes through verbatim and lights up the
                // extensibility tracks with zero extra work.
                const enc = encodeDetail(m.detail);
                if (enc !== null) beginArgs.detail = enc;
            }
            const beginTs = us(m.startTime);
            events.push({
                args: beginArgs, cat: 'blink.user_timing', id2: { local: id }, name: m.name,
                ph: 'b', pid: PID, tid: TID_MAIN, ts: beginTs
            });
            events.push({
                args: {}, cat: 'blink.user_timing', id2: { local: id }, name: m.name,
                ph: 'e', pid: PID, tid: TID_MAIN, ts: Math.max(us(m.startTime + (m.duration || 0)), beginTs)
            });
        }
    }

    // ── customEvents — one DevTools extensibility track per namespace ────────────────────────
    if (streamPresent(capture, 'customEvents') && streams.customEvents) {
        for (const track of streams.customEvents.tracks || []) {
            if (!track || !track.namespace) continue;
            for (const ev of track.events || []) {
                if (!ev || ev.name === undefined || ev.start === undefined) continue;
                // Detail contract (mirrors what DevTools parses off real React 19 measures):
                // JSON string of { devtools: { track, dataType }, ...userDetail }. A user-supplied
                // devtools payload wins; otherwise synthesize one carrying the namespace so each
                // namespace renders as its own named track. Nesting comes from time containment
                // (begin/end are measured, and rumcap's `depth` events are contained by design).
                let detailObj;
                if (ev.details && typeof ev.details === 'object' && !Array.isArray(ev.details)) {
                    detailObj = { ...ev.details };
                } else if (ev.details !== undefined) {
                    detailObj = { value: ev.details };
                } else {
                    detailObj = {};
                }
                if (!detailObj.devtools) {
                    detailObj.devtools = { dataType: 'track-entry', track: track.namespace };
                }
                const enc = encodeDetail(detailObj);
                const id = mintId();
                const beginTs = us(ev.start);
                const beginArgs = { startTime: ev.start };
                if (enc !== null) beginArgs.detail = enc;
                events.push({
                    args: beginArgs, cat: 'blink.user_timing', id2: { local: id }, name: ev.name,
                    ph: 'b', pid: PID, tid: TID_MAIN, ts: beginTs
                });
                events.push({
                    args: {}, cat: 'blink.user_timing', id2: { local: id }, name: ev.name,
                    ph: 'e', pid: PID, tid: TID_MAIN, ts: Math.max(us(ev.start + (ev.duration || 0)), beginTs)
                });
            }
        }
    }

    // ── Profile → flame chart on the dedicated profiler thread ──────────────────────────────
    if (hasProfilerThread) {
        const frames = profile.frames || [];
        const resourceUrls = profile.resources || [];
        // Slices are pre-order (start asc, depth asc); a slice's parent is the nearest
        // preceding slice at depth-1. X-event flame charts require strict containment, but the
        // wire stores durations on a 1ms grid — rounding can push a child's end past its
        // parent's, so clamp child bounds into the parent's [ts, end] as we walk the stack.
        const stack = []; // [{ depth, ts, end }]
        for (const slice of profile.slices) {
            if (!slice || slice.start === undefined) continue;
            const depth = slice.depth || 0;
            while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
            let ts = us(slice.start);
            let end = us(slice.start + (slice.duration || 0));
            const parent = stack.length > 0 ? stack[stack.length - 1] : null;
            if (parent) {
                ts = Math.min(Math.max(ts, parent.ts), parent.end);
                end = Math.min(Math.max(end, ts), parent.end);
            }
            const frame = frames[slice.frameId];
            const name = (frame && frame.name)
                || (frame && frame.resourceId !== undefined && urlBasename(resourceUrls[frame.resourceId]))
                || '(anonymous)';
            events.push({
                args: {}, cat: 'devtools.timeline', name,
                ph: 'X', pid: PID, tid: TID_PROFILER, ts, dur: end - ts
            });
            stack.push({ depth, ts, end });
        }
    }

    // Metadata (ph M) events lead; everything else sorts by ts. Ties keep emission order
    // (Array.prototype.sort is stable), which preserves b-before-e for zero-length pairs.
    events.sort((a, b) => {
        const aM = a.ph === 'M' ? 0 : 1;
        const bM = b.ph === 'M' ? 0 : 1;
        if (aM !== bM) return aM - bM;
        return a.ts - b.ts;
    });

    return {
        traceEvents: events,
        metadata: {
            source: 'waterfall-tools',
            synthesizedFrom: 'rumcap',
            rumcapFormatVersion: capture.formatVersion
        }
    };
}
