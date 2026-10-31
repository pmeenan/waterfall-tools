/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { getRenderSortEpoch, sortEntriesForRender } from '../../src/renderer/entry-sort.js';

describe('entry-sort (shared canvas / generateImage row order)', () => {
    it('orders absolute-timing entries by max(request start, connect end)', () => {
        const entries = [
            { id: 'late', _load_start: 300 },
            { id: 'queued', _load_start: 50, _connect_start: 60, _connect_end: 250 },
            { id: 'early', _load_start: 100 }
        ];
        sortEntriesForRender(entries);
        expect(entries.map(e => e.id)).toEqual(['early', 'queued', 'late']);
        expect(getRenderSortEpoch({ _load_start: 50, _connect_end: 250 })).toBe(250);
    });

    it('falls back to time_start plus positive pre-send phases', () => {
        expect(getRenderSortEpoch({ time_start: 1000, timings: { blocked: 5, dns: -1, connect: 20, send: 1 } })).toBe(1026);
        const entries = [
            { id: 'b', time_start: 1000, timings: { blocked: 50 } },
            { id: 'a', time_start: 1010, timings: {} }
        ];
        expect(sortEntriesForRender(entries).map(e => e.id)).toEqual(['a', 'b']);
    });
});
