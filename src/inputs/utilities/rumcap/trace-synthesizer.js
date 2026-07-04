/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
/**
 * @fileoverview rumcap Capture → Chrome-trace-format JSON synthesizer.
 *
 * Produces `{ traceEvents: [...], metadata: {...} }` Chrome-trace JSON from a decoded rumcap
 * Capture. DevTools and Perfetto are separate targets: DevTools keeps the browser timeline
 * event shapes its handlers expect, while Perfetto gets viewer-friendly synthetic duration
 * tracks where Chrome's point-in-time timeline markers would otherwise be noisy.
 *
 * Clock model: rcap timeline values are RelMs from `manifest.clock.timeOrigin`; the synthesized
 * traces use a ZERO base. Chrome-trace JSON uses `ts = Math.round(startTime * 1000)` µs.
 * Native Perfetto TrackEvents write `timestamp_absolute_us` in µs and the packet timestamp in ns.
 * No epoch anchoring is needed (or wanted) — both viewers work on relative bounds.
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
 * DevTools hard requirements honored by `synthesizeChromeTrace()` (see AGENTS.md
 * `DEVTOOLS_REQUIRED_ARG_PATHS`): every `Resource*` event carries `args.data.requestId`;
 * `TracingStartedInBrowser` carries a frames array; `navigationStart` carries
 * documentLoaderURL/isLoadingMainFrame/isOutermostMainFrame/navigationId.
 */

// Fixed synthetic identity — one renderer process, main thread + optional profiler thread.
const PID = 1000;
const TID_MAIN = 1;
const TID_PROFILER = 2;
const PERFETTO_PROCESS_NAME = 'Performance Profile';
// 32-hex-char frame token, same shape as Chrome's real frame GUIDs.
const FRAME_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAARUMCAP';
const NAVIGATION_ID = 'BBBBBBBBBBBBBBBBBBBBBBBBBBRUMCAP';
const PERFETTO_SEQUENCE_ID = 9001;
const PERFETTO_TRACKS = {
    PROCESS: 1000n,
    MAIN: 1001n,
    PROFILE: 1002n,
    REQUESTS: 2000n,
    VITALS: 3000n,
    USER_TIMING: 4000n,
    INTERACTIONS: 5000n,
    LOAF: 6000n,
    CUSTOM_EVENTS: 7000n
};
const TRACK_EVENT = {
    SLICE_BEGIN: 1,
    SLICE_END: 2,
    INSTANT: 3
};
const TRACK_DESCRIPTOR = {
    CHILD_ORDERING_EXPLICIT: 3,
    SIBLING_MERGE_BEHAVIOR_BY_TRACK_NAME: 1,
    SIBLING_MERGE_BEHAVIOR_NONE: 2
};
const PERFETTO_PROFILE_TRACK_ORDER = {
    PAGE_MILESTONES: 1,
    LONG_TASKS: 2,
    LOAF: 3,
    PROFILE: 4,
    USER_TIMING: 5,
    REQUESTS: 6,
    INTERACTIONS: 7,
    CUSTOM_EVENTS: 8
};
const PERFETTO_USER_TIMING_EXTRA_LANE_BASE = 400000n;
const PERFETTO_INTERACTION_EXTRA_LANE_BASE = 500000n;
const textEncoder = new TextEncoder();

/** RelMs → non-negative integer µs on the zero-based trace clock. */
function us(relMs) {
    return Math.max(0, Math.round(relMs * 1000));
}

/** µs → ns for TracePacket.timestamp (default Perfetto packet timestamp unit). */
function packetNs(timestampUs) {
    return BigInt(Math.max(0, Math.trunc(timestampUs))) * 1000n;
}

/** RelMs → seconds (the unit `timing.requestTime` / `finishTime` use in real traces). */
function seconds(relMs) {
    return relMs / 1000;
}

function finiteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function setDefined(target, key, value) {
    if (value !== undefined && value !== null) target[key] = value;
}

class ProtoWriter {
    constructor() {
        this.bytes = [];
    }

    varint(value) {
        let v = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.trunc(value)));
        while (v >= 0x80n) {
            this.bytes.push(Number((v & 0x7fn) | 0x80n));
            v >>= 7n;
        }
        this.bytes.push(Number(v));
    }

    tag(field, wireType) {
        this.varint((BigInt(field) << 3n) | BigInt(wireType));
    }

    uint(field, value) {
        if (value === undefined || value === null) return;
        this.tag(field, 0);
        this.varint(value);
    }

    int(field, value) {
        if (value === undefined || value === null) return;
        this.tag(field, 0);
        this.varint(BigInt.asUintN(64, BigInt(Math.trunc(value))));
    }

    bool(field, value) {
        if (value === undefined || value === null) return;
        this.uint(field, value ? 1 : 0);
    }

    double(field, value) {
        if (!finiteNumber(value)) return;
        this.tag(field, 1);
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, value, true);
        for (const b of new Uint8Array(buf)) this.bytes.push(b);
    }

    string(field, value) {
        if (value === undefined || value === null) return;
        const encoded = textEncoder.encode(String(value));
        this.tag(field, 2);
        this.varint(encoded.length);
        for (const b of encoded) this.bytes.push(b);
    }

    message(field, payload) {
        if (!payload) return;
        const bytes = payload instanceof Uint8Array ? payload : payload.finish();
        this.tag(field, 2);
        this.varint(bytes.length);
        for (const b of bytes) this.bytes.push(b);
    }

    finish() {
        return new Uint8Array(this.bytes);
    }
}

function addDebugAnnotation(eventWriter, name, value) {
    if (value === undefined || value === null) return;
    const annotation = new ProtoWriter();
    annotation.string(10, name);
    if (typeof value === 'boolean') {
        annotation.bool(2, value);
    } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return;
        if (Number.isInteger(value) && value >= 0) annotation.uint(3, value);
        else if (Number.isInteger(value)) annotation.int(4, value);
        else annotation.double(5, value);
    } else if (typeof value === 'string') {
        annotation.string(6, value);
    } else {
        const encoded = encodeDetail(value);
        if (encoded === null) return;
        annotation.string(9, encoded);
    }
    eventWriter.message(4, annotation);
}

function addDebugAnnotations(eventWriter, args) {
    if (!args) return;
    for (const [name, value] of Object.entries(args)) {
        addDebugAnnotation(eventWriter, name, value);
    }
}

class PerfettoProtoBuilder {
    constructor() {
        this.trace = new ProtoWriter();
    }

    packet(timestampUs, fill) {
        const packet = new ProtoWriter();
        if (timestampUs !== undefined) packet.uint(8, packetNs(timestampUs));
        packet.uint(10, PERFETTO_SEQUENCE_ID);
        fill(packet);
        this.trace.message(1, packet);
    }

    trackDescriptor({
        uuid,
        name,
        parentUuid,
        pid,
        tid,
        processName,
        threadName,
        childOrdering,
        siblingOrderRank,
        siblingMergeBehavior
    }) {
        this.packet(0, (packet) => {
            const desc = new ProtoWriter();
            desc.uint(1, uuid);
            desc.string(2, name);
            if (pid !== undefined && tid === undefined) {
                const process = new ProtoWriter();
                process.uint(1, pid);
                process.string(6, processName || name);
                desc.message(3, process);
            }
            if (pid !== undefined && tid !== undefined) {
                const thread = new ProtoWriter();
                thread.uint(1, pid);
                thread.uint(2, tid);
                thread.string(5, threadName || name);
                desc.message(4, thread);
            }
            if (parentUuid !== undefined) desc.uint(5, parentUuid);
            if (childOrdering !== undefined) desc.uint(11, childOrdering);
            if (siblingOrderRank !== undefined) desc.int(12, siblingOrderRank);
            if (siblingMergeBehavior !== undefined) desc.uint(15, siblingMergeBehavior);
            packet.message(60, desc);
        });
    }

    trackEvent(timestampUs, { type, trackUuid, name, categories, args }) {
        this.packet(timestampUs, (packet) => {
            const event = new ProtoWriter();
            event.uint(16, timestampUs);
            if (type !== undefined) event.uint(9, type);
            event.uint(11, trackUuid);
            if (name) event.string(23, name);
            for (const cat of categories || []) event.string(22, cat);
            addDebugAnnotations(event, args);
            packet.message(11, event);
        });
    }

    slice(trackUuid, name, startUs, endUs, categories = [], args = null) {
        const safeEnd = Math.max(startUs, endUs);
        this.trackEvent(startUs, {
            type: TRACK_EVENT.SLICE_BEGIN,
            trackUuid,
            name,
            categories,
            args
        });
        this.trackEvent(safeEnd, {
            type: TRACK_EVENT.SLICE_END,
            trackUuid,
            categories
        });
    }

    instant(trackUuid, name, timestampUs, categories = [], args = null) {
        this.trackEvent(timestampUs, {
            type: TRACK_EVENT.INSTANT,
            trackUuid,
            name,
            categories,
            args
        });
    }

    finish() {
        return this.trace.finish();
    }
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

function responseStatusData(r) {
    const rawStatus = r.responseStatus;
    const hasRealStatus = finiteNumber(rawStatus) && rawStatus > 0;
    return {
        statusAssumed: !hasRealStatus,
        statusCode: hasRealStatus ? rawStatus : 200,
        rawResponseStatus: rawStatus
    };
}

function buildRequestSliceData(r, isNavigation, requestId, eventTimestamps, timing) {
    const status = responseStatusData(r);
    const data = {
        requestId,
        url: r.name || '',
        requestMethod: 'GET',
        priority: derivePriority(r, isNavigation),
        resourceType: deriveResourceType(r, isNavigation),
        isNavigation,
        statusCode: status.statusCode,
        statusAssumed: status.statusAssumed,
        mimeType: r.contentType || '',
        eventTimestamps,
        timing
    };

    setDefined(data, 'rawResponseStatus', status.rawResponseStatus);
    setDefined(data, 'initiatorType', r.initiatorType);
    setDefined(data, 'renderBlockingStatus', r.renderBlockingStatus);
    setDefined(data, 'deliveryType', r.deliveryType);
    setDefined(data, 'protocol', r.nextHopProtocol);

    for (const key of [
        'startTime',
        'duration',
        'redirectStart',
        'redirectEnd',
        'workerStart',
        'fetchStart',
        'domainLookupStart',
        'domainLookupEnd',
        'connectStart',
        'connectEnd',
        'secureConnectionStart',
        'requestStart',
        'firstInterimResponseStart',
        'responseStart',
        'responseEnd',
        'transferSize',
        'encodedBodySize',
        'decodedBodySize'
    ]) {
        setDefined(data, key, r[key]);
    }
    if (Array.isArray(r.serverTiming) && r.serverTiming.length > 0) data.serverTiming = r.serverTiming;
    return data;
}

function requestProtoArgs(data) {
    const args = {
        request_id: data.requestId,
        url: data.url,
        method: data.requestMethod,
        priority: data.priority,
        resource_type: data.resourceType,
        is_navigation: data.isNavigation,
        status_code: data.statusCode,
        status_assumed: data.statusAssumed,
        mime_type: data.mimeType,
        request_duration_ms: data.requestDuration
    };
    setDefined(args, 'raw_response_status', data.rawResponseStatus);
    setDefined(args, 'initiator_type', data.initiatorType);
    setDefined(args, 'render_blocking_status', data.renderBlockingStatus);
    setDefined(args, 'delivery_type', data.deliveryType);
    setDefined(args, 'protocol', data.protocol);
    for (const [name, value] of Object.entries(data.eventTimestamps || {})) {
        args[`event_${name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}_ms`] = value;
    }
    for (const [name, value] of Object.entries(data.timing || {})) {
        if (finiteNumber(value) && value >= 0) {
            args[`timing_${name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`] = value;
        }
    }
    for (const key of [
        'startTime',
        'duration',
        'redirectStart',
        'redirectEnd',
        'workerStart',
        'fetchStart',
        'domainLookupStart',
        'domainLookupEnd',
        'connectStart',
        'connectEnd',
        'secureConnectionStart',
        'requestStart',
        'firstInterimResponseStart',
        'responseStart',
        'responseEnd'
    ]) {
        const argName = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
        setDefined(args, `${argName}_ms`, data[key]);
    }
    if (data.transferSize !== undefined) args.transfer_size_bytes = data.transferSize;
    if (data.encodedBodySize !== undefined) args.encoded_body_size_bytes = data.encodedBodySize;
    if (data.decodedBodySize !== undefined) args.decoded_body_size_bytes = data.decodedBodySize;
    if (data.serverTiming) args.server_timing = data.serverTiming;
    return args;
}

function requestPhaseCategory(phase) {
    return `request.${phase.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/\s+/g, '_').toLowerCase()}`;
}

function requestPhaseDisplayName(phase, requestName) {
    return (phase.category === 'request.content_download' || phase.category === 'request.request')
        ? requestName : phase.name;
}

function msValue(v) {
    return finiteNumber(v) ? v : undefined;
}

function hasRequestComponentTimings(r) {
    return [
        r.domainLookupStart,
        r.domainLookupEnd,
        r.connectStart,
        r.connectEnd,
        r.secureConnectionStart,
        r.requestStart,
        r.responseStart
    ].some(finiteNumber);
}

function buildPerfettoRequestPhases(r, startMs, finishMs, requestArgs) {
    const safeFinishMs = Math.max(startMs, finishMs);
    if (!hasRequestComponentTimings(r) || safeFinishMs <= startMs) {
        return [{ name: 'Request', category: requestPhaseCategory('Request'), startMs, endMs: safeFinishMs, args: requestArgs }];
    }

    const phases = [];
    let cursor = startMs;
    let attachedDebugArgs = false;

    const addPhase = (name, rawStart, rawEnd, args = null) => {
        if (!finiteNumber(rawStart) || !finiteNumber(rawEnd)) return;
        const phaseStart = Math.max(startMs, Math.max(cursor, rawStart));
        const phaseEnd = Math.min(safeFinishMs, Math.max(phaseStart, rawEnd));
        if (phaseEnd <= phaseStart) return;
        phases.push({ name, category: requestPhaseCategory(name), startMs: phaseStart, endMs: phaseEnd, args });
        cursor = phaseEnd;
        if (args) attachedDebugArgs = true;
    };

    const addWaitingUntil = (targetMs) => {
        if (finiteNumber(targetMs)) addPhase('Waiting', cursor, targetMs);
    };

    const fetchStart = msValue(r.fetchStart);
    if (fetchStart !== undefined && fetchStart > cursor) addPhase('Queueing', cursor, fetchStart);

    const dnsStart = msValue(r.domainLookupStart);
    const dnsEnd = msValue(r.domainLookupEnd);
    if (dnsStart !== undefined && dnsEnd !== undefined) {
        addWaitingUntil(dnsStart);
        addPhase('DNS', dnsStart, dnsEnd);
    }

    const connectStart = msValue(r.connectStart);
    const connectEnd = msValue(r.connectEnd);
    const tlsStart = msValue(r.secureConnectionStart);
    if (connectStart !== undefined && connectEnd !== undefined) {
        const socketEnd = tlsStart !== undefined && tlsStart > connectStart && tlsStart < connectEnd
            ? tlsStart : connectEnd;
        addWaitingUntil(connectStart);
        addPhase('Socket', connectStart, socketEnd);
        if (tlsStart !== undefined && connectEnd > tlsStart) addPhase('TLS', tlsStart, connectEnd);
    }

    const requestStart = msValue(r.requestStart);
    const responseStart = msValue(r.responseStart);
    if (requestStart !== undefined) {
        addWaitingUntil(requestStart);
        if (responseStart !== undefined) addPhase('TTFB', requestStart, responseStart);
    } else if (responseStart !== undefined) {
        addPhase('TTFB', cursor, responseStart);
    }

    if (responseStart !== undefined) {
        addPhase('Content Download', responseStart, safeFinishMs, requestArgs);
    } else {
        addPhase('Request', cursor, safeFinishMs, requestArgs);
    }

    if (!attachedDebugArgs) {
        if (phases.length > 0) {
            phases[phases.length - 1] = { ...phases[phases.length - 1], args: requestArgs };
        } else {
            phases.push({ name: 'Request', category: requestPhaseCategory('Request'), startMs, endMs: safeFinishMs, args: requestArgs });
        }
    }

    return phases;
}

function addProcessTracks(builder, {
    hasRequestsTrack,
    hasPageMilestonesTrack,
    hasLongTaskTrack,
    hasProfilerTrack,
    hasUserTimingTrack,
    hasInteractionsTrack,
    hasLoafTrack,
    hasCustomEventsTrack
}) {
    builder.trackDescriptor({
        uuid: PERFETTO_TRACKS.PROCESS,
        name: PERFETTO_PROCESS_NAME,
        childOrdering: TRACK_DESCRIPTOR.CHILD_ORDERING_EXPLICIT
    });
    if (hasPageMilestonesTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.VITALS,
            name: 'Page Milestones',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.PAGE_MILESTONES
        });
    }
    if (hasLongTaskTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.MAIN,
            name: 'Long Tasks',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.LONG_TASKS
        });
    }
    if (hasLoafTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.LOAF,
            name: 'Long Animation Frames',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.LOAF
        });
    }
    if (hasProfilerTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.PROFILE,
            name: 'JS Self-Profiling',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.PROFILE
        });
    }
    if (hasUserTimingTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.USER_TIMING,
            name: 'User Timing',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.USER_TIMING,
            siblingMergeBehavior: TRACK_DESCRIPTOR.SIBLING_MERGE_BEHAVIOR_BY_TRACK_NAME
        });
    }
    if (hasRequestsTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.REQUESTS,
            name: 'Requests',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.REQUESTS,
            childOrdering: TRACK_DESCRIPTOR.CHILD_ORDERING_EXPLICIT
        });
    }
    if (hasInteractionsTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.INTERACTIONS,
            name: 'Interactions',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.INTERACTIONS,
            siblingMergeBehavior: TRACK_DESCRIPTOR.SIBLING_MERGE_BEHAVIOR_BY_TRACK_NAME
        });
    }
    if (hasCustomEventsTrack) {
        builder.trackDescriptor({
            uuid: PERFETTO_TRACKS.CUSTOM_EVENTS,
            name: 'Custom Events',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.CUSTOM_EVENTS
        });
    }
}

function addPerfettoRequestTracks(builder, resources) {
    const sortedResources = resources
        .map((item, index) => ({ ...item, index }))
        .sort((a, b) => {
            const aStart = finiteNumber(a.r.startTime) ? a.r.startTime : 0;
            const bStart = finiteNumber(b.r.startTime) ? b.r.startTime : 0;
            return aStart - bStart || a.index - b.index;
        });
    let requestSeq = 0;
    for (const { r, isNavigation } of sortedResources) {
        const requestId = `rumcap.${++requestSeq}`;
        const displayName = r.name || requestId;
        const startMs = finiteNumber(r.startTime) ? r.startTime : 0;
        const sendMs = r.requestStart !== undefined ? r.requestStart
            : (r.fetchStart !== undefined ? r.fetchStart : startMs);
        const endMs = r.responseEnd !== undefined ? r.responseEnd : startMs + (r.duration || 0);
        const finishMs = Math.max(startMs, endMs);
        const eventTimestamps = {
            ResourceWillSendRequest: startMs,
            ResourceSendRequest: sendMs
        };
        if (r.responseStart !== undefined) eventTimestamps.ResourceReceiveResponse = r.responseStart;
        eventTimestamps.ResourceFinish = finishMs;
        const data = buildRequestSliceData(r, isNavigation, requestId, eventTimestamps, buildTimingBlock(r));
        data.requestDuration = finishMs - startMs;
        const requestArgs = requestProtoArgs(data);
        const uuid = 100000n + BigInt(requestSeq);
        builder.trackDescriptor({
            uuid,
            name: displayName,
            parentUuid: PERFETTO_TRACKS.REQUESTS,
            siblingOrderRank: requestSeq,
            siblingMergeBehavior: TRACK_DESCRIPTOR.SIBLING_MERGE_BEHAVIOR_NONE
        });
        for (const phase of buildPerfettoRequestPhases(r, startMs, finishMs, requestArgs)) {
            builder.slice(uuid, requestPhaseDisplayName(phase, displayName), us(phase.startMs), us(phase.endMs), [phase.category], phase.args);
        }
    }
}

function addPerfettoProfile(builder, profile) {
    if (!profile || !Array.isArray(profile.slices) || profile.slices.length === 0) return;
    const frames = profile.frames || [];
    const resourceUrls = profile.resources || [];
    const stack = [];
    for (const slice of profile.slices) {
        if (!slice || slice.start === undefined) continue;
        const depth = slice.depth || 0;
        while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
        let start = us(slice.start);
        let end = us(slice.start + (slice.duration || 0));
        const parent = stack.length > 0 ? stack[stack.length - 1] : null;
        if (parent) {
            start = Math.min(Math.max(start, parent.start), parent.end);
            end = Math.min(Math.max(end, start), parent.end);
        }
        const frame = frames[slice.frameId];
        const name = (frame && frame.name)
            || (frame && frame.resourceId !== undefined && urlBasename(resourceUrls[frame.resourceId]))
            || '(anonymous)';
        builder.slice(PERFETTO_TRACKS.PROFILE, name, start, end, ['devtools.timeline'], {
            depth,
            frame_id: slice.frameId
        });
        stack.push({ depth, start, end });
    }
}

function loafFrameArgs(frame) {
    const args = { duration_ms: frame.duration || 0 };
    setDefined(args, 'blocking_duration_ms', frame.blockingDuration);
    setDefined(args, 'render_start_ms', frame.renderStart);
    setDefined(args, 'style_and_layout_start_ms', frame.styleAndLayoutStart);
    setDefined(args, 'first_ui_event_timestamp_ms', frame.firstUIEventTimestamp);
    setDefined(args, 'paint_time_ms', frame.paintTime);
    setDefined(args, 'presentation_time_ms', frame.presentationTime);
    if (Array.isArray(frame.scripts)) args.num_scripts = frame.scripts.length;
    return args;
}

function loafScriptArgs(script) {
    const args = {};
    setDefined(args, 'invoker_type', script.invokerType);
    setDefined(args, 'invoker', script.invoker);
    setDefined(args, 'execution_start_ms', script.executionStart);
    setDefined(args, 'forced_style_and_layout_duration_ms', script.forcedStyleAndLayoutDuration);
    setDefined(args, 'pause_duration_ms', script.pauseDuration);
    setDefined(args, 'source_url', script.sourceURL);
    setDefined(args, 'source_function_name', script.sourceFunctionName);
    setDefined(args, 'source_char_position', script.sourceCharPosition);
    setDefined(args, 'window_attribution', script.windowAttribution);
    setDefined(args, 'duration_ms', script.duration);
    return args;
}

function loafScriptName(script, index) {
    const source = script.sourceFunctionName || urlBasename(script.sourceURL) || script.invoker || `Script ${index}`;
    return `Script: ${source}`;
}

function addPerfettoLoafScript(builder, script, index, startMs, endMs) {
    if (endMs <= startMs) return;
    const track = PERFETTO_TRACKS.LOAF;
    const name = loafScriptName(script, index);
    builder.trackEvent(us(startMs), {
        type: TRACK_EVENT.SLICE_BEGIN,
        trackUuid: track,
        name,
        categories: ['loaf.script'],
        args: loafScriptArgs(script)
    });
    const executionStart = script.executionStart !== undefined
        ? Math.min(Math.max(script.executionStart, startMs), endMs)
        : undefined;
    if (executionStart !== undefined && executionStart > startMs && executionStart < endMs) {
        builder.slice(track, 'Script Execution', us(executionStart), us(endMs), ['loaf.script.execution'], {
            source_url: script.sourceURL || '',
            source_function_name: script.sourceFunctionName || '',
            duration_ms: endMs - executionStart
        });
    }
    builder.trackEvent(us(endMs), {
        type: TRACK_EVENT.SLICE_END,
        trackUuid: track,
        categories: ['loaf.script']
    });
}

function addPerfettoLoafScripts(builder, scripts, startMs, endMs, indexRef) {
    for (const script of scripts) {
        if (script.startTime >= endMs || script.startTime + script.duration <= startMs) continue;
        const sliceStart = Math.max(startMs, script.startTime);
        const sliceEnd = Math.min(endMs, script.startTime + script.duration);
        addPerfettoLoafScript(builder, script, ++indexRef.value, sliceStart, sliceEnd);
    }
}

function addPerfettoLoafFrame(builder, frame, index) {
    const frameStart = frame.startTime;
    const frameEnd = frame.startTime + (finiteNumber(frame.duration) ? Math.max(0, frame.duration) : 0);
    const track = PERFETTO_TRACKS.LOAF;
    const frameStartUs = us(frameStart);
    const frameEndUs = us(frameEnd);

    builder.trackEvent(frameStartUs, {
        type: TRACK_EVENT.SLICE_BEGIN,
        trackUuid: track,
        name: 'LongAnimationFrame',
        categories: ['loaf.frame'],
        args: { frame_index: index, ...loafFrameArgs(frame) }
    });

    const scripts = Array.isArray(frame.scripts)
        ? [...frame.scripts]
            .filter(s => s && finiteNumber(s.startTime) && finiteNumber(s.duration) && s.duration > 0)
            .sort((a, b) => a.startTime - b.startTime)
        : [];
    const rawRenderStart = finiteNumber(frame.renderStart) ? frame.renderStart : undefined;
    const renderStart = rawRenderStart !== undefined && rawRenderStart >= frameStart && rawRenderStart < frameEnd
        ? rawRenderStart : undefined;
    const rawStyleStart = finiteNumber(frame.styleAndLayoutStart) ? frame.styleAndLayoutStart : undefined;
    const styleStart = renderStart !== undefined
        && rawStyleStart !== undefined
        && rawStyleStart >= renderStart
        && rawStyleStart < frameEnd
        ? rawStyleStart : undefined;
    const scriptSeq = { value: 0 };
    addPerfettoLoafScripts(builder, scripts.filter(s => renderStart === undefined || s.startTime < renderStart), frameStart, renderStart ?? frameEnd, scriptSeq);

    if (renderStart !== undefined && renderStart < frameEnd) {
        builder.trackEvent(us(renderStart), {
            type: TRACK_EVENT.SLICE_BEGIN,
            trackUuid: track,
            name: 'Render',
            categories: ['loaf.render'],
            args: {
                render_start_ms: frame.renderStart,
                duration_ms: frameEnd - renderStart
            }
        });
        addPerfettoLoafScripts(
            builder,
            scripts.filter(s => s.startTime >= renderStart && (styleStart === undefined || s.startTime < styleStart)),
            renderStart,
            styleStart ?? frameEnd,
            scriptSeq
        );
        if (styleStart !== undefined && styleStart < frameEnd) {
            builder.trackEvent(us(styleStart), {
                type: TRACK_EVENT.SLICE_BEGIN,
                trackUuid: track,
                name: 'Style & Layout',
                categories: ['loaf.style_layout'],
                args: {
                    style_and_layout_start_ms: frame.styleAndLayoutStart,
                    duration_ms: frameEnd - styleStart
                }
            });
            addPerfettoLoafScripts(
                builder,
                scripts.filter(s => s.startTime >= styleStart),
                styleStart,
                frameEnd,
                scriptSeq
            );
            builder.trackEvent(frameEndUs, {
                type: TRACK_EVENT.SLICE_END,
                trackUuid: track,
                categories: ['loaf.style_layout']
            });
        }
        builder.trackEvent(frameEndUs, {
            type: TRACK_EVENT.SLICE_END,
            trackUuid: track,
            categories: ['loaf.render']
        });
    }

    builder.trackEvent(frameEndUs, {
        type: TRACK_EVENT.SLICE_END,
        trackUuid: track,
        categories: ['loaf.frame']
    });
}

const USER_TIMING_BOUNDARY_EPSILON_MS = 0.5;
const USER_TIMING_BOUNDARY_WORDS = {
    start: new Set(['start', 'begin']),
    end: new Set(['end', 'stop', 'finish'])
};
const USER_TIMING_IGNORED_TOKENS = new Set([
    'mark',
    'measure',
    'start',
    'begin',
    'end',
    'stop',
    'finish'
]);

function normalizedUserTimingName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function userTimingTokens(name) {
    return normalizedUserTimingName(name)
        .split(/[^a-z0-9]+/)
        .filter(token => token && !USER_TIMING_IGNORED_TOKENS.has(token));
}

function hasBoundaryWord(name, kind) {
    const words = USER_TIMING_BOUNDARY_WORDS[kind];
    return normalizedUserTimingName(name)
        .split(/[^a-z0-9]+/)
        .some(token => words.has(token));
}

function hasMeasureBoundarySuffix(markName, measureName, kind) {
    const mark = normalizedUserTimingName(markName);
    const measure = normalizedUserTimingName(measureName);
    if (!mark.startsWith(measure) || mark.length === measure.length) return false;
    const suffix = mark.slice(measure.length).replace(/^[\s:_./-]+/, '').replace(/[\s:_./-]+$/, '');
    return USER_TIMING_BOUNDARY_WORDS[kind].has(suffix);
}

function sharesMeasureIdentity(markName, measureName) {
    const markTokens = new Set(userTimingTokens(markName));
    const measureTokens = new Set(userTimingTokens(measureName));
    if (markTokens.size === 0 || measureTokens.size === 0) return false;
    let shared = 0;
    for (const token of markTokens) {
        if (measureTokens.has(token)) shared++;
    }
    return shared >= Math.min(2, measureTokens.size);
}

function isUserTimingMeasureBoundaryMark(mark, measures) {
    if (!mark || mark.name === undefined || !finiteNumber(mark.startTime)) return false;
    for (const measure of measures) {
        if (!measure || measure.name === undefined || !finiteNumber(measure.startTime)) continue;
        const duration = finiteNumber(measure.duration) ? Math.max(0, measure.duration) : 0;
        const boundaries = [
            { kind: 'start', time: measure.startTime },
            { kind: 'end', time: measure.startTime + duration }
        ];
        for (const boundary of boundaries) {
            if (Math.abs(mark.startTime - boundary.time) > USER_TIMING_BOUNDARY_EPSILON_MS) continue;
            if (hasMeasureBoundarySuffix(mark.name, measure.name, boundary.kind)) return true;
            if (hasBoundaryWord(mark.name, boundary.kind) && sharesMeasureIdentity(mark.name, measure.name)) return true;
        }
    }
    return false;
}

function userTimingArgs(entry) {
    const args = { start_time_ms: entry.startTime };
    setDefined(args, 'duration_ms', entry.duration);
    if (finiteNumber(entry.startTime) && finiteNumber(entry.duration)) {
        args.end_time_ms = entry.startTime + Math.max(0, entry.duration);
    }
    if (entry.detail !== undefined) args.detail = entry.detail;
    return args;
}

function userTimingLaneUuid(lane) {
    return lane === 0 ? PERFETTO_TRACKS.USER_TIMING : PERFETTO_USER_TIMING_EXTRA_LANE_BASE + BigInt(lane);
}

function allocateUserTimingMeasureLanes(measures) {
    const lanes = [];
    return measures
        .map((measure, index) => {
            const duration = finiteNumber(measure.duration) ? Math.max(0, measure.duration) : 0;
            return {
                measure: { ...measure, duration },
                index,
                startMs: measure.startTime,
                endMs: measure.startTime + duration
            };
        })
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.index - b.index)
        .map((item) => {
            let lane = lanes.findIndex(endMs => endMs <= item.startMs);
            if (lane < 0) {
                lane = lanes.length;
                lanes.push(item.endMs);
            } else {
                lanes[lane] = item.endMs;
            }
            return { ...item, lane };
        });
}

function addPerfettoUserTimingLaneTracks(builder, laneCount) {
    for (let lane = 1; lane < laneCount; lane++) {
        builder.trackDescriptor({
            uuid: userTimingLaneUuid(lane),
            name: 'User Timing',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.USER_TIMING,
            siblingMergeBehavior: TRACK_DESCRIPTOR.SIBLING_MERGE_BEHAVIOR_BY_TRACK_NAME
        });
    }
}

function addPerfettoUserTiming(builder, userTiming) {
    if (!userTiming) return;
    const measures = (userTiming.measures || [])
        .filter(m => m && m.name !== undefined && finiteNumber(m.startTime));
    const measureLanes = allocateUserTimingMeasureLanes(measures);
    addPerfettoUserTimingLaneTracks(builder, measureLanes.reduce((max, item) => Math.max(max, item.lane + 1), 1));
    for (const m of userTiming.marks || []) {
        if (!m || m.name === undefined || !finiteNumber(m.startTime)) continue;
        if (isUserTimingMeasureBoundaryMark(m, measures)) continue;
        const args = userTimingArgs(m);
        builder.instant(PERFETTO_TRACKS.USER_TIMING, m.name, us(m.startTime), ['blink.user_timing.mark'], args);
    }
    for (const { measure, lane, startMs, endMs } of measureLanes) {
        const args = userTimingArgs(measure);
        builder.slice(
            userTimingLaneUuid(lane),
            measure.name,
            us(startMs),
            us(endMs),
            ['blink.user_timing.measure'],
            args
        );
    }
}

function interactionLaneUuid(lane) {
    return lane === 0 ? PERFETTO_TRACKS.INTERACTIONS : PERFETTO_INTERACTION_EXTRA_LANE_BASE + BigInt(lane);
}

function allocateInteractionLanes(events) {
    const lanes = [];
    return events
        .map((event, index) => {
            const duration = finiteNumber(event.duration) ? Math.max(0, event.duration) : 0;
            return {
                event: { ...event, duration },
                index,
                startMs: event.startTime,
                endMs: event.startTime + duration
            };
        })
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.index - b.index)
        .map((item) => {
            let lane = lanes.findIndex(endMs => endMs <= item.startMs);
            if (lane < 0) {
                lane = lanes.length;
                lanes.push(item.endMs);
            } else {
                lanes[lane] = item.endMs;
            }
            return { ...item, lane };
        });
}

function addPerfettoInteractionLaneTracks(builder, laneCount) {
    for (let lane = 1; lane < laneCount; lane++) {
        builder.trackDescriptor({
            uuid: interactionLaneUuid(lane),
            name: 'Interactions',
            parentUuid: PERFETTO_TRACKS.PROCESS,
            siblingOrderRank: PERFETTO_PROFILE_TRACK_ORDER.INTERACTIONS,
            siblingMergeBehavior: TRACK_DESCRIPTOR.SIBLING_MERGE_BEHAVIOR_BY_TRACK_NAME
        });
    }
}

function addPerfettoInteractions(builder, interactions) {
    if (!interactions) return;
    const events = (interactions.events || [])
        .filter(ev => ev && ev.startTime !== undefined);
    const eventLanes = allocateInteractionLanes(events);
    addPerfettoInteractionLaneTracks(builder, eventLanes.reduce((max, item) => Math.max(max, item.lane + 1), 1));
    for (const { event, lane, startMs, endMs } of eventLanes) {
        const args = {
            interaction_id: event.interactionId || 0,
            duration_ms: event.duration || 0
        };
        setDefined(args, 'processing_start_ms', event.processingStart);
        setDefined(args, 'processing_end_ms', event.processingEnd);
        setDefined(args, 'cancelable', event.cancelable);
        builder.slice(
            interactionLaneUuid(lane),
            event.name || 'EventTiming',
            us(startMs),
            us(endMs),
            ['devtools.timeline'],
            args
        );
    }
}

function hasPerfettoPageMilestones(capture, nav, streams) {
    if (nav) return true;
    if (streamPresent(capture, 'paint') && streams.paint) {
        const fp = streams.paint.firstPaint;
        const fcp = streams.paint.firstContentfulPaint;
        if ((fp && fp.startTime !== undefined) || (fcp && fcp.startTime !== undefined)) return true;
    }
    if (streamPresent(capture, 'lcp') && streams.lcp) {
        const list = [...(streams.lcp.candidates || [])];
        if (streams.lcp.final) list.push(streams.lcp.final);
        if (list.some(c => c && c.startTime !== undefined)) return true;
    }
    if (streamPresent(capture, 'cls') && streams.cls && Array.isArray(streams.cls.shifts)) {
        return streams.cls.shifts.some(s => s && s.startTime !== undefined && typeof s.value === 'number');
    }
    return false;
}

function hasPerfettoLongTasks(capture, streams) {
    return !!(streamPresent(capture, 'longTasks') && streams.longTasks
        && (streams.longTasks.tasks || []).some(t => t && t.startTime !== undefined && t.duration >= 50));
}

function hasPerfettoUserTiming(userTiming) {
    if (!userTiming) return false;
    const measures = (userTiming.measures || [])
        .filter(m => m && m.name !== undefined && finiteNumber(m.startTime));
    if (measures.length > 0) return true;
    return (userTiming.marks || []).some(m => m && m.name !== undefined
        && finiteNumber(m.startTime)
        && !isUserTimingMeasureBoundaryMark(m, measures));
}

function hasPerfettoInteractions(capture, streams) {
    return !!(streamPresent(capture, 'interactions') && streams.interactions
        && (streams.interactions.events || []).some(ev => ev && ev.startTime !== undefined));
}

function hasPerfettoLoaf(capture, streams) {
    return !!(streamPresent(capture, 'loaf') && streams.loaf
        && (streams.loaf.frames || []).some(f => f && f.startTime !== undefined));
}

function hasPerfettoCustomEvents(capture, streams) {
    return !!(streamPresent(capture, 'customEvents') && streams.customEvents
        && (streams.customEvents.tracks || []).some(track => track && track.namespace
            && (track.events || []).some(ev => ev && ev.name !== undefined && ev.start !== undefined)));
}

/**
 * Synthesize a Chrome-trace-format JSON object from a decoded rumcap Capture.
 * @param {Object} capture - decoded rumcap Capture (`unpack()` output)
 * @returns {{traceEvents: Array<Object>, metadata: Object}}
 */
function synthesizeTrace(capture) {
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
        const startMs = finiteNumber(r.startTime) ? r.startTime : 0;
        const startTs = us(startMs);
        const sendMs = r.requestStart !== undefined ? r.requestStart
            : (r.fetchStart !== undefined ? r.fetchStart : startMs);
        const endMs = r.responseEnd !== undefined ? r.responseEnd : startMs + (r.duration || 0);
        const finishMs = Math.max(startMs, endMs);
        const timing = buildTimingBlock(r);

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
            const status = responseStatusData(r);
            const responseData = {
                frame: FRAME_ID,
                requestId,
                statusCode: status.statusCode,
                statusAssumed: status.statusAssumed,
                mimeType: r.contentType || '',
                encodedDataLength: r.transferSize !== undefined ? r.transferSize : 0,
                fromCache: false,
                fromServiceWorker: false,
                connectionId: 0,
                connectionReused: false,
                protocol: r.nextHopProtocol || '',
                timing
            };
            setDefined(responseData, 'rawResponseStatus', status.rawResponseStatus);
            events.push({
                args: { data: responseData },
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
                    finishTime: seconds(finishMs)
                }
            },
            cat: 'devtools.timeline', name: 'ResourceFinish',
            ph: 'I', pid: PID, s: 't', tid: TID_MAIN, ts: us(finishMs)
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
            target: 'devtools',
            rumcapFormatVersion: capture.formatVersion
        }
    };
}

export function synthesizePerfettoProto(capture, _options = {}) {
    const streams = capture.streams || {};
    const nav = streamPresent(capture, 'navigation') ? streams.navigation : null;
    const profile = streamPresent(capture, 'profile') ? streams.profile : null;
    const hasProfilerTrack = !!(profile && Array.isArray(profile.slices) && profile.slices.length > 0);
    const resources = [];
    if (nav) resources.push({ r: nav, isNavigation: true });
    if (streamPresent(capture, 'resources')) {
        for (const r of streams.resources || []) resources.push({ r, isNavigation: false });
    }
    const hasUserTimingTrack = streamPresent(capture, 'userTiming') && hasPerfettoUserTiming(streams.userTiming);
    const builder = new PerfettoProtoBuilder();

    addProcessTracks(builder, {
        hasRequestsTrack: resources.length > 0,
        hasPageMilestonesTrack: hasPerfettoPageMilestones(capture, nav, streams),
        hasLongTaskTrack: hasPerfettoLongTasks(capture, streams),
        hasProfilerTrack,
        hasUserTimingTrack,
        hasInteractionsTrack: hasPerfettoInteractions(capture, streams),
        hasLoafTrack: hasPerfettoLoaf(capture, streams),
        hasCustomEventsTrack: hasPerfettoCustomEvents(capture, streams)
    });

    addPerfettoRequestTracks(builder, resources);

    if (nav) {
        builder.instant(PERFETTO_TRACKS.VITALS, 'navigationStart', us(nav.startTime || 0), ['blink.user_timing'], {
            url: nav.name || '',
            navigation_id: NAVIGATION_ID
        });
        if (nav.domContentLoadedEventStart !== undefined) {
            builder.instant(PERFETTO_TRACKS.VITALS, 'MarkDOMContent', us(nav.domContentLoadedEventStart), ['devtools.timeline'], {
                url: nav.name || ''
            });
        }
        if (nav.loadEventStart !== undefined) {
            builder.instant(PERFETTO_TRACKS.VITALS, 'MarkLoad', us(nav.loadEventStart), ['devtools.timeline'], {
                url: nav.name || ''
            });
        }
    }

    if (streamPresent(capture, 'paint') && streams.paint) {
        const fp = streams.paint.firstPaint;
        if (fp && fp.startTime !== undefined) {
            builder.instant(PERFETTO_TRACKS.VITALS, 'firstPaint', us(fp.startTime), ['loading', 'rail'], {
                navigation_id: NAVIGATION_ID
            });
        }
        const fcp = streams.paint.firstContentfulPaint;
        if (fcp && fcp.startTime !== undefined) {
            builder.instant(PERFETTO_TRACKS.VITALS, 'firstContentfulPaint', us(fcp.startTime), ['loading', 'rail'], {
                navigation_id: NAVIGATION_ID
            });
        }
    }

    if (streamPresent(capture, 'lcp') && streams.lcp) {
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
            const args = {
                candidate_index: ++candidateIndex,
                navigation_id: NAVIGATION_ID,
                size: c.size !== undefined ? c.size : 0,
                type: c.url !== undefined ? 'image' : 'text'
            };
            setDefined(args, 'url', c.url);
            if (c.element && c.element.selector) args.node_name = c.element.selector;
            builder.instant(PERFETTO_TRACKS.VITALS, 'largestContentfulPaint::Candidate', us(tMs), ['loading', 'rail'], args);
        }
    }

    if (streamPresent(capture, 'cls') && streams.cls && Array.isArray(streams.cls.shifts)) {
        let cumulative = 0;
        const sorted = [...streams.cls.shifts].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
        for (const s of sorted) {
            if (!s || s.startTime === undefined || typeof s.value !== 'number') continue;
            if (s.hadRecentInput === false) cumulative += s.value;
            const args = {
                cumulative_score: cumulative,
                had_recent_input: !!s.hadRecentInput,
                score: s.value,
                weighted_score_delta: s.value
            };
            setDefined(args, 'last_input_time_ms', s.lastInputTime);
            builder.instant(PERFETTO_TRACKS.VITALS, 'LayoutShift', us(s.startTime), ['loading'], args);
        }
    }

    if (streamPresent(capture, 'interactions') && streams.interactions) {
        addPerfettoInteractions(builder, streams.interactions);
    }

    if (streamPresent(capture, 'loaf') && streams.loaf) {
        let loafSeq = 0;
        for (const f of streams.loaf.frames || []) {
            if (!f || f.startTime === undefined) continue;
            addPerfettoLoafFrame(builder, f, ++loafSeq);
        }
    }

    if (streamPresent(capture, 'longTasks') && streams.longTasks) {
        for (const t of streams.longTasks.tasks || []) {
            if (!t || t.startTime === undefined || !(t.duration >= 50)) continue;
            builder.slice(PERFETTO_TRACKS.MAIN, 'RunTask', us(t.startTime), us(t.startTime + t.duration), ['toplevel'], {
                duration_ms: t.duration
            });
        }
    }

    if (streamPresent(capture, 'userTiming') && streams.userTiming) {
        addPerfettoUserTiming(builder, streams.userTiming);
    }

    if (streamPresent(capture, 'customEvents') && streams.customEvents) {
        let trackSeq = 0;
        for (const track of streams.customEvents.tracks || []) {
            if (!track || !track.namespace) continue;
            const uuid = 700000n + BigInt(++trackSeq);
            builder.trackDescriptor({
                uuid,
                name: track.namespace,
                parentUuid: PERFETTO_TRACKS.CUSTOM_EVENTS
            });
            for (const ev of track.events || []) {
                if (!ev || ev.name === undefined || ev.start === undefined) continue;
                const args = { namespace: track.namespace };
                setDefined(args, 'depth', ev.depth);
                if (ev.details !== undefined) args.details = ev.details;
                builder.slice(uuid, ev.name, us(ev.start), us(ev.start + (ev.duration || 0)), ['waterfall.custom_events'], args);
            }
        }
    }

    addPerfettoProfile(builder, profile);
    return builder.finish();
}

export function synthesizeChromeTrace(capture, _options = {}) {
    return synthesizeTrace(capture, _options);
}
