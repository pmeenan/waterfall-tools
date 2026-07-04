/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';
import { computeClsFromShifts, computeInpFromInteractions, processRumcapNode, buildRumcapHarLog } from '../../src/inputs/rumcap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_DIR = path.resolve(__dirname, '../../Sample/Data/rumcap/chrome');
const REGENERATE_FIXTURES = process.env.REGENERATE_FIXTURES === 'true';

async function loadSample(fileName) {
    const tool = new WaterfallTools();
    await tool.loadFile(path.join(SAMPLE_DIR, fileName), { debug: true });
    return tool;
}

// rumcap clocks are anchored to the capture's own timeOrigin (stored in the file), so the
// output is fully deterministic — no dynamic-timestamp scrubbing is needed.
function checkGoldenFixture(result, fixtureName) {
    const refPath = path.resolve(__dirname, `../fixtures/${fixtureName}`);
    if (!fs.existsSync(refPath) || REGENERATE_FIXTURES) {
        console.log(`Generating golden fixture for ${fixtureName}...`);
        fs.mkdirSync(path.dirname(refPath), { recursive: true });
        fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        if (REGENERATE_FIXTURES) return;
    }
    const normalizedResult = JSON.parse(JSON.stringify(result));
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
    expect(normalizedResult).toEqual(ref);
}

describe('rumcap (.rcap) Input Processor', () => {

    it('parses a normal capture (google) against the golden fixture', async () => {
        const tool = await loadSample('chrome-www-google-com.rcap');
        const result = tool.getHar({ debug: true });
        checkGoldenFixture(result, 'rumcap-google.har.json');
        if (REGENERATE_FIXTURES) return;

        expect(result.log.version).toBe('1.2');
        expect(result.log.pages.length).toBe(1);
        expect(result.log.entries.length).toBeGreaterThan(50);

        const page = result.log.pages[0];
        // Milestones from the paint/lcp streams
        expect(page._render).toBeGreaterThan(0);
        expect(page._firstContentfulPaint).toBeGreaterThan(0);
        expect(page._LargestContentfulPaint).toBeGreaterThan(0);
        expect(page._CumulativeLayoutShift).toBeGreaterThan(0);
        expect(page._InteractionToNextPaint).toBeGreaterThan(0);
        expect(page._fullyLoaded).toBeCloseTo(7394.9, 3);

        // The longTasks stream is 'not-requested' in this capture — the field must be ABSENT
        // (tri-state contract: omission, not an empty array).
        expect(page._longTasks).toBeUndefined();
        // The profile stream is present but carries ZERO slices — nothing to fold, so the
        // main-thread band must be absent too.
        expect(page._mainThreadSlices).toBeUndefined();

        // Manifest / capture context round-trips through getHar()
        expect(page._rumcapManifest.longTasks.status).toBe('not-requested');
        expect(page._rumcapManifest.navigation.status).toBe('present');
        expect(page._rumcapEnvironment).toBeDefined();
        expect(page._user_timing).toBeDefined();
        expect(Object.keys(page._user_timing).length).toBeGreaterThan(0);
    });

    it('buildRumcapHarLog emits a true Extended HAR log (the standalone CLI contract)', async () => {
        // The per-format CLI wrapper writes { log: buildRumcapHarLog(data._rumcapCapture) } —
        // lock the shape so the wrapper's "Extended HAR" claim stays honest.
        const data = await processRumcapNode(path.join(SAMPLE_DIR, 'chrome-www-google-com.rcap'));
        const log = buildRumcapHarLog(data._rumcapCapture);

        expect(log.version).toBe('1.2');
        expect(log.creator.name).toContain('waterfall-tools');
        expect(log.pages.length).toBe(1);
        expect(log.entries.length).toBe(84);
        expect(log.entries[0]._is_base_page).toBe(true);
        expect(log.entries[0].request.url).toBe(log.pages[0].title);
        expect(log.pages[0]._rumcapManifest).toBeDefined();
        // Internal relational keys must never leak into the HAR shape.
        expect(log.metadata).toBeUndefined();
        expect(log._rumcapCapture).toBeUndefined();
    });

    it('emits the navigation as the first entry with the page URL and status mapping', async () => {
        const tool = await loadSample('chrome-www-google-com.rcap');
        const result = tool.getHar();
        const page = result.log.pages[0];
        const entries = result.log.entries.filter(e => e.pageref === page.id);

        // Navigation first, carrying the page URL
        const nav = entries[0];
        expect(nav.request.url).toBe('https://www.google.com/finance/beta');
        expect(nav.request.url).toBe(page.title);
        expect(nav._is_base_page).toBe(true);
        expect(nav.response.status).toBe(200);
        expect(nav._responseStatus).toBe(200);
        // Page zero == timeOrigin; navigation startTime is 0
        expect(new Date(nav.startedDateTime).getTime()).toBe(new Date(page.startedDateTime).getTime());

        // Opaque/CORS-hidden responseStatus 0 → assumed successful HAR 200, raw value preserved on _responseStatus
        const opaque = entries.find(e => e._responseStatus === 0);
        expect(opaque).toBeDefined();
        expect(opaque.response.status).toBe(200);
        expect(opaque._responseStatus).toBe(0);
        expect(opaque._statusAssumed).toBe(true);
    });

    it('maps absolute timing extensions only when the source phase is present', async () => {
        const tool = await loadSample('chrome-www-google-com.rcap');
        const result = tool.getHar();
        const nav = result.log.entries[0];

        // Fully instrumented navigation: requestStart=1.5, responseStart=83.2, responseEnd=314.9
        expect(nav._load_start).toBeCloseTo(1.5, 3);
        expect(nav._ttfb_start).toBeCloseTo(1.5, 3);
        expect(nav._ttfb_end).toBeCloseTo(83.2, 3);
        expect(nav._download_start).toBeCloseTo(83.2, 3);
        expect(nav._download_end).toBeCloseTo(314.9, 3);
        expect(nav._load_end).toBeCloseTo(314.9, 3);
        expect(nav._ttfb_ms).toBeCloseTo(81.7, 3);
        expect(nav._dns_start).toBeCloseTo(0.4, 3);
        expect(nav._ssl_start).toBeCloseTo(0.4, 3);

        // TAO-restricted resource (no requestStart/responseStart): the PARSER must leave the
        // connection-phase fields ABSENT, never 0. Assert at the relational layer — getHar()
        // additionally applies its documented WPT-compat fallbacks (_ttfb_start ← _load_start)
        // on export, which is a separate, format-agnostic concern.
        const relationalReqs = Object.values(tool.data.pages.page_1.requests);
        const rawOpaque = relationalReqs.find(r => r._responseStatus === 0);
        expect(rawOpaque._ttfb_start).toBeUndefined();
        expect(rawOpaque._ttfb_end).toBeUndefined();
        expect(rawOpaque._dns_start).toBeUndefined();
        expect(rawOpaque._connect_start).toBeUndefined();
        expect(rawOpaque._ssl_start).toBeUndefined();
        expect(rawOpaque._load_start).toBeGreaterThan(0); // fetchStart fallback
        expect(rawOpaque._load_end).toBeGreaterThan(rawOpaque._load_start);

        // In the exported HAR the fallback fills _ttfb_start with _load_start — it must never
        // invent an earlier (0) phase start.
        const opaque = result.log.entries.find(e => e._responseStatus === 0);
        expect(opaque._ttfb_start).toBe(opaque._load_start);
        expect(opaque._download_end).toBeGreaterThan(opaque._load_start);
    });

    it('parses the profile-heavy cpu6x capture (cnn) against the golden fixture', async () => {
        const tool = await loadSample('chrome-www-cnn-com-cpu6x.rcap');
        const result = tool.getHar({ debug: true });
        checkGoldenFixture(result, 'rumcap-cnn-cpu6x.har.json');
        if (REGENERATE_FIXTURES) return;

        const page = result.log.pages[0];

        // longTasks stream is present WITH entries here
        expect(Array.isArray(page._longTasks)).toBe(true);
        expect(page._longTasks.length).toBeGreaterThan(0);
        for (const [start, end] of page._longTasks) {
            expect(end).toBeGreaterThan(start);
        }

        // Profile folds into the single honest EvaluateScript category; the other four are
        // present but all-zero.
        const mts = page._mainThreadSlices;
        expect(mts).toBeDefined();
        expect(mts.slice_usecs).toBeGreaterThan(0);
        expect(mts.total_usecs).toBe(mts.slices.EvaluateScript.length * mts.slice_usecs);
        expect(mts.slices.EvaluateScript.some(v => v > 0)).toBe(true);
        for (const cat of ['ParseHTML', 'Layout', 'Paint', 'other']) {
            expect(mts.slices[cat].every(v => v === 0)).toBe(true);
        }
        // No cell can exceed the slice width
        expect(mts.slices.EvaluateScript.every(v => v <= mts.slice_usecs)).toBe(true);

        // Per-request JS execution overlays attributed via profile resource URLs
        const jsEntries = result.log.entries.filter(e => Array.isArray(e._js_timing) && e._js_timing.length > 0);
        expect(jsEntries.length).toBeGreaterThan(0);
        for (const e of jsEntries) {
            for (const [start, end] of e._js_timing) {
                expect(end).toBeGreaterThan(start);
            }
        }

        expect(page._InteractionToNextPaint).toBeGreaterThan(0);
    });

    it('parses the local fixture pair (elementTiming, server-timing, bfcache context)', async () => {
        const tool = await loadSample('chrome-local-fixture.rcap');
        const result = tool.getHar({ debug: true });
        checkGoldenFixture(result, 'rumcap-local-fixture.har.json');

        const bfTool = await loadSample('chrome-local-fixture-bfcache.rcap');
        const bfResult = bfTool.getHar({ debug: true });
        checkGoldenFixture(bfResult, 'rumcap-local-fixture-bfcache.har.json');
        if (REGENERATE_FIXTURES) return;

        const page = result.log.pages[0];
        expect(page._rumcapElementTiming.elements.length).toBe(4);
        expect(Array.isArray(page._longTasks)).toBe(true);
        expect(page._longTasks.length).toBeGreaterThan(0);
        expect(page._mainThreadSlices).toBeDefined();

        // Server-Timing lands entry-level (NOT nested under response)
        const nav = result.log.entries[0];
        expect(Array.isArray(nav._server_timing)).toBe(true);
        expect(nav._server_timing.find(st => st.name === 'db')).toEqual({ name: 'db', duration: 53.2, description: 'primary shard' });

        // User Timing measures keep their duration in the {time, duration} value shape
        const measure = page._user_timing['fixture:hydrate'];
        expect(measure).toBeDefined();
        expect(measure.time).toBe(0);
        expect(measure.duration).toBeGreaterThan(0);

        // bfcache variant: interactions stream was not requested → INP absent
        const bfPage = bfResult.log.pages[0];
        expect(bfPage._InteractionToNextPaint).toBeUndefined();
        expect(bfPage._rumcapManifest.interactions.status).toBe('not-requested');
        expect(Array.isArray(bfPage._longTasks)).toBe(true);
    });

    it('degraded capture: absent streams produce absent fields, never zeros', async () => {
        const tool = await loadSample('chrome-degraded.rcap');
        const result = tool.getHar({ debug: true });
        checkGoldenFixture(result, 'rumcap-degraded.har.json');
        if (REGENERATE_FIXTURES) return;

        const page = result.log.pages[0];

        // longTasks 'unsupported' → field entirely ABSENT (renderer suppresses the band row)
        expect(page._longTasks).toBeUndefined();
        // profile 'policy-blocked' → no main-thread band, no JS overlays
        expect(page._mainThreadSlices).toBeUndefined();
        expect(result.log.entries.every(e => e._js_timing === undefined)).toBe(true);
        // interactions 'not-requested' → no INP
        expect(page._InteractionToNextPaint).toBeUndefined();
        expect(page._rumcapInteractions).toBeUndefined();
        expect(page._rumcapLoaf).toBeUndefined();

        // Streams that ARE present still land
        expect(page._CumulativeLayoutShift).toBeGreaterThan(0);
        expect(page._render).toBeGreaterThan(0);
        expect(page._user_timing).toBeDefined();
        expect(page._rumcapManifest.longTasks.status).toBe('unsupported');
        expect(page._rumcapManifest.profile.status).toBe('policy-blocked');
    });

    it('tri-state _longTasks across the corpus: absent vs absent vs populated', async () => {
        // google: stream 'not-requested' → absent
        const google = (await loadSample('chrome-www-google-com.rcap')).getHar().log.pages[0];
        expect(google._longTasks).toBeUndefined();
        // degraded: stream 'unsupported' → absent
        const degraded = (await loadSample('chrome-degraded.rcap')).getHar().log.pages[0];
        expect(degraded._longTasks).toBeUndefined();
        // cnn cpu6x: stream 'present' with tasks → populated array
        const cnn = (await loadSample('chrome-www-cnn-com-cpu6x.rcap')).getHar().log.pages[0];
        expect(Array.isArray(cnn._longTasks)).toBe(true);
        expect(cnn._longTasks.length).toBeGreaterThan(0);
    });

    it('rejects invalid file paths safely', async () => {
        await expect(async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(path.join(SAMPLE_DIR, 'DOES_NOT_EXIST.rcap'), { debug: true, format: 'rumcap' });
        }).rejects.toThrow();
    });
});

describe('rumcap CLS max-session-window math', () => {
    it('sums shifts inside one session window', () => {
        expect(computeClsFromShifts([
            { startTime: 0, value: 0.1, hadRecentInput: false },
            { startTime: 500, value: 0.2, hadRecentInput: false }
        ])).toBeCloseTo(0.3, 10);
    });

    it('a gap of >= 1000ms starts a new session window', () => {
        expect(computeClsFromShifts([
            { startTime: 0, value: 0.1, hadRecentInput: false },
            { startTime: 500, value: 0.2, hadRecentInput: false },
            { startTime: 1600, value: 0.25, hadRecentInput: false } // 1100ms gap → new window
        ])).toBeCloseTo(0.3, 10);
    });

    it('a window span of >= 5000ms starts a new session window even with small gaps', () => {
        // Shifts every 900ms — every gap is < 1000, but at t=5400 the span from t=0 hits 5400
        // which exceeds the 5s window, so a new session starts there.
        const shifts = [];
        for (let t = 0; t <= 5400; t += 900) {
            shifts.push({ startTime: t, value: 0.1, hadRecentInput: false });
        }
        // First window: t=0..4500 → 6 shifts → 0.6; second window starts at 5400 → 0.1
        expect(computeClsFromShifts(shifts)).toBeCloseTo(0.6, 10);
    });

    it('ignores shifts with hadRecentInput === true', () => {
        expect(computeClsFromShifts([
            { startTime: 0, value: 0.1, hadRecentInput: false },
            { startTime: 100, value: 5.0, hadRecentInput: true },
            { startTime: 200, value: 0.1, hadRecentInput: false }
        ])).toBeCloseTo(0.2, 10);
    });

    it('returns 0 for no qualifying shifts (a present-but-quiet stream is a real CLS of 0)', () => {
        expect(computeClsFromShifts([])).toBe(0);
        expect(computeClsFromShifts([{ startTime: 0, value: 1, hadRecentInput: true }])).toBe(0);
    });
});

describe('rumcap INP estimator', () => {
    it('returns the worst interaction below 50 total interactions', () => {
        expect(computeInpFromInteractions([
            { interactionId: 1, duration: 100 },
            { interactionId: 1, duration: 200 }, // same interaction — max wins
            { interactionId: 2, duration: 50 }
        ])).toBe(200);
    });

    it('groups by nonzero interactionId only', () => {
        expect(computeInpFromInteractions([
            { interactionId: 0, duration: 999 }, // not an interaction
            { duration: 888 },                   // no id at all
            { interactionId: 7, duration: 40 }
        ])).toBe(40);
    });

    it('returns null (not 0) when there are no interactions', () => {
        expect(computeInpFromInteractions([])).toBeNull();
        expect(computeInpFromInteractions([{ interactionId: 0, duration: 10 }])).toBeNull();
    });

    it('uses the p98 candidate index at >= 50 interactions', () => {
        // 60 interactions with durations 1..60 → candidateIndex = floor(60/50) = 1 → the
        // second-worst duration (59).
        const events = [];
        for (let i = 1; i <= 60; i++) events.push({ interactionId: i, duration: i });
        expect(computeInpFromInteractions(events)).toBe(59);
    });
});
