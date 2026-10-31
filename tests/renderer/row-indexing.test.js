/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// Regression tests for renderer row indexing / interaction fixes:
//   R1 — connection view must resolve each row's request via `row.viewIndex`
//        (the filtered array) rather than `row.index` (the caller's original
//        position), otherwise reqFilter collapses the wrong connections.
//   R2 — the thumbnail torn-edge row is not a request: no hit target, and the
//        label pass numbers rows by original index (`row.index + 1`).
//   R3 — touch gestures measure the visible window in absolute seconds with
//        nullish (not falsy) handling of startTime.
//   B2 — headless canvases (@napi-rs/canvas) have no addEventListener; the
//        renderer must construct and draw without binding DOM events.
//   Layout must not mutate the caller's entry objects.
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { Layout } from '../../src/renderer/layout.js';
import { WaterfallCanvas } from '../../src/renderer/canvas.js';

const makeEntries = (specs) => specs.map((spec, i) => ({
    url: spec.url || `https://example.com/${i}`,
    mimeType: 'text/html',
    status: 200,
    time_start: i * 10,
    time_end: i * 10 + 5,
    connection_id: spec.connection_id,
    timings: { dns: 0, connect: 0, ssl: 0, send: 0, wait: 2, receive: 3 }
}));

describe('Layout.calculateRows indexing', () => {
    it('does not mutate caller entry objects', () => {
        const entries = makeEntries([{}, {}, {}]);
        const before = JSON.stringify(entries);
        Layout.calculateRows(entries, 1000, { reqFilter: '2-3', urlFilter: 'example.com' });
        Layout.calculateRows(entries, 1000, { thumbnailView: true, thumbMaxReqs: 2 });
        expect(JSON.stringify(entries)).toBe(before);
        expect(entries.some(e => '_originalIndex' in e)).toBe(false);
    });

    it('keeps row.index as the original position and row.viewIndex as the filtered position', () => {
        const entries = makeEntries([{}, {}, {}, {}]);
        const { rows } = Layout.calculateRows(entries, 1000, { reqFilter: '2,4' });
        expect(rows.map(r => r.index)).toEqual([1, 3]);
        expect(rows.map(r => r.viewIndex)).toEqual([0, 1]);
    });

    it('connection view with reqFilter groups by the filtered rows\' own connection ids', () => {
        // Original order: [A, B, A, C]. Filtering to requests 2-4 leaves [B, A, C].
        // With the old `entries[row.index]` lookup, row 0 (original index 1)
        // read filtered entry 1 (connection A) and rows collapsed incorrectly.
        const entries = makeEntries([
            { connection_id: 'A' },
            { connection_id: 'B' },
            { connection_id: 'A' },
            { connection_id: 'C' }
        ]);
        const { rows, dimensions } = Layout.calculateRows(entries, 1000, {
            reqFilter: '2-4',
            connectionView: true
        });
        expect(rows.map(r => r.index)).toEqual([1, 2, 3]);
        // Three distinct connections → three distinct rows.
        expect(new Set(rows.map(r => r.y1)).size).toBe(3);
        expect(dimensions.totalRows).toBe(3);
    });

    it('connection view collapses requests that share a connection after filtering', () => {
        const entries = makeEntries([
            { connection_id: 'A' },
            { connection_id: 'B' },
            { connection_id: 'B' }
        ]);
        const { rows, dimensions } = Layout.calculateRows(entries, 1000, {
            reqFilter: '2-3',
            connectionView: true
        });
        expect(rows).toHaveLength(2);
        expect(rows[0].y1).toBe(rows[1].y1);
        expect(dimensions.totalRows).toBe(1);
    });

    it('thumbnail truncation inserts a torn-edge row and preserves original indices around it', () => {
        const entries = makeEntries(Array.from({ length: 10 }, () => ({})));
        const { rows } = Layout.calculateRows(entries, 1000, { thumbnailView: true, thumbMaxReqs: 4 });
        expect(rows).toHaveLength(5);
        expect(rows[2].isTornEdge).toBe(true);
        expect(rows.filter(r => !r.isTornEdge).map(r => r.index)).toEqual([0, 1, 8, 9]);
    });
});

describe('WaterfallCanvas interaction targets', () => {
    const withRows = (rows, dimensions, options = {}) => {
        const wc = Object.create(WaterfallCanvas.prototype);
        wc.options = options;
        wc.drawnRows = { rows, dimensions };
        return wc;
    };

    it('never returns the torn-edge row as a hit target', () => {
        const entries = makeEntries(Array.from({ length: 10 }, () => ({})));
        const layout = Layout.calculateRows(entries, 1000, { thumbnailView: true, thumbMaxReqs: 4 });
        const torn = layout.rows.find(r => r.isTornEdge);
        const wc = withRows(layout.rows, layout.dimensions, { thumbnailView: true });
        const hit = wc._getInteractionTarget(10, torn.y1 + 1);
        expect(hit === null || !hit.isTornEdge).toBe(true);
    });
});

describe('WaterfallCanvas touch window math', () => {
    const withState = (options, maxTime) => {
        const wc = Object.create(WaterfallCanvas.prototype);
        wc.options = options;
        wc.drawnRows = { rows: [], dimensions: { maxTime, absoluteMaxTime: 10000 } };
        return wc;
    };

    it('derives the absolute end from startTime + visible span when endTime is unset', () => {
        // Zoomed in to start at 2s with no explicit end: layout reports maxTime
        // relative to startTime (3000ms span), so the absolute end is 5s.
        expect(withState({ startTime: 2 }, 3000)._getVisibleWindowSec()).toEqual({ start: 2, end: 5 });
    });

    it('treats startTime 0 / null as 0 and honours an explicit endTime', () => {
        expect(withState({ startTime: 0, endTime: 4 }, 4000)._getVisibleWindowSec()).toEqual({ start: 0, end: 4 });
        expect(withState({ startTime: null, endTime: null }, 6000)._getVisibleWindowSec()).toEqual({ start: 0, end: 6 });
    });
});

describe('WaterfallCanvas headless (Node) canvas', () => {
    it('constructs, draws and destroys on a @napi-rs/canvas without DOM event APIs', () => {
        const entries = makeEntries([{}, {}, {}]);
        const layout = Layout.calculateRows(entries, 800, { showLegend: true });
        const canvas = createCanvas(800, Math.max(1, layout.dimensions.canvasHeight));
        expect(typeof canvas.addEventListener).not.toBe('function');

        const renderer = new WaterfallCanvas(null, { canvas, width: 800 });
        renderer.pageData = {};
        renderer.rawEntries = entries;
        expect(() => renderer.draw(layout.rows, layout.dimensions, layout.pageEvents)).not.toThrow();
        expect(() => renderer.destroy()).not.toThrow();
    });

    it('cancels a pending render on destroy', () => {
        const canvas = createCanvas(100, 100);
        const renderer = new WaterfallCanvas(null, { canvas, width: 100 });
        renderer.rawEntries = makeEntries([{}]);
        renderer.pageData = {};
        renderer._requestRender();
        expect(renderer.pendingRender).not.toBeNull();
        renderer.destroy();
        expect(renderer.pendingRender).toBeNull();
        // Late requests after destroy are ignored.
        renderer._requestRender();
        expect(renderer.pendingRender).toBeNull();
    });
});
