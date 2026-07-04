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
import { WaterfallTools } from '../../src/core/waterfall-tools.js';
import { synthesizeChromeTrace } from '../../src/inputs/utilities/rumcap/trace-synthesizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(__dirname, '../../Sample/Data/rumcap/chrome');

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

// Profile flame-chart containment: X events on the profiler thread, in array order (pre-order),
// must nest — each child fully inside its parent's [ts, ts+dur] span.
function checkProfileNesting(events, profilerTid) {
    const slices = events.filter(e => e.ph === 'X' && e.tid === profilerTid);
    const stack = [];
    for (const e of slices) {
        const end = e.ts + e.dur;
        while (stack.length > 0 && e.ts >= stack[stack.length - 1].end) stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
            expect(e.ts).toBeGreaterThanOrEqual(parent.ts);
            expect(end, `slice "${e.name}" @${e.ts} escapes parent ending @${parent.end}`).toBeLessThanOrEqual(parent.end);
        }
        stack.push({ ts: e.ts, end });
    }
    return slices;
}

describe('rumcap trace synthesizer', () => {

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

        // Network: one Send/WillSend/Finish per resource (navigation + resources stream).
        const resourceCount = 1 + capture.streams.resources.length;
        expect(events.filter(e => e.name === 'ResourceWillSendRequest').length).toBe(resourceCount);
        expect(events.filter(e => e.name === 'ResourceSendRequest').length).toBe(resourceCount);
        expect(events.filter(e => e.name === 'ResourceFinish').length).toBe(resourceCount);

        // ResourceReceiveResponse timing block: requestTime is SECONDS, offsets are ms.
        const rrr = events.find(e => e.name === 'ResourceReceiveResponse');
        expect(rrr).toBeDefined();
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
        expect(events.filter(e => e.name === 'LongAnimationFrame').length)
            .toBe(capture.streams.loaf.frames.length);

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
        const measureBegins = events.filter(e => e.cat === 'blink.user_timing' && e.ph === 'b');
        expect(measureBegins.length).toBe(ut.measures.length);

        // Profile: dedicated thread declared, X events nest within each depth chain.
        const profThread = events.find(e => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'JS Self-Profiling');
        expect(profThread).toBeDefined();
        const slices = checkProfileNesting(events, profThread.tid);
        expect(slices.length).toBe(capture.streams.profile.slices.length);
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

        const tsib = events.find(e => e.name === 'TracingStartedInBrowser');
        expect(tsib.args.data.frames[0].url).toBe(capture.streams.navigation.name);

        // User timing counts still match.
        const ut = capture.streams.userTiming;
        expect(events.filter(e => e.cat === 'blink.user_timing' && e.ph === 'I').length).toBe(ut.marks.length);
        expect(events.filter(e => e.cat === 'blink.user_timing' && e.ph === 'b').length).toBe(ut.measures.length);
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

        const begins = events.filter(e => e.cat === 'blink.user_timing' && e.ph === 'b');
        expect(begins.length).toBe(4);

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

        it('returns a synthesized trace via loadFile()', async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(path.join(SAMPLE_DIR, SAMPLE), { debug: true });
            expect(tool._sourceFormat).toBe('rumcap');
            await assertTraceResource(tool);
        });

        it('returns a synthesized trace via loadBuffer()', async () => {
            const tool = new WaterfallTools();
            const buf = new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, SAMPLE)));
            await tool.loadBuffer(buf, { debug: true });
            expect(tool._sourceFormat).toBe('rumcap');
            await assertTraceResource(tool);
        });

        it('returns a synthesized trace via loadStream() with explicit format', async () => {
            const tool = new WaterfallTools();
            const buf = new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, SAMPLE)));
            await tool.loadStream(new Blob([buf]).stream(), { format: 'rumcap', debug: true });
            expect(tool._sourceFormat).toBe('rumcap');
            await assertTraceResource(tool);
        });

        it('caches the synthesized bytes per page', async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(path.join(SAMPLE_DIR, SAMPLE), { debug: true });
            const pageId = Object.keys(tool.data.pages)[0];
            const first = await tool.getPageResource(pageId, 'trace');
            const second = await tool.getPageResource(pageId, 'trace');
            expect(tool._rumcapTraceCache[pageId]).toBeTruthy();
            // Same cached Uint8Array backs both responses.
            const a = first.buffer instanceof Uint8Array ? first.buffer.buffer : first.buffer;
            const b = second.buffer instanceof Uint8Array ? second.buffer.buffer : second.buffer;
            expect(a).toBe(b);
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
