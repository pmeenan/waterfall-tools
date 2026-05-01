/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { Layout } from '../../src/renderer/layout.js';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

const oneEntry = [{
    index: 0,
    _originalIndex: 0,
    url: 'https://example.com/',
    mimeType: 'text/html',
    status: 200,
    time_start: 0,
    time_end: 100,
    timings: { dns: 0, connect: 0, ssl: 0, send: 0, wait: 50, receive: 50 }
}];

describe('Theming options surface', () => {
    it('exposes rowHeight, backgroundColor, palette in getDefaultOptions', () => {
        const opts = WaterfallTools.getDefaultOptions();
        expect(opts).toHaveProperty('rowHeight');
        expect(opts).toHaveProperty('backgroundColor');
        expect(opts).toHaveProperty('palette');
        // Defaults must be inert (null/{}); pre-existing visual is preserved.
        expect(opts.rowHeight).toBeNull();
        expect(opts.backgroundColor).toBeNull();
        expect(opts.palette).toEqual({});
    });

    it('keeps the historical default rowHeight (18 standard, 4 thumbnail)', () => {
        const std = Layout.calculateRows(oneEntry, 1000, {});
        const thumb = Layout.calculateRows(oneEntry, 1000, { thumbnailView: true });
        // The first request row's `y2 - y1 + 1` reflects the rowHeight used.
        // (Layout offsets from rowHeight + topOffset, so the row height appears
        // as the y1→y2 span for non-tornedge rows.)
        expect(std.rows[0].y2 - std.rows[0].y1 + 1).toBe(18);
        expect(thumb.rows[0].y2 - thumb.rows[0].y1 + 1).toBe(4);
    });

    it('honours an explicit rowHeight override', () => {
        const big = Layout.calculateRows(oneEntry, 1000, { rowHeight: 32 });
        expect(big.rows[0].y2 - big.rows[0].y1 + 1).toBe(32);
    });

    it('rejects non-positive or non-numeric rowHeight (falls back to default)', () => {
        const zero = Layout.calculateRows(oneEntry, 1000, { rowHeight: 0 });
        const neg = Layout.calculateRows(oneEntry, 1000, { rowHeight: -10 });
        const str = Layout.calculateRows(oneEntry, 1000, { rowHeight: '24' });
        for (const out of [zero, neg, str]) {
            expect(out.rows[0].y2 - out.rows[0].y1 + 1).toBe(18);
        }
    });

    it('thumbnail view ignores rowHeight when thumbnailView is set without an explicit override', () => {
        // When the caller passes only `thumbnailView: true` (no rowHeight),
        // the historical 4 px row height applies.
        const thumb = Layout.calculateRows(oneEntry, 1000, { thumbnailView: true });
        expect(thumb.rows[0].y2 - thumb.rows[0].y1 + 1).toBe(4);
    });

    it('rowHeight override wins even in thumbnail view', () => {
        const thumb = Layout.calculateRows(oneEntry, 1000, { thumbnailView: true, rowHeight: 12 });
        expect(thumb.rows[0].y2 - thumb.rows[0].y1 + 1).toBe(12);
    });
});
