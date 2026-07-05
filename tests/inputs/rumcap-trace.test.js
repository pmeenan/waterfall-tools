/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpack } from 'rumcap/decode';
import { PerfettoDecoder, WaterfallTools } from '../../src/core/waterfall-tools.js';
import { synthesizeChromeTrace, synthesizePerfettoProto } from '../../src/inputs/utilities/rumcap/trace-synthesizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(__dirname, '../../Sample/Data/rumcap/chrome');
const textDecoder = new TextDecoder();

async function loadCapture(fileName) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, fileName)));
    return await unpack(bytes);
}

// Async begin/end pairing key: EventTiming uses `id`, user-timing measures use `id2.local` —
// the same resolution order DevTools uses (id ?? id2.global ?? id2.local).
function asyncKey(e) {
    const id = e.id !== undefined ? e.id : (e.id2 && (e.id2.global !== undefined ? e.id2.global : e.id2.local));
    return `${e.cat}|${e.name}|${id}`;
}

function usForTest(relMs) {
    return Math.max(0, Math.round(relMs * 1000));
}

function finiteNumberForTest(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function eventHasCategory(e, category) {
    return String(e.cat || '').split(',').includes(category);
}

function devtoolsTrackForEvent(e) {
    const detail = e && e.args && e.args.detail;
    if (!detail) return null;
    try {
        return JSON.parse(detail).devtools?.track || null;
    } catch {
        return null;
    }
}

function normalizeProfileSlicesForTest(profile) {
    const slices = [];
    const stack = [];
    for (const slice of profile.slices || []) {
        if (!slice || slice.start === undefined) continue;
        const depth = slice.depth || 0;
        while (stack.length > 0 && slices[stack[stack.length - 1]].depth >= depth) stack.pop();
        let ts = usForTest(slice.start);
        let end = usForTest(slice.start + (slice.duration || 0));
        const parentIndex = stack.length > 0 ? stack[stack.length - 1] : -1;
        if (parentIndex >= 0) {
            const parent = slices[parentIndex];
            ts = Math.min(Math.max(ts, parent.ts), parent.end);
            end = Math.min(Math.max(end, ts), parent.end);
        }
        const index = slices.length;
        slices.push({ depth, end, parentIndex, ts });
        stack.push(index);
    }
    return slices;
}

function allocateUserTimingMeasureLanesForTest(measures) {
    const lanes = [];
    return measures
        .map((measure, index) => {
            const duration = finiteNumberForTest(measure.duration) ? Math.max(0, measure.duration) : 0;
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

function allocateInteractionLanesForTest(events) {
    const lanes = [];
    return events
        .filter(ev => ev && ev.startTime !== undefined)
        .map((event, index) => {
            const duration = finiteNumberForTest(event.duration) ? Math.max(0, event.duration) : 0;
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

function readVarint(bytes, offset) {
    let result = 0n;
    let shift = 0n;
    let o = offset;
    while (o < bytes.length) {
        const b = bytes[o++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return [result, o];
        shift += 7n;
    }
    throw new Error('Truncated varint');
}

function skipProtoField(bytes, offset, wireType) {
    if (wireType === 0) return readVarint(bytes, offset)[1];
    if (wireType === 1) return offset + 8;
    if (wireType === 2) {
        const len = readVarint(bytes, offset);
        return len[1] + Number(len[0]);
    }
    if (wireType === 5) return offset + 4;
    throw new Error(`Unsupported wire type ${wireType}`);
}

function readProtoString(bytes, offset) {
    const len = readVarint(bytes, offset);
    const start = len[1];
    const end = start + Number(len[0]);
    return [textDecoder.decode(bytes.subarray(start, end)), end];
}

function parseTrackDescriptor(bytes, start, end) {
    const descriptor = {};
    let o = start;
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 1 && wireType === 0) {
            const v = readVarint(bytes, o);
            descriptor.uuid = v[0];
            o = v[1];
        } else if (field === 2 && wireType === 2) {
            const v = readProtoString(bytes, o);
            descriptor.name = v[0];
            o = v[1];
        } else if (field === 3 && wireType === 2) {
            const len = readVarint(bytes, o);
            const processStart = len[1];
            const processEnd = processStart + Number(len[0]);
            descriptor.process = parseProcessDescriptor(bytes, processStart, processEnd);
            o = processEnd;
        } else if (field === 4 && wireType === 2) {
            const len = readVarint(bytes, o);
            const threadStart = len[1];
            const threadEnd = threadStart + Number(len[0]);
            descriptor.thread = parseThreadDescriptor(bytes, threadStart, threadEnd);
            o = threadEnd;
        } else if (field === 5 && wireType === 0) {
            const v = readVarint(bytes, o);
            descriptor.parentUuid = v[0];
            o = v[1];
        } else if (field === 11 && wireType === 0) {
            const v = readVarint(bytes, o);
            descriptor.childOrdering = Number(v[0]);
            o = v[1];
        } else if (field === 12 && wireType === 0) {
            const v = readVarint(bytes, o);
            descriptor.siblingOrderRank = Number(v[0]);
            o = v[1];
        } else if (field === 15 && wireType === 0) {
            const v = readVarint(bytes, o);
            descriptor.siblingMergeBehavior = Number(v[0]);
            o = v[1];
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
    return descriptor;
}

function parseProcessDescriptor(bytes, start, end) {
    const process = {};
    let o = start;
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 1 && wireType === 0) {
            const v = readVarint(bytes, o);
            process.pid = Number(v[0]);
            o = v[1];
        } else if (field === 6 && wireType === 2) {
            const v = readProtoString(bytes, o);
            process.processName = v[0];
            o = v[1];
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
    return process;
}

function parseThreadDescriptor(bytes, start, end) {
    const thread = {};
    let o = start;
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 1 && wireType === 0) {
            const v = readVarint(bytes, o);
            thread.pid = Number(v[0]);
            o = v[1];
        } else if (field === 2 && wireType === 0) {
            const v = readVarint(bytes, o);
            thread.tid = Number(v[0]);
            o = v[1];
        } else if (field === 5 && wireType === 2) {
            const v = readProtoString(bytes, o);
            thread.threadName = v[0];
            o = v[1];
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
    return thread;
}

function parseDebugAnnotationNames(bytes, start, end) {
    const names = [];
    let o = start;
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 10 && wireType === 2) {
            const v = readProtoString(bytes, o);
            names.push(v[0]);
            o = v[1];
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
    return names;
}

function parseLegacyEvent(bytes, start, end) {
    const legacy = {};
    let o = start;
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 2 && wireType === 0) {
            const v = readVarint(bytes, o);
            legacy.phase = Number(v[0]);
            o = v[1];
        } else if (field === 3 && wireType === 0) {
            const v = readVarint(bytes, o);
            legacy.durationUs = Number(BigInt.asIntN(64, v[0]));
            o = v[1];
        } else if (field === 10 && wireType === 0) {
            const v = readVarint(bytes, o);
            legacy.localId = v[0];
            o = v[1];
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
    return legacy;
}

function parseTrackEvent(bytes, start, end) {
    const event = { categories: [], debugAnnotationNames: [] };
    let o = start;
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 4 && wireType === 2) {
            const len = readVarint(bytes, o);
            const annotationStart = len[1];
            const annotationEnd = annotationStart + Number(len[0]);
            event.debugAnnotationNames.push(...parseDebugAnnotationNames(bytes, annotationStart, annotationEnd));
            o = annotationEnd;
        } else if (field === 6 && wireType === 2) {
            const len = readVarint(bytes, o);
            const legacyStart = len[1];
            const legacyEnd = legacyStart + Number(len[0]);
            event.legacy = parseLegacyEvent(bytes, legacyStart, legacyEnd);
            o = legacyEnd;
        } else if (field === 9 && wireType === 0) {
            const v = readVarint(bytes, o);
            event.type = Number(v[0]);
            o = v[1];
        } else if (field === 11 && wireType === 0) {
            const v = readVarint(bytes, o);
            event.trackUuid = v[0];
            o = v[1];
        } else if (field === 1 && wireType === 0) {
            const v = readVarint(bytes, o);
            event.timestampDeltaUs = Number(v[0]);
            o = v[1];
        } else if (field === 16 && wireType === 0) {
            const v = readVarint(bytes, o);
            event.timestampUs = Number(v[0]);
            o = v[1];
        } else if (field === 17 && wireType === 0) {
            const v = readVarint(bytes, o);
            event.threadTimeAbsoluteUs = Number(v[0]);
            o = v[1];
        } else if (field === 22 && wireType === 2) {
            const v = readProtoString(bytes, o);
            event.categories.push(v[0]);
            o = v[1];
        } else if (field === 23 && wireType === 2) {
            const v = readProtoString(bytes, o);
            event.name = v[0];
            o = v[1];
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
    return event;
}

function parseTracePacketForTrackDescriptors(bytes, start, end, descriptors) {
    let o = start;
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 60 && wireType === 2) {
            const len = readVarint(bytes, o);
            const descStart = len[1];
            const descEnd = descStart + Number(len[0]);
            descriptors.push(parseTrackDescriptor(bytes, descStart, descEnd));
            o = descEnd;
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
}

function parseTracePacketForTrackEvents(bytes, start, end, events) {
    let o = start;
    let packetTimestampNs;
    const eventRanges = [];
    while (o < end) {
        const tag = readVarint(bytes, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 8 && wireType === 0) {
            const v = readVarint(bytes, o);
            packetTimestampNs = Number(v[0]);
            o = v[1];
        } else if (field === 11 && wireType === 2) {
            const len = readVarint(bytes, o);
            const eventStart = len[1];
            const eventEnd = eventStart + Number(len[0]);
            eventRanges.push([eventStart, eventEnd]);
            o = eventEnd;
        } else {
            o = skipProtoField(bytes, o, wireType);
        }
    }
    for (const [eventStart, eventEnd] of eventRanges) {
        events.push({
            ...parseTrackEvent(bytes, eventStart, eventEnd),
            packetTimestampNs
        });
    }
}

function decodePerfettoTrackDescriptors(bytes) {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const descriptors = [];
    let o = 0;
    while (o < raw.length) {
        const tag = readVarint(raw, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 1 && wireType === 2) {
            const len = readVarint(raw, o);
            const packetStart = len[1];
            const packetEnd = packetStart + Number(len[0]);
            parseTracePacketForTrackDescriptors(raw, packetStart, packetEnd, descriptors);
            o = packetEnd;
        } else {
            o = skipProtoField(raw, o, wireType);
        }
    }
    return descriptors;
}

function decodePerfettoTrackEvents(bytes) {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const events = [];
    let o = 0;
    while (o < raw.length) {
        const tag = readVarint(raw, o);
        o = tag[1];
        const field = Number(tag[0] >> 3n);
        const wireType = Number(tag[0] & 7n);
        if (field === 1 && wireType === 2) {
            const len = readVarint(raw, o);
            const packetStart = len[1];
            const packetEnd = packetStart + Number(len[0]);
            parseTracePacketForTrackEvents(raw, packetStart, packetEnd, events);
            o = packetEnd;
        } else {
            o = skipProtoField(raw, o, wireType);
        }
    }
    return events;
}

async function decodePerfettoProto(bytes) {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const decoder = new PerfettoDecoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(raw);
            controller.close();
        }
    }).pipeThrough(decoder.stream).pipeThrough(new TextEncoderStream());
    return JSON.parse(await new Response(stream).text()).traceEvents;
}

function structuralChecks(trace) {
    expect(Array.isArray(trace.traceEvents)).toBe(true);
    const events = trace.traceEvents;

    const balance = new Map();
    for (const e of events) {
        // Timestamps: finite non-negative integer µs, durations likewise when present.
        expect(Number.isInteger(e.ts)).toBe(true);
        expect(e.ts).toBeGreaterThanOrEqual(0);
        if (e.dur !== undefined) {
            expect(Number.isInteger(e.dur)).toBe(true);
            expect(e.dur).toBeGreaterThanOrEqual(0);
        }

        // DEVTOOLS_REQUIRED_ARG_PATHS: every Resource* event must carry args.data.requestId.
        if (e.name && e.name.startsWith('Resource')) {
            expect(e.args && e.args.data && e.args.data.requestId, `${e.name} missing requestId`).toBeTruthy();
        }

        if (e.ph === 'b') balance.set(asyncKey(e), (balance.get(asyncKey(e)) || 0) + 1);
        if (e.ph === 'e') balance.set(asyncKey(e), (balance.get(asyncKey(e)) || 0) - 1);
    }
    for (const [key, count] of balance) {
        expect(count, `unbalanced async pair ${key}`).toBe(0);
    }

    return events;
}

describe('rumcap trace synthesizer', () => {

    it('does not throw when a timeline value is non-finite (NaN hardening)', async () => {
        // A corrupted or hand-built .rcap can carry a non-finite timeline value
        // that slips past the `!== undefined` stream filters. us()/packetNs() must
        // clamp it: packetNs(NaN) would otherwise throw RangeError and abort the
        // whole Perfetto synthesis, and synthesizeChromeTrace would emit ts: NaN
        // (which serializes to null and corrupts DevTools sort/pairing).
        const capture = await loadCapture('chrome-www-google-com.rcap');
        // An interaction start of NaN reaches packetNs() (Perfetto packet
        // timestamp) — unguarded, BigInt(NaN) throws RangeError and aborts the
        // whole synthesis. A user-timing mark start of NaN reaches us() — unguarded
        // it emits ts: NaN into the Chrome trace. Exercise both paths.
        const events = capture.streams.interactions && capture.streams.interactions.events;
        expect(Array.isArray(events) && events.length > 0).toBe(true);
        events[0].startTime = NaN;
        const marks = capture.streams.userTiming && capture.streams.userTiming.marks;
        if (Array.isArray(marks) && marks[0]) marks[0].startTime = NaN;

        expect(() => synthesizePerfettoProto(capture)).not.toThrow();

        const trace = synthesizeChromeTrace(capture);
        expect(Array.isArray(trace.traceEvents)).toBe(true);
        for (const e of trace.traceEvents) {
            if ('ts' in e) expect(Number.isFinite(e.ts)).toBe(true);
        }
    });

    it('synthesizes a structurally valid trace from the cnn cpu6x capture', async () => {
        const capture = await loadCapture('chrome-www-cnn-com-cpu6x.rcap');
        const trace = synthesizeChromeTrace(capture);
        const events = structuralChecks(trace);

        // Scaffolding: TracingStartedInBrowser with a frames array matching the navigation URL.
        const tsib = events.find(e => e.name === 'TracingStartedInBrowser');
        expect(tsib).toBeDefined();
        expect(Array.isArray(tsib.args.data.frames)).toBe(true);
        expect(tsib.args.data.frames[0].url).toBe(capture.streams.navigation.name);
        expect(tsib.args.data.frames[0].isOutermostMainFrame).toBe(true);

        const navStart = events.find(e => e.name === 'navigationStart');
        expect(navStart.args.data.documentLoaderURL).toBe(capture.streams.navigation.name);
        expect(navStart.args.data.isLoadingMainFrame).toBe(true);
        expect(navStart.args.data.isOutermostMainFrame).toBe(true);
        expect(navStart.args.data.navigationId).toBeTruthy();

        const mainThread = events.find(e => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'CrRendererMain');
        expect(mainThread).toBeDefined();
        expect(events.some(e => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'Network')).toBe(false);

        // Network: DevTools parser markers are retained for the Network model, but kept out of
        // the renderer process so they do not create a visible point-event thread.
        const resourceCount = 1 + capture.streams.resources.length;
        expect(events.filter(e => e.name === 'ResourceWillSendRequest').length).toBe(resourceCount);
        expect(events.filter(e => e.name === 'ResourceSendRequest').length).toBe(resourceCount);
        expect(events.filter(e => e.name === 'ResourceFinish').length).toBe(resourceCount);
        const requestMarkers = events.filter(e => [
            'ResourceWillSendRequest',
            'ResourceSendRequest',
            'ResourceReceiveResponse',
            'ResourceFinish'
        ].includes(e.name));
        expect(requestMarkers.length).toBeGreaterThan(resourceCount * 3);
        expect(requestMarkers.every(e => e.pid !== mainThread.pid)).toBe(true);
        expect(requestMarkers.some(e => e.tid === mainThread.tid && e.pid === mainThread.pid)).toBe(false);
        expect(events.some(e => e.name === 'ResourceLoad')).toBe(false);

        // ResourceReceiveResponse timing block: requestTime is SECONDS, offsets are ms.
        const rrr = events.find(e => e.name === 'ResourceReceiveResponse');
        expect(rrr).toBeDefined();
        expect(rrr.pid).not.toBe(mainThread.pid);
        const timing = rrr.args.data.timing;
        const nav = capture.streams.navigation;
        expect(timing.requestTime).toBeCloseTo(nav.fetchStart / 1000, 6);
        expect(timing.dnsStart).toBeCloseTo(nav.domainLookupStart - nav.fetchStart, 3);
        expect(timing.receiveHeadersEnd).toBeCloseTo(nav.responseStart - nav.fetchStart, 3);

        // Vitals present when the source streams are.
        expect(events.some(e => e.name === 'firstPaint')).toBe(true);
        expect(events.some(e => e.name === 'firstContentfulPaint')).toBe(true);
        expect(events.filter(e => e.name === 'largestContentfulPaint::Candidate').length).toBeGreaterThan(0);
        expect(events.filter(e => e.name === 'LayoutShift').length).toBe(capture.streams.cls.shifts.length);
        expect(events.some(e => e.name === 'MarkDOMContent')).toBe(true);
        expect(events.some(e => e.name === 'MarkLoad')).toBe(true);
        expect(events.filter(e => e.name === 'EventTiming' && e.ph === 'b').length)
            .toBe(capture.streams.interactions.events.length);

        const expectedLoafFrames = capture.streams.loaf.frames
            .filter(f => f && f.startTime !== undefined);
        const expectedLoafScripts = expectedLoafFrames.reduce((total, f) => {
            const frameEnd = f.startTime + (finiteNumberForTest(f.duration) ? Math.max(0, f.duration) : 0);
            return total + (f.scripts || [])
                .filter(s => s && finiteNumberForTest(s.startTime) && finiteNumberForTest(s.duration) && s.duration > 0)
                .filter(s => s.startTime < frameEnd && s.startTime + s.duration > f.startTime)
                .length;
        }, 0);
        const expectedRenderFrames = expectedLoafFrames.filter((f) => {
            const frameEnd = f.startTime + (finiteNumberForTest(f.duration) ? Math.max(0, f.duration) : 0);
            return finiteNumberForTest(f.renderStart) && f.renderStart >= f.startTime && f.renderStart < frameEnd;
        });
        const expectedStyleFrames = expectedLoafFrames.filter((f) => {
            const frameEnd = f.startTime + (finiteNumberForTest(f.duration) ? Math.max(0, f.duration) : 0);
            return finiteNumberForTest(f.renderStart)
                && finiteNumberForTest(f.styleAndLayoutStart)
                && f.renderStart >= f.startTime
                && f.styleAndLayoutStart >= f.renderStart
                && f.styleAndLayoutStart < frameEnd;
        });
        expect(events.filter(e => e.name === 'LongAnimationFrame' && e.ph === 'X').length)
            .toBe(expectedLoafFrames.length);
        expect(events.filter(e => e.name === 'AnimationFrame' && e.ph === 'b').length)
            .toBe(expectedLoafFrames.length);
        expect(events.filter(e => e.name === 'AnimationFrame' && e.ph === 'e').length)
            .toBe(expectedLoafFrames.length);
        expect(events.filter(e => e.name === 'AnimationFrame::Presentation' && e.ph === 'n').length)
            .toBe(expectedLoafFrames.filter(f => finiteNumberForTest(f.presentationTime)).length);
        const loafScriptSlices = events.filter(e => e.ph === 'X' && eventHasCategory(e, 'loaf.script'));
        expect(loafScriptSlices.length).toBe(expectedLoafScripts);
        expect(loafScriptSlices.length).toBeGreaterThan(0);
        expect(loafScriptSlices[0].name.startsWith('Script: ')).toBe(true);
        expect(loafScriptSlices[0].args.data.source_url).toBeTruthy();
        expect(events.filter(e => e.ph === 'X' && eventHasCategory(e, 'loaf.render')).length)
            .toBe(expectedRenderFrames.length);
        expect(events.filter(e => e.ph === 'X' && eventHasCategory(e, 'loaf.style_layout')).length)
            .toBe(expectedStyleFrames.length);
        const loafExtensionBegins = events.filter(e => e.cat === 'blink.user_timing'
            && e.ph === 'b'
            && devtoolsTrackForEvent(e) === 'Long Animation Frames');
        expect(loafExtensionBegins.length).toBeGreaterThan(expectedLoafFrames.length);
        expect(loafExtensionBegins.some(e => e.name === 'LongAnimationFrame')).toBe(true);
        expect(loafExtensionBegins.some(e => e.name.startsWith('Script: '))).toBe(true);

        // RunTask X events exist iff the longTasks stream has >= 50ms tasks (cnn has 23).
        const runTasks = events.filter(e => e.name === 'RunTask');
        const expectedTasks = capture.streams.longTasks.tasks.filter(t => t.duration >= 50);
        expect(runTasks.length).toBe(expectedTasks.length);
        expect(runTasks.length).toBeGreaterThan(0);
        for (const rt of runTasks) {
            expect(rt.ph).toBe('X');
            expect(rt.cat).toBe('toplevel');
            expect(rt.dur).toBeGreaterThanOrEqual(50000);
        }

        // User Timing counts match the stream.
        const ut = capture.streams.userTiming;
        const marks = events.filter(e => e.cat === 'blink.user_timing' && e.ph === 'I');
        expect(marks.length).toBe(ut.marks.length);
        expect(marks.every(e => e.pid !== mainThread.pid)).toBe(true);
        const measureBegins = events.filter(e => e.cat === 'blink.user_timing'
            && e.ph === 'b'
            && ut.measures.some(m => m.name === e.name && e.ts === usForTest(m.startTime)));
        expect(measureBegins.length).toBe(ut.measures.length);
        expect(measureBegins.every(e => e.pid !== mainThread.pid)).toBe(true);

        // Profile: native CPU-profile events live on Main, with no custom comparison track.
        // Extra self-profile timeline entries would make DevTools' SamplesIntegrator split
        // native stacks around duplicate sampled-thread work.
        expect(events.some(e => e.ph === 'M' && e.args && e.args.name === 'JS Self-Profiling')).toBe(false);
        const profileTimelineCopies = events.filter(e => e.ph === 'X'
            && e.tid === mainThread.tid
            && e.args
            && e.args.data
            && e.args.data.selfProfiling);
        expect(profileTimelineCopies.length).toBe(0);
        const expectedProfileSlices = normalizeProfileSlicesForTest(capture.streams.profile);
        const nativeProfile = events.find(e => e.name === 'Profile');
        const nativeProfileChunk = events.find(e => e.name === 'ProfileChunk');
        expect(nativeProfile).toBeDefined();
        expect(nativeProfileChunk).toBeDefined();
        expect(nativeProfile.cat).toBe('disabled-by-default-v8.cpu_profiler');
        expect(nativeProfile.ph).toBe('P');
        expect(nativeProfile.pid).toBe(mainThread.pid);
        expect(nativeProfile.tid).toBe(mainThread.tid);
        expect(nativeProfile.id).toBe(nativeProfileChunk.id);
        expect(nativeProfile.args.data.source).toBe('SelfProfiling');
        expect(nativeProfileChunk.args.data.source).toBe('SelfProfiling');
        const cpuProfile = nativeProfileChunk.args.data.cpuProfile;
        expect(cpuProfile.nodes.length).toBeGreaterThan(2);
        expect(cpuProfile.nodes.length).toBeLessThanOrEqual(expectedProfileSlices.length + 2);
        expect(cpuProfile.nodes[0].callFrame.functionName).toBe('(root)');
        expect(cpuProfile.nodes.some(n => n.callFrame.functionName === '(idle)')).toBe(true);
        expect(cpuProfile.samples.length).toBe(nativeProfileChunk.args.data.timeDeltas.length);
        expect(cpuProfile.samples.length).toBeGreaterThan(0);
        expect(nativeProfileChunk.args.data.timeDeltas[0]).toBeGreaterThan(0);
        expect(nativeProfileChunk.args.data.timeDeltas.some(d => d > 0)).toBe(true);
        expect(nativeProfileChunk.args.data.timeDeltas.every(d => Number.isInteger(d) && d >= 0)).toBe(true);
        const profileStart = Math.min(...expectedProfileSlices.map(e => e.ts));
        const profileEnd = Math.max(...expectedProfileSlices.map(e => e.end));
        expect(nativeProfile.ts).toBe(profileStart - 1);
        expect(nativeProfileChunk.ts).toBe(profileStart - 1);
        expect(nativeProfileChunk.args.data.timeDeltas.reduce((sum, d) => sum + d, 0))
            .toBe(profileEnd - nativeProfile.ts);
        const nodeIds = new Set(cpuProfile.nodes.map(n => n.id));
        const sampledNodeIds = new Set(cpuProfile.samples);
        expect([...sampledNodeIds].every(id => nodeIds.has(id))).toBe(true);
        expect(cpuProfile.nodes.some(n => sampledNodeIds.has(n.id) && n.callFrame.url)).toBe(true);
        const scriptIdByUrl = new Map();
        for (const node of cpuProfile.nodes) {
            const { scriptId, url } = node.callFrame;
            if (!url) continue;
            expect(scriptId).not.toBe('0');
            const previous = scriptIdByUrl.get(url);
            if (previous !== undefined) {
                expect(scriptId).toBe(previous);
            } else {
                scriptIdByUrl.set(url, scriptId);
            }
        }
        expect(scriptIdByUrl.size).toBeGreaterThan(1);
        const profileExtensionBegins = events.filter(e => e.cat === 'blink.user_timing'
            && e.ph === 'b'
            && devtoolsTrackForEvent(e) === 'JS Self-Profiling');
        expect(profileExtensionBegins.length).toBe(0);
    });

    it('keeps frame-less profile slices in the native CPU profile', () => {
        const capture = {
            formatVersion: 3,
            manifest: {
                clock: { timeOrigin: 1700000000000, captureStart: 0, captureEnd: 500, unit: 'ms', base: 'timeOrigin' },
                streams: {
                    navigation: { status: 'present', schemaVersion: 1 },
                    profile: { status: 'present', schemaVersion: 1 }
                },
                config: {}
            },
            streams: {
                navigation: {
                    name: 'https://example.com/', startTime: 0, duration: 200,
                    initiatorType: 'navigation', type: 'navigate', redirectCount: 0,
                    fetchStart: 1, requestStart: 5, responseStart: 50, responseEnd: 200,
                    transferSize: 1234, encodedBodySize: 1200, decodedBodySize: 4000,
                    responseStatus: 200, contentType: 'text/html'
                },
                profile: {
                    frames: [],
                    resources: [],
                    slices: [
                        { start: 100, duration: 40, depth: 0 },
                        { start: 110, duration: 20, depth: 1 }
                    ]
                }
            }
        };

        const trace = synthesizeChromeTrace(capture);
        const events = structuralChecks(trace);
        const chunk = events.find(e => e.name === 'ProfileChunk');
        expect(chunk).toBeDefined();
        const cpuProfile = chunk.args.data.cpuProfile;
        const sampledNodeIds = new Set(cpuProfile.samples);
        const anonymousNodes = cpuProfile.nodes
            .filter(n => n.callFrame.functionName === '(anonymous)' && n.callFrame.scriptId !== '0');
        expect(anonymousNodes.length).toBe(2);
        expect(anonymousNodes.every(n => sampledNodeIds.has(n.id))).toBe(true);
        expect(chunk.args.data.timeDeltas.length).toBe(cpuProfile.samples.length);
        expect(chunk.args.data.timeDeltas.some(d => d > 0)).toBe(true);
    });

    it('synthesizes native Perfetto protobuf request tracks without Resource* instants', async () => {
        const capture = await loadCapture('chrome-www-cnn-com-cpu6x.rcap');
        const bytes = synthesizePerfettoProto(capture);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeGreaterThan(0);

        const events = await decodePerfettoProto(bytes);
        const descriptors = decodePerfettoTrackDescriptors(bytes);
        const rawTrackEvents = decodePerfettoTrackEvents(bytes);
        const resourceCount = 1 + capture.streams.resources.length;
        expect(events.some(e => e.name && e.name.startsWith('Resource'))).toBe(false);

        const profileRoot = descriptors.find(d => d.name === 'Performance Profile' && d.parentUuid === undefined);
        expect(profileRoot).toBeDefined();
        expect(profileRoot.process).toBeUndefined();
        expect(profileRoot.childOrdering).toBe(3); // TrackDescriptor.CHILD_ORDERING_EXPLICIT
        expect(descriptors.some(d => d.process)).toBe(false);
        expect(descriptors.some(d => d.thread)).toBe(false);
        const longTasksTrack = descriptors.find(d => d.name === 'Long Tasks');
        expect(longTasksTrack).toBeDefined();
        expect(longTasksTrack.parentUuid).toBe(profileRoot.uuid);
        const profilerTrack = descriptors.find(d => d.name === 'JS Self-Profiling');
        expect(profilerTrack).toBeDefined();
        expect(profilerTrack.parentUuid).toBe(profileRoot.uuid);
        const profileChildrenByRank = descriptors
            .filter(d => d.parentUuid === profileRoot.uuid)
            .sort((a, b) => a.siblingOrderRank - b.siblingOrderRank);
        const profileChildNamesByRank = [];
        for (const child of profileChildrenByRank) {
            if (!profileChildNamesByRank.includes(child.name)) profileChildNamesByRank.push(child.name);
        }
        expect(profileChildNamesByRank.slice(0, 6)).toEqual([
            'Page Milestones',
            'Long Tasks',
            'Long Animation Frames',
            'JS Self-Profiling',
            'User Timing',
            'Requests'
        ]);

        const loafTrack = descriptors.find(d => d.name === 'Long Animation Frames');
        expect(loafTrack).toBeDefined();
        expect(loafTrack.parentUuid).toBe(profileRoot.uuid);
        expect(descriptors.some(d => d.parentUuid === loafTrack.uuid)).toBe(false);
        expect(descriptors.some(d => /^LoAF \d+$/.test(d.name))).toBe(false);
        const userTimingTracks = descriptors
            .filter(d => d.name === 'User Timing' && d.parentUuid === profileRoot.uuid);
        expect(userTimingTracks.length).toBeGreaterThanOrEqual(1);
        expect(userTimingTracks.every(d => d.siblingOrderRank === 5)).toBe(true);
        expect(userTimingTracks.every(d => d.siblingMergeBehavior === 1)).toBe(true);
        expect(userTimingTracks.every(d => !descriptors.some(child => child.parentUuid === d.uuid))).toBe(true);
        const userTimingTrack = userTimingTracks[0];
        const interactionTracks = descriptors
            .filter(d => d.name === 'Interactions' && d.parentUuid === profileRoot.uuid);
        expect(interactionTracks.length).toBeGreaterThanOrEqual(1);
        expect(interactionTracks.every(d => d.siblingOrderRank === 7)).toBe(true);
        expect(interactionTracks.every(d => d.siblingMergeBehavior === 1)).toBe(true);
        expect(interactionTracks.every(d => !descriptors.some(child => child.parentUuid === d.uuid))).toBe(true);
        const eventNames = new Set(capture.streams.interactions.events.map(e => e.name).filter(Boolean));
        for (const name of eventNames) {
            expect(descriptors.some(d => d.name === name && interactionTracks.some(t => d.parentUuid === t.uuid))).toBe(false);
        }

        const requestsGroup = descriptors.find(d => d.name === 'Requests');
        expect(requestsGroup).toBeDefined();
        expect(requestsGroup.childOrdering).toBe(3); // TrackDescriptor.CHILD_ORDERING_EXPLICIT
        const requestDescriptors = descriptors.filter(d => d.parentUuid === requestsGroup.uuid);
        expect(requestDescriptors.length).toBe(resourceCount);
        expect(requestDescriptors.map(d => d.siblingOrderRank))
            .toEqual(Array.from({ length: resourceCount }, (_v, i) => i + 1));
        expect(requestDescriptors.every(d => d.siblingMergeBehavior === 2)).toBe(true);
        expect(requestDescriptors[0].name).toBe(capture.streams.navigation.name);
        expect(requestDescriptors.every(d => !/^\d{4}\s/.test(d.name))).toBe(true);

        // Perfetto TrackEvent proto fields: timestamp_delta_us=1, timestamp_absolute_us=16,
        // thread_time_absolute_us=17. The synthesized trace must put event time in field 16,
        // not field 17, and TracePacket.timestamp uses Perfetto's default ns unit.
        expect(rawTrackEvents.length).toBeGreaterThan(0);
        for (const e of rawTrackEvents) {
            expect(e.timestampDeltaUs).toBeUndefined();
            expect(e.threadTimeAbsoluteUs).toBeUndefined();
            expect(Number.isInteger(e.timestampUs)).toBe(true);
            expect(e.packetTimestampNs).toBe(e.timestampUs * 1000);
        }

        const expectedLoafFrames = capture.streams.loaf.frames
            .filter(f => f && f.startTime !== undefined);
        const expectedLoafScripts = expectedLoafFrames.reduce((total, f) => {
            const frameEnd = f.startTime + (finiteNumberForTest(f.duration) ? Math.max(0, f.duration) : 0);
            return total + (f.scripts || [])
                .filter(s => s && finiteNumberForTest(s.startTime) && finiteNumberForTest(s.duration) && s.duration > 0)
                .filter(s => s.startTime < frameEnd && s.startTime + s.duration > f.startTime)
                .length;
        }, 0);
        const expectedRenderFrames = expectedLoafFrames.filter((f) => {
            const frameEnd = f.startTime + (finiteNumberForTest(f.duration) ? Math.max(0, f.duration) : 0);
            return finiteNumberForTest(f.renderStart) && f.renderStart >= f.startTime && f.renderStart < frameEnd;
        });
        const expectedStyleFrames = expectedLoafFrames.filter((f) => {
            const frameEnd = f.startTime + (finiteNumberForTest(f.duration) ? Math.max(0, f.duration) : 0);
            return finiteNumberForTest(f.renderStart)
                && finiteNumberForTest(f.styleAndLayoutStart)
                && f.renderStart >= f.startTime
                && f.styleAndLayoutStart >= f.renderStart
                && f.styleAndLayoutStart < frameEnd;
        });
        const loafBegins = rawTrackEvents
            .filter(e => e.trackUuid === loafTrack.uuid && e.type === 1);
        const loafEnds = rawTrackEvents
            .filter(e => e.trackUuid === loafTrack.uuid && e.type === 2);
        expect(loafEnds.length).toBe(loafBegins.length);
        const frameBegins = loafBegins.filter(e => e.categories[0] === 'loaf.frame');
        expect(frameBegins.length).toBe(expectedLoafFrames.length);
        expect(frameBegins.every(e => e.name === 'LongAnimationFrame')).toBe(true);
        expect(frameBegins[0].debugAnnotationNames).toContain('blocking_duration_ms');
        expect(frameBegins[0].debugAnnotationNames).toContain('num_scripts');
        const scriptBegins = loafBegins.filter(e => e.categories[0] === 'loaf.script');
        expect(scriptBegins.length).toBe(expectedLoafScripts);
        expect(scriptBegins.length).toBeGreaterThan(0);
        expect(scriptBegins[0].name.startsWith('Script: ')).toBe(true);
        expect(scriptBegins[0].debugAnnotationNames).toContain('source_url');
        expect(scriptBegins[0].debugAnnotationNames).toContain('invoker_type');
        expect(loafBegins.filter(e => e.categories[0] === 'loaf.render').length)
            .toBe(expectedRenderFrames.length);
        expect(loafBegins.filter(e => e.categories[0] === 'loaf.style_layout').length)
            .toBe(expectedStyleFrames.length);
        expect(events.filter(e => e.cat === 'loaf.frame' && e.ph === 'B').length)
            .toBe(expectedLoafFrames.length);
        expect(events.filter(e => e.cat === 'loaf.script' && e.ph === 'B').length)
            .toBe(expectedLoafScripts);

        const ut = capture.streams.userTiming;
        const isBoundaryMark = (mark) => ut.measures.some((measure) => {
            const startMatches = mark.name === `${measure.name} START`
                && Math.abs(mark.startTime - measure.startTime) <= 0.5;
            const endMatches = mark.name === `${measure.name} END`
                && Math.abs(mark.startTime - (measure.startTime + (measure.duration || 0))) <= 0.5;
            return startMatches || endMatches;
        });
        const expectedPerfettoMarks = ut.marks.filter(m => !isBoundaryMark(m));
        const expectedMeasureLanes = allocateUserTimingMeasureLanesForTest(ut.measures);
        const expectedLaneCount = expectedMeasureLanes.reduce((max, item) => Math.max(max, item.lane + 1), 1);
        expect(userTimingTracks.length).toBe(expectedLaneCount);
        const userTimingTrackUuids = new Set(userTimingTracks.map(d => d.uuid));
        const userTimingRawEvents = rawTrackEvents.filter(e => userTimingTrackUuids.has(e.trackUuid));
        const userTimingRawMarks = userTimingRawEvents
            .filter(e => e.trackUuid === userTimingTrack.uuid && e.type === 3);
        expect(userTimingRawMarks.length).toBe(expectedPerfettoMarks.length);
        expect(userTimingRawMarks.every(e => e.categories[0] === 'blink.user_timing.mark')).toBe(true);
        for (const measure of ut.measures) {
            expect(userTimingRawMarks.some(e => e.name === `${measure.name} START`)).toBe(false);
            expect(userTimingRawMarks.some(e => e.name === `${measure.name} END`)).toBe(false);
        }
        const userTimingMeasureBegins = userTimingRawEvents
            .filter(e => e.type === 1 && e.categories[0] === 'blink.user_timing.measure');
        const userTimingMeasureEnds = userTimingRawEvents
            .filter(e => e.type === 2 && e.categories[0] === 'blink.user_timing.measure');
        expect(userTimingRawEvents.some(e => e.legacy && e.legacy.phase === 'X'.charCodeAt(0))).toBe(false);
        expect(userTimingMeasureBegins.length).toBe(ut.measures.length);
        expect(userTimingMeasureEnds.length).toBe(ut.measures.length);
        expect(userTimingMeasureBegins[0].debugAnnotationNames).toContain('duration_ms');
        expect(userTimingMeasureBegins[0].debugAnnotationNames).toContain('end_time_ms');
        for (const trackUuid of userTimingTrackUuids) {
            const begins = userTimingMeasureBegins
                .filter(e => e.trackUuid === trackUuid)
                .sort((a, b) => a.timestampUs - b.timestampUs);
            const ends = userTimingMeasureEnds
                .filter(e => e.trackUuid === trackUuid)
                .sort((a, b) => a.timestampUs - b.timestampUs);
            expect(ends.length).toBe(begins.length);
            for (let i = 0; i < begins.length; i++) {
                expect(ends[i].timestampUs).toBeGreaterThanOrEqual(begins[i].timestampUs);
                if (i > 0) expect(begins[i].timestampUs).toBeGreaterThanOrEqual(ends[i - 1].timestampUs);
            }
        }
        const decodedUserTimingMeasureBegins = events
            .filter(e => e.cat === 'blink.user_timing.measure' && e.ph === 'B');
        const decodedUserTimingMeasureEnds = events
            .filter(e => e.cat === 'blink.user_timing.measure' && e.ph === 'E');
        expect(decodedUserTimingMeasureBegins.length).toBe(ut.measures.length);
        expect(decodedUserTimingMeasureEnds.length).toBe(ut.measures.length);
        expect(events.filter(e => e.cat === 'blink.user_timing.mark' && e.ph === 'I').length)
            .toBe(expectedPerfettoMarks.length);

        const expectedInteractionLanes = allocateInteractionLanesForTest(capture.streams.interactions.events);
        const expectedInteractionLaneCount = expectedInteractionLanes
            .reduce((max, item) => Math.max(max, item.lane + 1), 1);
        expect(interactionTracks.length).toBe(expectedInteractionLaneCount);
        const interactionTrackUuids = new Set(interactionTracks.map(d => d.uuid));
        const interactionRawEvents = rawTrackEvents.filter(e => interactionTrackUuids.has(e.trackUuid));
        const interactionBegins = interactionRawEvents
            .filter(e => e.type === 1 && e.categories[0] === 'devtools.timeline');
        const interactionEnds = interactionRawEvents
            .filter(e => e.type === 2 && e.categories[0] === 'devtools.timeline');
        expect(interactionBegins.length).toBe(expectedInteractionLanes.length);
        expect(interactionEnds.length).toBe(expectedInteractionLanes.length);
        expect(interactionBegins.every(e => eventNames.has(e.name))).toBe(true);
        expect(interactionBegins[0].debugAnnotationNames).toContain('interaction_id');
        expect(interactionBegins[0].debugAnnotationNames).toContain('duration_ms');
        for (const trackUuid of interactionTrackUuids) {
            const begins = interactionBegins
                .filter(e => e.trackUuid === trackUuid)
                .sort((a, b) => a.timestampUs - b.timestampUs);
            const ends = interactionEnds
                .filter(e => e.trackUuid === trackUuid)
                .sort((a, b) => a.timestampUs - b.timestampUs);
            expect(ends.length).toBe(begins.length);
            for (let i = 0; i < begins.length; i++) {
                expect(ends[i].timestampUs).toBeGreaterThanOrEqual(begins[i].timestampUs);
                if (i > 0) expect(begins[i].timestampUs).toBeGreaterThanOrEqual(ends[i - 1].timestampUs);
            }
        }
        const decodedInteractionBegins = events
            .filter(e => e.cat === 'devtools.timeline' && e.ph === 'B' && eventNames.has(e.name));
        const decodedInteractionEnds = events
            .filter(e => e.cat === 'devtools.timeline' && e.ph === 'E' && eventNames.has(e.name));
        expect(decodedInteractionBegins.length).toBe(expectedInteractionLanes.length);
        expect(decodedInteractionEnds.length).toBe(expectedInteractionLanes.length);

        const requestBegins = events.filter(e => e.cat && e.cat.startsWith('request.') && e.ph === 'B');
        const requestEnds = events.filter(e => e.cat && e.cat.startsWith('request.') && e.ph === 'E');
        expect(requestBegins.length).toBeGreaterThan(resourceCount);
        expect(requestEnds.length).toBe(requestBegins.length);

        const navRawBegins = rawTrackEvents
            .filter(e => e.trackUuid === requestDescriptors[0].uuid && e.type === 1);
        expect(navRawBegins.map(e => e.name)).toEqual([
            'Queueing',
            'Waiting',
            'DNS',
            'Socket',
            'TLS',
            'TTFB',
            capture.streams.navigation.name
        ]);
        expect(navRawBegins.map(e => e.categories[0])).toEqual([
            'request.queueing',
            'request.waiting',
            'request.dns',
            'request.socket',
            'request.tls',
            'request.ttfb',
            'request.content_download'
        ]);
        const navDebugSlices = navRawBegins.filter(e => e.debugAnnotationNames.length > 0);
        expect(navDebugSlices.map(e => e.categories[0])).toEqual(['request.content_download']);
        expect(navDebugSlices[0].debugAnnotationNames).toContain('request_id');
        expect(navDebugSlices[0].debugAnnotationNames).toContain('url');

        const debugRequestBegins = requestBegins.filter(e => e.args && e.args.url);
        expect(debugRequestBegins.length).toBe(resourceCount);
        const navRequest = debugRequestBegins.find(e => e.args.url === capture.streams.navigation.name);
        expect(navRequest).toBeDefined();
        expect(navRequest.name).toBe(capture.streams.navigation.name);
        expect(navRequest.cat).toBe('request.content_download');
        expect(navRequest.ts).toBe(usForTest(capture.streams.navigation.responseStart));
        expect(navRequest.args.request_id).toBe('rumcap.1');
        expect(navRequest.args.url).toBe(capture.streams.navigation.name);
        expect(navRequest.args.event_resource_will_send_request_ms)
            .toBeCloseTo(capture.streams.navigation.startTime, 3);
        expect(navRequest.args.event_resource_send_request_ms)
            .toBeCloseTo(capture.streams.navigation.requestStart, 3);
        expect(navRequest.args.event_resource_receive_response_ms)
            .toBeCloseTo(capture.streams.navigation.responseStart, 3);
        expect(navRequest.args.event_resource_finish_ms)
            .toBeCloseTo(capture.streams.navigation.responseEnd, 3);
        expect(navRequest.args.request_duration_ms)
            .toBeCloseTo(capture.streams.navigation.responseEnd - capture.streams.navigation.startTime, 3);
        expect(navRequest.args.transfer_size_bytes).toBe(capture.streams.navigation.transferSize);

        expect(debugRequestBegins.map(e => e.args.request_id).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7))))
            .toEqual(Array.from({ length: resourceCount }, (_v, i) => `rumcap.${i + 1}`));
        const contentDownloadDebugSlices = debugRequestBegins.filter(e => e.cat === 'request.content_download');
        const fullTimingResources = [capture.streams.navigation, ...capture.streams.resources]
            .filter(r => r.responseStart !== undefined && r.responseEnd !== undefined && r.responseEnd > r.responseStart);
        expect(contentDownloadDebugSlices.length).toBe(fullTimingResources.length);

        const opaqueRequest = debugRequestBegins.find(e => e.cat === 'request.request');
        expect(opaqueRequest).toBeDefined();
        expect(opaqueRequest.name).toBe(opaqueRequest.args.url);
    });

    it('omits empty native Perfetto child groups', () => {
        const capture = {
            formatVersion: 3,
            manifest: {
                clock: { timeOrigin: 1700000000000, captureStart: 0, captureEnd: 500, unit: 'ms', base: 'timeOrigin' },
                streams: {
                    navigation: { status: 'present', schemaVersion: 1 },
                    resources: { status: 'present', schemaVersion: 1 },
                    userTiming: { status: 'present', schemaVersion: 1 },
                    interactions: { status: 'present', schemaVersion: 1 },
                    loaf: { status: 'present', schemaVersion: 1 },
                    customEvents: { status: 'present', schemaVersion: 1 },
                    longTasks: { status: 'present', schemaVersion: 1 },
                    profile: { status: 'present', schemaVersion: 1 }
                },
                config: {}
            },
            streams: {
                navigation: {
                    name: 'https://example.com/',
                    startTime: 0,
                    duration: 120,
                    initiatorType: 'navigation',
                    fetchStart: 1,
                    requestStart: 5,
                    responseStart: 40,
                    responseEnd: 120,
                    responseStatus: 200,
                    contentType: 'text/html',
                    transferSize: 1234
                },
                resources: [],
                userTiming: { marks: [], measures: [] },
                interactions: { events: [] },
                loaf: { frames: [] },
                customEvents: { tracks: [] },
                longTasks: { tasks: [] },
                profile: { frames: [], resources: [], slices: [] }
            }
        };

        const descriptors = decodePerfettoTrackDescriptors(synthesizePerfettoProto(capture));
        const profileRoot = descriptors.find(d => d.name === 'Performance Profile' && d.parentUuid === undefined);
        expect(profileRoot).toBeDefined();
        const profileChildNames = descriptors
            .filter(d => d.parentUuid === profileRoot.uuid)
            .sort((a, b) => a.siblingOrderRank - b.siblingOrderRank)
            .map(d => d.name);
        expect(profileChildNames).toEqual(['Page Milestones', 'Requests']);
        const requestsGroup = descriptors.find(d => d.name === 'Requests');
        expect(descriptors.filter(d => d.parentUuid === requestsGroup.uuid).length).toBe(1);
        expect(descriptors.some(d => d.name === 'User Timing')).toBe(false);
        expect(descriptors.some(d => d.name === 'Interactions')).toBe(false);
        expect(descriptors.some(d => d.name === 'Long Animation Frames')).toBe(false);
        expect(descriptors.some(d => d.name === 'Custom Events')).toBe(false);
        expect(descriptors.some(d => d.name === 'Long Tasks')).toBe(false);
        expect(descriptors.some(d => d.name === 'JS Self-Profiling')).toBe(false);
    });

    it('synthesizes google (no long tasks, empty profile) without RunTask or profiler thread', async () => {
        const capture = await loadCapture('chrome-www-google-com.rcap');
        const trace = synthesizeChromeTrace(capture);
        const events = structuralChecks(trace);

        // longTasks stream is 'not-requested' -> no RunTask events.
        expect(capture.manifest.streams.longTasks.status).not.toBe('present');
        expect(events.some(e => e.name === 'RunTask')).toBe(false);

        // profile is present but has ZERO slices -> no profiler thread metadata, no slices.
        expect(capture.streams.profile.slices.length).toBe(0);
        expect(events.some(e => e.ph === 'M' && e.args && e.args.name === 'JS Self-Profiling')).toBe(false);
        expect(events.some(e => e.name === 'Profile')).toBe(false);
        expect(events.some(e => e.name === 'ProfileChunk')).toBe(false);

        const tsib = events.find(e => e.name === 'TracingStartedInBrowser');
        expect(tsib.args.data.frames[0].url).toBe(capture.streams.navigation.name);

        // User timing counts still match.
        const ut = capture.streams.userTiming;
        expect(events.filter(e => e.cat === 'blink.user_timing' && e.ph === 'I').length).toBe(ut.marks.length);
        expect(events.filter(e => e.cat === 'blink.user_timing'
            && e.ph === 'b'
            && ut.measures.some(m => m.name === e.name && e.ts === usForTest(m.startTime))).length)
            .toBe(ut.measures.length);
    });

    it('maps customEvents namespaces onto extensibility tracks with depth nesting', () => {
        // No sample carries customEvents — hand-build a minimal Capture-shaped object.
        const capture = {
            formatVersion: 3,
            manifest: {
                clock: { timeOrigin: 1700000000000, captureStart: 0, captureEnd: 5000, unit: 'ms', base: 'timeOrigin' },
                streams: {
                    navigation: { status: 'present', schemaVersion: 1 },
                    customEvents: { status: 'present', schemaVersion: 1 }
                },
                config: {}
            },
            streams: {
                navigation: {
                    name: 'https://example.com/', startTime: 0, duration: 1000,
                    initiatorType: 'navigation', type: 'navigate', redirectCount: 0,
                    fetchStart: 1, requestStart: 5, responseStart: 50, responseEnd: 200,
                    domContentLoadedEventStart: 400, loadEventStart: 900,
                    transferSize: 1234, encodedBodySize: 1200, decodedBodySize: 4000,
                    responseStatus: 200, contentType: 'text/html'
                },
                customEvents: {
                    tracks: [{
                        namespace: 'my-app',
                        events: [
                            { name: 'render', start: 100, duration: 50, depth: 0 },
                            { name: 'child', start: 110, duration: 20, depth: 1, details: { step: 1 } },
                            { name: 'flag', start: 300, duration: 0 }
                        ]
                    }, {
                        namespace: 'router',
                        events: [
                            // A user-supplied devtools payload must win over the synthesized one.
                            { name: 'route', start: 400, duration: 10, details: { devtools: { track: 'custom-name', dataType: 'track-entry' } } }
                        ]
                    }]
                }
            }
        };

        const trace = synthesizeChromeTrace(capture);
        const events = structuralChecks(trace);
        const mainThread = events.find(e => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'CrRendererMain');
        expect(mainThread).toBeDefined();

        const begins = events.filter(e => e.cat === 'blink.user_timing' && e.ph === 'b');
        expect(begins.length).toBe(4);
        expect(begins.every(e => e.pid !== mainThread.pid)).toBe(true);

        // Every begin carries args.detail (JSON string) whose parsed devtools.track names the
        // namespace track — the shape DevTools' extensibility handler parses.
        const render = begins.find(e => e.name === 'render');
        const child = begins.find(e => e.name === 'child');
        const flag = begins.find(e => e.name === 'flag');
        const route = begins.find(e => e.name === 'route');
        for (const e of [render, child, flag, route]) {
            expect(e).toBeDefined();
            expect(typeof e.args.detail).toBe('string');
        }
        expect(JSON.parse(render.args.detail).devtools.track).toBe('my-app');
        expect(JSON.parse(flag.args.detail).devtools.track).toBe('my-app');
        const childDetail = JSON.parse(child.args.detail);
        expect(childDetail.devtools.track).toBe('my-app');
        expect(childDetail.step).toBe(1); // user detail survives alongside the synthesized track
        expect(JSON.parse(route.args.detail).devtools.track).toBe('custom-name'); // user payload wins

        // Depth nesting: child sits within parent on the timeline.
        const renderEnd = events.find(e => e.ph === 'e' && e.id2 && e.id2.local === render.id2.local);
        const childEnd = events.find(e => e.ph === 'e' && e.id2 && e.id2.local === child.id2.local);
        expect(child.ts).toBeGreaterThanOrEqual(render.ts);
        expect(childEnd.ts).toBeLessThanOrEqual(renderEnd.ts);
    });

    describe('getPageResource trace plumbing (locks in the _sourceFormat fix)', () => {
        const SAMPLE = 'chrome-www-google-com.rcap';

        async function assertTraceResource(tool) {
            const pageId = Object.keys(tool.data.pages)[0];
            const resource = await tool.getPageResource(pageId, 'trace');
            expect(resource).toBeTruthy();
            expect(resource.mimeType).toBe('application/gzip');
            expect(resource.buffer).toBeTruthy();

            // Gunzip via DecompressionStream and parse — must be Chrome-trace JSON.
            const raw = resource.buffer instanceof Uint8Array ? resource.buffer : new Uint8Array(resource.buffer);
            expect(raw[0]).toBe(0x1f); // gzip magic
            expect(raw[1]).toBe(0x8b);
            const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
            const json = JSON.parse(await new Response(stream).text());
            expect(Array.isArray(json.traceEvents)).toBe(true);
            expect(json.traceEvents.length).toBeGreaterThan(0);
            expect(json.traceEvents.some(e => e.name === 'TracingStartedInBrowser')).toBe(true);
        }

        async function assertPerfettoTraceResource(tool) {
            const pageId = Object.keys(tool.data.pages)[0];
            const resource = await tool.getPageResource(pageId, 'perfetto-trace');
            expect(resource).toBeTruthy();
            expect(resource.mimeType).toBe('application/octet-stream');
            expect(resource.buffer).toBeTruthy();
            const raw = resource.buffer instanceof Uint8Array ? resource.buffer : new Uint8Array(resource.buffer);
            const events = await decodePerfettoProto(raw);
            expect(events.some(e => e.cat && e.cat.startsWith('request.') && e.ph === 'B')).toBe(true);
            expect(events.some(e => e.name && e.name.startsWith('Resource'))).toBe(false);
        }

        it('returns a synthesized trace via loadFile()', async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(path.join(SAMPLE_DIR, SAMPLE), { debug: true });
            expect(tool._sourceFormat).toBe('rumcap');
            await assertTraceResource(tool);
            await assertPerfettoTraceResource(tool);
        });

        it('returns a synthesized trace via loadBuffer()', async () => {
            const tool = new WaterfallTools();
            const buf = new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, SAMPLE)));
            await tool.loadBuffer(buf, { debug: true });
            expect(tool._sourceFormat).toBe('rumcap');
            await assertTraceResource(tool);
            await assertPerfettoTraceResource(tool);
        });

        it('returns a synthesized trace via loadStream() with explicit format', async () => {
            const tool = new WaterfallTools();
            const buf = new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, SAMPLE)));
            await tool.loadStream(new Blob([buf]).stream(), { format: 'rumcap', debug: true });
            expect(tool._sourceFormat).toBe('rumcap');
            await assertTraceResource(tool);
            await assertPerfettoTraceResource(tool);
        });

        it('caches the synthesized bytes per page', async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(path.join(SAMPLE_DIR, SAMPLE), { debug: true });
            const pageId = Object.keys(tool.data.pages)[0];
            const first = await tool.getPageResource(pageId, 'trace');
            const second = await tool.getPageResource(pageId, 'trace');
            expect(tool._rumcapTraceCache.devtools[pageId]).toBeTruthy();
            // Same cached Uint8Array backs both responses.
            const a = first.buffer instanceof Uint8Array ? first.buffer.buffer : first.buffer;
            const b = second.buffer instanceof Uint8Array ? second.buffer.buffer : second.buffer;
            expect(a).toBe(b);

            const firstPerfetto = await tool.getPageResource(pageId, 'perfetto-trace');
            const secondPerfetto = await tool.getPageResource(pageId, 'perfetto-trace');
            expect(tool._rumcapTraceCache.perfetto[pageId]).toBeTruthy();
            const pA = firstPerfetto.buffer instanceof Uint8Array ? firstPerfetto.buffer.buffer : firstPerfetto.buffer;
            const pB = secondPerfetto.buffer instanceof Uint8Array ? secondPerfetto.buffer.buffer : secondPerfetto.buffer;
            expect(pA).toBe(pB);
        });

        it('never serves a previous load\'s raw buffer from a reused instance', async () => {
            const tool = new WaterfallTools();
            const rcapBytes = new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, SAMPLE)));
            await tool.loadBuffer(rcapBytes, { debug: true });

            // Reuse the instance for a different format via the file path — this path has no
            // buffer, so the trace/netlog passthrough routes must not fall back to the stale
            // rcap bytes retained by the previous loadBuffer().
            const tracePath = path.resolve('Sample/Data/Chrome Traces/trace_www.google.com.json.gz');
            await tool.loadFile(tracePath, {});
            expect(tool._sourceFormat).toBe('chrome-trace');
            const pageId = Object.keys(tool.data.pages)[0];
            const resource = await tool.getPageResource(pageId, 'trace');
            if (resource && resource.buffer) {
                const raw = resource.buffer instanceof Uint8Array
                    ? resource.buffer : new Uint8Array(resource.buffer);
                // Must not be the old .rcap payload (magic F5 52 55 4D).
                const isRcap = raw[0] === 0xf5 && raw[1] === 0x52 && raw[2] === 0x55 && raw[3] === 0x4d;
                expect(isRcap).toBe(false);
            }
        });

        it('invalidates the synthesized-trace cache when a reused instance loads a new capture', async () => {
            // rumcap always mints pageId "page_1", so a per-page cache that survives a reload
            // would serve capture A's trace for capture B.
            const tool = new WaterfallTools();
            const readNavUrl = async (resource) => {
                const raw = resource.buffer instanceof Uint8Array
                    ? resource.buffer : new Uint8Array(resource.buffer);
                const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
                const json = JSON.parse(await new Response(stream).text());
                const started = json.traceEvents.find(e => e.name === 'TracingStartedInBrowser');
                return started.args.data.frames[0].url;
            };

            await tool.loadBuffer(new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, SAMPLE))), {});
            const pageA = Object.keys(tool.data.pages)[0];
            const urlA = await readNavUrl(await tool.getPageResource(pageA, 'trace'));

            await tool.loadBuffer(new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, 'chrome-www-cnn-com-cpu6x.rcap'))), {});
            const pageB = Object.keys(tool.data.pages)[0];
            const urlB = await readNavUrl(await tool.getPageResource(pageB, 'trace'));

            expect(urlA).toContain('google.com');
            expect(urlB).toContain('cnn.com');
        });
    });
});
