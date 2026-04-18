/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('WPTagent ZIP Input Processor', () => {

    it('Should parse roadtrip wptagent zip and extract response bodies', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/wptagent/roadtrip-wptagent.zip');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wptagent' });
        const result = tool.getHar({ debug: true });

        expect(result.log.version).toBe('1.2');
        expect(result.log.creator.name).toBe('waterfall-tools');
        expect(result.log.pages.length).toBeGreaterThan(0);
        expect(result.log.entries.length).toBeGreaterThan(0);

        // Verify that response bodies were extracted from the nested _bodies.zip
        const entriesWithBody = result.log.entries.filter(
            e => e.response && e.response.content && e.response.content.text
        );
        expect(entriesWithBody.length).toBeGreaterThan(0);

        // The first entry (the HTML document) should have a body
        const htmlEntry = result.log.entries.find(
            e => e.response && e.response.content && e.response.content.mimeType === 'text/html'
                && e.response.content.text
        );
        expect(htmlEntry).toBeTruthy();
        expect(htmlEntry.response.content.encoding).toBe('base64');

        // Verify the base64 body decodes to valid content
        const decoded = Buffer.from(htmlEntry.response.content.text, 'base64');
        expect(decoded.length).toBeGreaterThan(0);

        // The roadtrip wptagent zip has 29 body files for first view
        // Verify a reasonable number were linked
        const firstViewBodies = result.log.entries.filter(
            e => e._run === 1 && e._cached === 0
                && e.response && e.response.content && e.response.content.text
        );
        expect(firstViewBodies.length).toBeGreaterThanOrEqual(20);
    }, 30000);

    it('Should fold the main-thread CPU slices from timeline_cpu.json onto the page', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/wptagent/www.theverge.com-desktop.zip');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wptagent' });
        const result = tool.getHar({ debug: true });

        const firstViewPage = result.log.pages.find(p => p._run === 1 && p._cached === 0);
        expect(firstViewPage).toBeTruthy();
        expect(firstViewPage._mainThreadSlices).toBeTruthy();

        const slices = firstViewPage._mainThreadSlices;
        expect(slices.slice_usecs).toBe(10000);
        expect(slices.total_usecs).toBeGreaterThan(0);
        expect(Object.keys(slices.slices).length).toBeGreaterThan(0);

        // Must fold into canonical flame-chart categories only.
        for (const cat of Object.keys(slices.slices)) {
            expect(['ParseHTML', 'Layout', 'Paint', 'EvaluateScript', 'other']).toContain(cat);
        }

        // ParseHTML and EvaluateScript are always non-empty on theverge main thread.
        expect(slices.slices.ParseHTML).toBeDefined();
        expect(slices.slices.EvaluateScript).toBeDefined();
        const anyNonZero = slices.slices.EvaluateScript.some(v => v > 0);
        expect(anyNonZero).toBe(true);

        // Total summed microseconds should never exceed slice_count * slice_usecs (the window size).
        const sliceCount = slices.slices.EvaluateScript.length;
        for (const arr of Object.values(slices.slices)) {
            expect(arr.length).toBe(sliceCount);
            for (const v of arr) {
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(slices.slice_usecs);
            }
        }
    }, 30000);

    it('Should attach progress.csv utilization to each run/cached page', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/wptagent/roadtrip-wptagent.zip');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wptagent' });
        const result = tool.getHar({ debug: true });

        // The roadtrip zip has 3 runs × first/cached = 6 pages; every page must have
        // its own CPU and bandwidth series formatted for the renderer.
        for (const page of result.log.pages) {
            expect(page._utilization, `page ${page.id} missing _utilization`).toBeTruthy();
            expect(Array.isArray(page._utilization.cpu)).toBe(true);
            expect(page._utilization.cpu.length).toBeGreaterThan(0);
            expect(Array.isArray(page._utilization.bw)).toBe(true);
            expect(page._utilization.bw.length).toBeGreaterThan(0);
            // Renderer reads bwMax to scale the graph — the legacy `.max` property is
            // preserved for Node consumers but the Browser/Worker path needs bwMax.
            expect(page._utilization.bwMax).toBeGreaterThan(0);
        }
    }, 30000);

    it('Should attach script_timing.json JS execution ranges to matching entries', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/wptagent/roadtrip-wptagent.zip');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wptagent' });
        const result = tool.getHar({ debug: true });

        const jsEntries = result.log.entries.filter(
            e => Array.isArray(e._js_timing) && e._js_timing.length > 0
        );
        expect(jsEntries.length).toBeGreaterThan(0);

        // Every entry's js_timing should be a list of [start_ms, end_ms] ordered pairs.
        for (const entry of jsEntries) {
            for (const pair of entry._js_timing) {
                expect(Array.isArray(pair)).toBe(true);
                expect(pair.length).toBe(2);
                expect(Number.isFinite(pair[0])).toBe(true);
                expect(Number.isFinite(pair[1])).toBe(true);
                expect(pair[1]).toBeGreaterThanOrEqual(pair[0]);
            }
        }

        // The top-level document usually accumulates EvaluateScript/FunctionCall spans.
        const doc = result.log.entries.find(
            e => e._run === 1 && e._cached === 0 && e._full_url === 'https://roadtrip.meenan.us/'
        );
        expect(doc?._js_timing?.length).toBeGreaterThan(0);
    }, 30000);

    it('Should include body metadata (_body_file, _body_hash) on entries', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/wptagent/roadtrip-wptagent.zip');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wptagent' });
        const result = tool.getHar({ debug: true });

        // Entries that originally had body_file should have _body_file preserved
        const withBodyFile = result.log.entries.filter(e => e._body_file);
        expect(withBodyFile.length).toBeGreaterThan(0);
    }, 30000);
});
