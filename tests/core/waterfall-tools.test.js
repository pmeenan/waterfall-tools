/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';
import { relationalToHar } from '../../src/core/har-export.js';
import { parsers } from '../../src/inputs/orchestrator.js';

describe('WaterfallTools.getDefaultOptions', () => {
    it('includes an empty urlFilter alongside reqFilter', () => {
        const opts = WaterfallTools.getDefaultOptions();
        expect(opts).toHaveProperty('urlFilter');
        expect(opts.urlFilter).toBe('');
        expect(opts).toHaveProperty('reqFilter');
    });
});


function toolWithPage(page, extra = {}) {
    const wt = new WaterfallTools();
    wt.data = { metadata: {}, pages: { page_1: page }, tcp_connections: {}, quic_connections: {}, dns: {} };
    Object.assign(wt, extra);
    return wt;
}

describe('WaterfallTools.getPageResource (Node contract)', () => {
    it('returns a Uint8Array buffer and no object URL outside a DOM context', async () => {
        const payload = new TextEncoder().encode('{"constants":{}}');
        const wt = toolWithPage({ id: 'page_1' }, {
            _sourceFormat: 'netlog',
            _rawBuffer: payload.buffer.slice(0)
        });
        try {
            const resource = await wt.getPageResource('page_1', 'netlog');
            expect(resource).toBeTruthy();
            expect(resource.buffer).toBeInstanceOf(Uint8Array);
            expect(resource.buffer.byteOffset).toBe(0);
            expect(resource.buffer.byteLength).toBe(resource.buffer.buffer.byteLength);
            expect(Array.from(resource.buffer)).toEqual(Array.from(payload));
            expect(resource.mimeType).toBe('application/json');
            expect(resource.url).toBeUndefined();
        } finally {
            await wt.destroy();
        }
    });

    it('returns Uint8Array for raw perfetto trace passthrough', async () => {
        const payload = new Uint8Array([0x0a, 0x02, 0x08, 0x01]);
        const wt = toolWithPage({ id: 'page_1' }, {
            _sourceFormat: 'perfetto',
            _rawBuffer: payload.buffer.slice(0)
        });
        try {
            const resource = await wt.getPageResource('page_1', 'trace');
            expect(resource.buffer).toBeInstanceOf(Uint8Array);
            expect(resource.mimeType).toBe('application/octet-stream');
            expect(resource.url).toBeUndefined();
        } finally {
            await wt.destroy();
        }
    });
});

describe('WaterfallTools.getPageResource screenshot validation', () => {
    const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

    async function screenshotFor(value) {
        const wt = toolWithPage({ id: 'page_1', _screenshot: value });
        try {
            return await wt.getPageResource('page_1', 'screenshot');
        } finally {
            await wt.destroy();
        }
    }

    it('passes through well-formed base64 image data URIs', async () => {
        const res = await screenshotFor(`data:image/png;base64,${PNG_B64}`);
        expect(res).toEqual({ url: `data:image/png;base64,${PNG_B64}`, mimeType: 'image/png' });
    });

    it('normalizes image/jpg to image/jpeg', async () => {
        const res = await screenshotFor('data:image/jpg;base64,/9j/4AAQ');
        expect(res).toEqual({ url: 'data:image/jpeg;base64,/9j/4AAQ', mimeType: 'image/jpeg' });
    });

    it('prefixes validated raw base64 and sniffs the image type', async () => {
        expect(await screenshotFor('/9j/4AAQSkZJRg==')).toEqual({ url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', mimeType: 'image/jpeg' });
        expect((await screenshotFor(PNG_B64)).mimeType).toBe('image/png');
        // Line-wrapped base64 is accepted after whitespace removal.
        expect((await screenshotFor('/9j/\n4AAQ')).url).toBe('data:image/jpeg;base64,/9j/4AAQ');
    });

    it('rejects markup, non-image, and script payloads', async () => {
        const bad = [
            'data:image/svg+xml;base64,PHN2Zz4=',
            'data:text/html;base64,PHNjcmlwdD4=',
            'data:image/png;base64,AAAA" onerror="alert(1)',
            'javascript:alert(1)',
            '"><img src=x onerror=alert(1)>',
            'data:image/png,rawdata'
        ];
        for (const value of bad) {
            expect(await screenshotFor(value)).toBeNull();
        }
    });
});

describe('WaterfallTools unloaded-state errors', () => {
    it('throws a clear error (not a TypeError) when no data is loaded', async () => {
        const wt = new WaterfallTools();
        await wt.destroy();
        expect(() => wt.getHar()).toThrow(/No data loaded/);
        expect(() => wt.getPage('page_1')).toThrow(/No data loaded/);
        await expect(wt.getPageResource('page_1', 'trace')).rejects.toThrow(/No data loaded/);
        await expect(wt.generateImage()).rejects.toThrow(/No data loaded/);
    });

    it('leaves a consistent state when a parser throws mid-load', async () => {
        const wt = toolWithPage({ id: 'page_1' }, { _sourceFormat: 'netlog', _rawBuffer: new ArrayBuffer(4) });
        const original = parsers.har;
        parsers.har = async () => { throw new Error('boom'); };
        try {
            await expect(wt.loadStream(new Blob(['x']).stream(), { format: 'har' })).rejects.toThrow('boom');
            expect(wt.data).toBeNull();
            expect(wt._sourceFormat).toBeNull();
            expect(wt._rawBuffer).toBeNull();
            expect(() => wt.getHar()).toThrow(/No data loaded/);
            expect(() => wt.getPage('page_1')).toThrow(/No data loaded/);
        } finally {
            parsers.har = original;
            await wt.destroy();
        }
    });
});

describe('relationalToHar status export', () => {
    it('preserves status 0 (aborted) and only defaults a missing status to 200', () => {
        const data = {
            metadata: {},
            pages: {
                page_1: {
                    id: 'page_1', url: 'https://example.com/', startedDateTime: '2026-01-01T00:00:00.000Z',
                    requests: {
                        a: { url: 'https://example.com/a', time_start: 1000, time_end: 1100, status: 0 },
                        b: { url: 'https://example.com/b', time_start: 1001, time_end: 1100 },
                        c: { url: 'https://example.com/c', time_start: 1002, time_end: 1100, status: 404 }
                    }
                }
            }
        };
        const har = relationalToHar(data);
        const byUrl = Object.fromEntries(har.log.entries.map(e => [e.request.url, e.response.status]));
        expect(byUrl['https://example.com/a']).toBe(0);
        expect(byUrl['https://example.com/b']).toBe(200);
        expect(byUrl['https://example.com/c']).toBe(404);
    });
});
