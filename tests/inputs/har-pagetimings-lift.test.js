/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

// Minimal HAR-shaped fixture. chrome-har / Browsertime / sitespeed.io nest
// page-timing extensions inside `pageTimings.*` rather than on the page
// root. The importer normalises both shapes onto the canonical page-root
// field names the renderer reads.
function makeHarWithPageTimingsExtensions(extras = {}) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'chrome-har', version: '1.0.0' },
            pages: [{
                id: 'page_1',
                title: 'test',
                startedDateTime: '2025-01-01T00:00:00.000Z',
                pageTimings: {
                    onContentLoad: 200,
                    onLoad: 300,
                    _firstPaint: 90,
                    _firstContentfulPaint: 120,
                    _largestContentfulPaint: 250,
                    _domInteractiveTime: 180,
                    _longTasks: [[100, 180], [220, 305]],
                    _userTimings: { 'app-init': 50, 'app-ready': 250 },
                    ...(extras.pageTimings || {})
                },
                ...extras.pageRoot
            }],
            entries: [{
                startedDateTime: '2025-01-01T00:00:00.000Z',
                time: 100,
                pageref: 'page_1',
                request: { method: 'GET', url: 'https://example.com/', headers: [] },
                response: { status: 200, headers: [], content: {} },
                timings: { dns: -1, connect: -1, ssl: -1, send: 0, wait: 50, receive: 50 }
            }]
        }
    };
}

async function loadHar(har) {
    const wt = new WaterfallTools();
    const buffer = new TextEncoder().encode(JSON.stringify(har));
    await wt.loadBuffer(buffer);
    return wt.getHar().log.pages[0];
}

describe('HAR pageTimings extension lift', () => {
    it('lifts named numeric extensions onto canonical page-root names', async () => {
        const page = await loadHar(makeHarWithPageTimingsExtensions());
        expect(page._render).toBe(90);
        expect(page._firstContentfulPaint).toBe(120);
        expect(page._LargestContentfulPaint).toBe(250);
        expect(page._domInteractive).toBe(180);
    });

    it('lifts _longTasks ranges onto page._longTasks', async () => {
        const page = await loadHar(makeHarWithPageTimingsExtensions());
        expect(page._longTasks).toEqual([[100, 180], [220, 305]]);
    });

    it('lifts _userTimings onto page._user_timing', async () => {
        const page = await loadHar(makeHarWithPageTimingsExtensions());
        expect(page._user_timing).toEqual({ 'app-init': 50, 'app-ready': 250 });
    });

    it('page-root values win on conflict', async () => {
        const page = await loadHar(makeHarWithPageTimingsExtensions({
            pageRoot: {
                _firstContentfulPaint: 999,
                _LargestContentfulPaint: 888,
                _longTasks: [[1, 2]],
                _user_timing: { existing: 42 }
            }
        }));
        expect(page._firstContentfulPaint).toBe(999);
        expect(page._LargestContentfulPaint).toBe(888);
        expect(page._longTasks).toEqual([[1, 2]]);
        expect(page._user_timing).toEqual({ existing: 42 });
    });

    it('skips when pageTimings is missing or empty', async () => {
        const har = {
            log: {
                version: '1.2',
                creator: { name: 'test', version: '1' },
                pages: [{
                    id: 'page_1',
                    title: 'test',
                    startedDateTime: '2025-01-01T00:00:00.000Z',
                    pageTimings: {}
                }],
                entries: [{
                    startedDateTime: '2025-01-01T00:00:00.000Z',
                    time: 100,
                    pageref: 'page_1',
                    request: { method: 'GET', url: 'https://example.com/', headers: [] },
                    response: { status: 200, headers: [], content: {} },
                    timings: { dns: -1, connect: -1, ssl: -1, send: 0, wait: 50, receive: 50 }
                }]
            }
        };
        const page = await loadHar(har);
        // har-converter normalizes "missing" numerics to -1 (its sentinel
        // for unrendered metrics); collections stay undefined when not
        // populated by either source.
        expect(page._render).toBe(-1);
        expect(page._firstContentfulPaint).toBe(-1);
        expect(page._longTasks).toBeUndefined();
        expect(page._user_timing).toBeUndefined();
    });

    it('preserves the original pageTimings field for HAR-faithful round-trips', async () => {
        // The lift copies values onto page-root but doesn't strip the
        // originals — downloaders that re-export the HAR should see the
        // exact same structure they uploaded.
        const page = await loadHar(makeHarWithPageTimingsExtensions());
        expect(page.pageTimings._firstContentfulPaint).toBe(120);
        expect(page.pageTimings._longTasks).toEqual([[100, 180], [220, 305]]);
    });
});
