/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
// Chrome reuses a netlog source's id2.local pointer for a later request once the earlier one has
// finished. The next request's lifecycle can open with CORS_REQUEST, which already carries its URL,
// before REQUEST_ALIVE. The trace-to-netlog bridge (src/inputs/netlog.js#addTraceEvent) must treat
// that CORS_REQUEST begin as a lifecycle boundary too; otherwise the new URL is written onto the
// finished request (which then shows the wrong URL with the earlier request's data) and the earlier
// request comes back a second time through timeline synthesis.
//
// Sample: a capture of a four-request test page by capture.waterfall-tools.com (Chrome 157,
// browser-level trace with netlog; machine details removed from its metadata). In it the document
// and its stylesheet share id2.local 0x9d. Before the fix it converted to five entries with the
// stylesheet listed twice and the document only as a synthesized timeline request.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

describe('Chrome trace: a reused netlog source id', () => {
    it('keeps each request its own URL when a lifecycle opens with CORS_REQUEST', async () => {
        const tool = new WaterfallTools();
        try {
            await tool.loadFile(path.resolve('Sample/Data/Chrome Traces/capture-reused-request-id.json.gz'), { format: 'chrome-trace' });
            const entries = tool.getHar().log.entries;
            const paths = entries.map((e) => new URL(e.request.url).pathname).sort();
            expect(paths).toEqual(['/pixel.png', '/simple', '/simple.css', '/simple.js']);

            const doc = entries.find((e) => new URL(e.request.url).pathname === '/simple');
            // From netlog, not synthesized from the timeline.
            expect(String(doc._netlog_id)).toMatch(/^trace_/);
            const css = entries.find((e) => new URL(e.request.url).pathname === '/simple.css');
            // The stylesheet's own size, not the document's.
            expect(css._bytes_in).toBeLessThan(doc._bytes_in);
        } finally {
            await tool.destroy?.();
        }
    });
});
