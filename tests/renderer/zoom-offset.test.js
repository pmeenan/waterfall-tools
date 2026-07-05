/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// Regression tests for the drag-to-zoom offset fixes (Phase 11 review):
//   B1 — page-level overlays (metric lines, user-timing marks, CPU/BW graphs,
//        long-task band, JS-execution overlays) must be shifted by the zoom
//        window origin (startTime) before scaling to x, the same way request
//        bars already subtract baseStartMs. `_viewOffsetMs` / `_toVisibleMs` are
//        that shared offset; unzoomed they must be inert.
//   M1 — dimensions.absoluteMaxTime must stay the ABSOLUTE (page-zero) data
//        extent so touch pan/pinch clamps against the real extent after a zoom,
//        while dimensions.maxTime reflects the (shrunken) visible window span.
//   M4 — dimensions.yOffset must be exposed so the renderer stops inferring the
//        top offset from `rows[0].y1 > 35` (which misfired for rowHeight >= 36
//        with the legend hidden).
import { describe, it, expect } from 'vitest';
import { Layout } from '../../src/renderer/layout.js';
import { WaterfallCanvas } from '../../src/renderer/canvas.js';

const entries = [
    {
        index: 0, _originalIndex: 0, url: 'https://example.com/', mimeType: 'text/html',
        status: 200, time_start: 0, time_end: 2000,
        timings: { dns: 0, connect: 0, ssl: 0, send: 0, wait: 1000, receive: 1000 }
    },
    {
        index: 1, _originalIndex: 1, url: 'https://example.com/app.js', mimeType: 'application/javascript',
        status: 200, time_start: 0, time_end: 10000,
        timings: { dns: 0, connect: 0, ssl: 0, send: 0, wait: 5000, receive: 5000 }
    }
];

describe('drag-to-zoom offset (B1: _viewOffsetMs / _toVisibleMs)', () => {
    // These helpers only read this.options, so exercise them off the prototype
    // without constructing a DOM-bound canvas.
    const withOptions = (options) => {
        const wc = Object.create(WaterfallCanvas.prototype);
        wc.options = options;
        return wc;
    };

    it('is inert when not zoomed', () => {
        const wc = withOptions({});
        expect(wc._viewOffsetMs()).toBe(0);
        expect(wc._toVisibleMs(5000)).toBe(5000);
    });

    it('subtracts the zoom window origin (startTime seconds -> ms) when zoomed', () => {
        const wc = withOptions({ startTime: 2 });
        expect(wc._viewOffsetMs()).toBe(2000);
        // A metric at 5000ms of page time sits 3000ms into a window that starts at 2s.
        expect(wc._toVisibleMs(5000)).toBe(3000);
    });
});

describe('drag-to-zoom extent (M1: absoluteMaxTime vs maxTime)', () => {
    it('keeps absoluteMaxTime as the page-zero extent while maxTime tracks the window', () => {
        const unzoomed = Layout.calculateRows(entries, 1000, {});
        const zoomed = Layout.calculateRows(entries, 1000, { startTime: 2 });

        // Sanity: the data really spans past the 2s zoom origin.
        expect(unzoomed.dimensions.maxTime).toBeGreaterThan(2000);

        // Zooming shrinks the visible window span by the 2s offset...
        expect(zoomed.dimensions.maxTime).toBeCloseTo(unzoomed.dimensions.maxTime - 2000, 5);
        // ...but the absolute extent used for pan/pinch clamping is unchanged.
        expect(zoomed.dimensions.absoluteMaxTime).toBeCloseTo(unzoomed.dimensions.maxTime, 5);
    });
});

describe('renderer top offset (M4: dimensions.yOffset)', () => {
    it('exposes yOffset (35 with legend, 0 for thumbnail / no legend)', () => {
        expect(Layout.calculateRows(entries, 1000, { showLegend: true }).dimensions.yOffset).toBe(35);
        expect(Layout.calculateRows(entries, 1000, { showLegend: true, thumbnailView: true }).dimensions.yOffset).toBe(0);
        expect(Layout.calculateRows(entries, 1000, {}).dimensions.yOffset).toBe(0);
    });

    it('stays 0 for a large rowHeight without a legend (old y1 > 35 heuristic misfired here)', () => {
        const big = Layout.calculateRows(entries, 1000, { rowHeight: 40 });
        expect(big.dimensions.yOffset).toBe(0);
        // First row top is yOffset + rowHeight, not a spurious inferred 35.
        expect(big.rows[0].y1).toBe(40);
    });
});
