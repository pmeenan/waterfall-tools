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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_DIR = path.resolve(__dirname, '../../Sample/Data/qlog');

// The canonical multi-drop test set: one www.google.com page load over HTTP/3,
// one qlog file per origin/QUIC connection.
const AIOQUIC_FILES = [
    'aioquic/www.google.com.qlog.gz',
    'aioquic/fonts.gstatic.com.qlog.gz',
    'aioquic/ogads-pa.clients6.google.com.qlog.gz',
    'aioquic/play.google.com.qlog.gz',
    'aioquic/www.gstatic.com.qlog.gz'
];

function readSample(rel) {
    return new Uint8Array(fs.readFileSync(path.join(SAMPLE_DIR, rel)));
}

function paddedView(bytes, prefixLength = 7, suffixLength = 11) {
    const backing = new Uint8Array(prefixLength + bytes.byteLength + suffixLength);
    backing.fill(0x7b);
    backing.set(bytes, prefixLength);
    return backing.subarray(prefixLength, prefixLength + bytes.byteLength);
}

// Minimal buffer that identifyFormatFromBuffer sniffs as 'har' (matches the
// orchestrator's `{"log":{"version":` token check). Never parsed — every
// mixed/multi-format test must throw before any parser runs.
function syntheticHarBuffer() {
    return new TextEncoder().encode(JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '0' }, pages: [], entries: [] }
    }));
}

describe('WaterfallTools.loadBuffers', () => {
    it('merges an all-qlog buffer array into a single page waterfall', async () => {
        const buffers = AIOQUIC_FILES.map(readSample);
        const wt = new WaterfallTools();
        try {
            const progressCalls = [];
            await wt.loadBuffers(buffers, {
                debug: true,
                onProgress: (phase, percent) => progressCalls.push([phase, percent])
            });

            expect(wt._sourceFormat).toBe('qlog');
            const har = wt.getHar();
            expect(har.log.pages.length).toBe(1);
            expect(har.log.entries.length).toBe(39);

            // Entries from all five connections merged onto the one page.
            const hosts = new Set(har.log.entries.map(e => new URL(e.request.url).hostname));
            expect(hosts.size).toBe(5);
            const pageId = har.log.pages[0].id;
            expect(har.log.entries.every(e => e.pageref === pageId)).toBe(true);

            // Progress reporting flows through to the parser.
            expect(progressCalls.length).toBeGreaterThan(0);
            expect(progressCalls[progressCalls.length - 1][1]).toBe(100);
        } finally {
            await wt.destroy();
        }
    });

    it('single-member array delegates to loadBuffer (raw buffer retained)', async () => {
        const buf = readSample(AIOQUIC_FILES[0]);
        const wt = new WaterfallTools();
        try {
            await wt.loadBuffers([buf], { debug: true });
            expect(wt._sourceFormat).toBe('qlog');
            // loadBuffer() re-attaches the backing buffer; the multi-merge path clears it.
            expect(wt._rawBuffer).toBeInstanceOf(ArrayBuffer);
            const har = wt.getHar();
            expect(har.log.pages.length).toBe(1);
            expect(har.log.entries.length).toBeGreaterThan(0);
        } finally {
            await wt.destroy();
        }
    });

    it('exposes a single qlog raw-buffer resource without creating an object URL', async () => {
        const buf = readSample(AIOQUIC_FILES[0]);
        const wt = new WaterfallTools();
        try {
            await wt.loadBuffer(buf, { debug: true, bufferNames: ['www.google.com.qlog.gz'] });
            const pageId = wt.getHar().log.pages[0].id;
            const resource = await wt.getPageResource(pageId, 'qlog');

            expect(resource).toBeTruthy();
            expect(resource.url).toBeUndefined();
            expect(resource.files).toHaveLength(1);
            expect(resource.files[0].name).toBe('www.google.com.qlog.gz');
            expect(resource.files[0].mimeType).toBe('application/qlog');
            expect(resource.files[0].buffer).toBe(wt._rawBuffer);
            expect(new Uint8Array(resource.files[0].buffer)).toEqual(buf);
        } finally {
            await wt.destroy();
        }
    });

    it('exposes multi-qlog raw-buffer resources with names and exact view slicing', async () => {
        const originals = AIOQUIC_FILES.slice(0, 2).map(readSample);
        const buffers = originals.map((bytes, index) => paddedView(bytes, 5 + index, 13 + index));
        const names = ['www.google.com.qlog.gz', 'fonts.gstatic.com.qlog.gz'];
        const wt = new WaterfallTools();
        try {
            await wt.loadBuffers(buffers, { debug: true, bufferNames: names });

            expect(wt._rawBuffer).toBeNull();
            expect(wt._rawBuffers).toHaveLength(2);
            const pageId = wt.getHar().log.pages[0].id;
            const resource = await wt.getPageResource(pageId, 'qlog');

            expect(resource).toBeTruthy();
            expect(resource.url).toBeUndefined();
            expect(resource.files).toHaveLength(2);
            for (let i = 0; i < resource.files.length; i++) {
                expect(resource.files[i].name).toBe(names[i]);
                expect(resource.files[i].mimeType).toBe('application/qlog');
                expect(resource.files[i].buffer).toBe(wt._rawBuffers[i].buffer);
                expect(resource.files[i].buffer.byteLength).toBe(originals[i].byteLength);
                expect(new Uint8Array(resource.files[i].buffer)).toEqual(originals[i]);
            }
        } finally {
            await wt.destroy();
        }
    });

    it('clears retained multi-qlog raw buffers on reload and destroy', async () => {
        const buffers = AIOQUIC_FILES.slice(0, 2).map(readSample);
        const wt = new WaterfallTools();
        try {
            await wt.loadBuffers(buffers, { debug: true, bufferNames: ['first.qlog.gz', 'second.qlog.gz'] });
            expect(wt._rawBuffers).toHaveLength(2);

            await wt.loadBuffer(syntheticHarBuffer(), { debug: true });
            expect(wt._sourceFormat).toBe('har');
            expect(wt._rawBuffers).toBeNull();

            await wt.loadBuffers(buffers, { debug: true, bufferNames: ['first.qlog.gz', 'second.qlog.gz'] });
            expect(wt._rawBuffers).toHaveLength(2);

            await wt.destroy();
            expect(wt._rawBuffer).toBeNull();
            expect(wt._rawBuffers).toBeNull();
        } finally {
            await wt.destroy();
        }
    });

    it('loadBuffer retains only the supplied typed-array view bytes', async () => {
        const harBytes = syntheticHarBuffer();
        const backing = new Uint8Array(harBytes.byteLength + 20);
        backing.fill(0x7b);
        backing.set(harBytes, 10);
        const view = backing.subarray(10, 10 + harBytes.byteLength);
        const wt = new WaterfallTools();
        try {
            await wt.loadBuffer(view, { debug: true });
            expect(wt._rawBuffer.byteLength).toBe(harBytes.byteLength);
            expect(new Uint8Array(wt._rawBuffer)).toEqual(harBytes);
        } finally {
            await wt.destroy();
        }
    });

    it('rejects mixed-format arrays with a clear error naming the detected formats', async () => {
        const wt = new WaterfallTools();
        try {
            await expect(
                wt.loadBuffers([readSample(AIOQUIC_FILES[0]), syntheticHarBuffer()], { debug: true })
            ).rejects.toThrow(/all buffers to share one format.*qlog, har/s);
        } finally {
            await wt.destroy();
        }
    });

    it('rejects multi-buffer arrays of a format with no merge support', async () => {
        const wt = new WaterfallTools();
        try {
            await expect(
                wt.loadBuffers([syntheticHarBuffer(), syntheticHarBuffer()], { debug: true })
            ).rejects.toThrow(/'har' does not support multi-buffer merging/);
        } finally {
            await wt.destroy();
        }
    });

    it('rejects empty and non-array input', async () => {
        const wt = new WaterfallTools();
        try {
            await expect(wt.loadBuffers([], { debug: true })).rejects.toThrow(/non-empty array/);
            await expect(wt.loadBuffers(null, { debug: true })).rejects.toThrow(/non-empty array/);
        } finally {
            await wt.destroy();
        }
    });
});
