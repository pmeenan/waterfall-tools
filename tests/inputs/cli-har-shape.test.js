/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';
import { relationalToHar } from '../../src/core/har-export.js';
import { VERSION } from '../../src/core/version.js';
import { processHARFileNode } from '../../src/inputs/har.js';
import { processCDPFileNode } from '../../src/inputs/cdp.js';
import { processNetlogFileNode } from '../../src/inputs/netlog.js';
import { processChromeTraceFileNode } from '../../src/inputs/chrome-trace.js';
import { processWPTFileNode } from '../../src/inputs/wpt-json.js';
import { processRumcapNode } from '../../src/inputs/rumcap.js';
import { processQlogNode } from '../../src/inputs/qlog.js';
import { processTcpdumpNode } from '../../src/inputs/tcpdump.js';
import { decompressBody, decompressBodyPerChunk } from '../../src/core/decompress.js';
import { sniffMimeType } from '../../src/core/har-converter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(__dirname, '../../Sample/Data');

/**
 * Shape lock for the standalone per-format CLI wrappers (`src/inputs/cli/*.js`): every
 * wrapper runs `processXNode(input, options)` and serializes `relationalToHar(data)`,
 * so parsing the same sample here and asserting on `relationalToHar(data)` locks the
 * exact object each wrapper writes to disk.
 *
 * Perfetto is intentionally not covered: the only sample
 * (`Sample/Data/Chrome Traces/001-trace.perfetto.gz`, 23 MB gzipped) is far too heavy
 * for the fast suite. Its CLI wrapper shares the exact same
 * `processXNode → relationalToHar` pipeline asserted below.
 */
function assertHarShape(har) {
    // Top-level shape: exactly { log } — the internal relational root must not leak.
    expect(Object.keys(har)).toEqual(['log']);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toContain('waterfall-tools');
    expect(har.log.creator.version).toBe(VERSION);
    expect(har.log.pages.length).toBeGreaterThanOrEqual(1);
    expect(har.log.entries.length).toBeGreaterThan(0);
    // Relational-object internals must not appear anywhere in the log either.
    for (const internalKey of ['metadata', 'tcp_connections', 'dns']) {
        expect(har[internalKey]).toBeUndefined();
        expect(har.log[internalKey]).toBeUndefined();
    }
}

describe('CLI wrapper HAR shape (relationalToHar over each parser output)', () => {

    it('har', async () => {
        const data = await processHARFileNode(path.join(SAMPLE_DIR, 'HARs/Chrome/www.google.com.har'), { debug: true });
        assertHarShape(relationalToHar(data));
    });

    it('cdp', async () => {
        const data = await processCDPFileNode(path.join(SAMPLE_DIR, 'Chrome Devtools Protocol/www.google.com-devtools.json.gz'), { debug: true });
        assertHarShape(relationalToHar(data));
    });

    it('netlog', async () => {
        const data = await processNetlogFileNode(path.join(SAMPLE_DIR, 'Netlog/www.google.com-netlog.json.gz'), { debug: true });
        assertHarShape(relationalToHar(data));
    });

    it('chrome-trace', async () => {
        const data = await processChromeTraceFileNode(path.join(SAMPLE_DIR, 'Chrome Traces/trace_www.google.com.json.gz'), { debug: true });
        assertHarShape(relationalToHar(data));
    });

    it('wpt', async () => {
        const data = await processWPTFileNode(path.join(SAMPLE_DIR, 'WebPageTest JSON/www.google.com-wpt.json.gz'), { debug: true });
        assertHarShape(relationalToHar(data));
    });

    it('rumcap', async () => {
        const data = await processRumcapNode(path.join(SAMPLE_DIR, 'rumcap/chrome/chrome-www-google-com.rcap'), { debug: true });
        assertHarShape(relationalToHar(data));
    });

    it('qlog', async () => {
        const data = await processQlogNode(path.join(SAMPLE_DIR, 'qlog/aioquic/www.google.com.qlog.gz'), { debug: true });
        assertHarShape(relationalToHar(data));
    });

    it('tcpdump', async () => {
        // Wire options.deps exactly the way src/inputs/cli/tcpdump.js does.
        const options = {
            debug: true,
            keyLogPath: path.join(SAMPLE_DIR, 'tcpdump/www.google.com-tcpdump.key_log.txt.gz'),
            deps: { decompressBody, decompressBodyPerChunk, sniffMimeType }
        };
        const data = await processTcpdumpNode(path.join(SAMPLE_DIR, 'tcpdump/www.google.com-tcpdump.cap.gz'), options);
        assertHarShape(relationalToHar(data));
    });

    it('getHar() delegates faithfully to relationalToHar()', async () => {
        const tool = new WaterfallTools();
        await tool.loadFile(path.join(SAMPLE_DIR, 'HARs/Chrome/www.google.com.har'), { debug: true });
        // Sanitize both sides so undefined-vs-missing mismatches can't hang the runner.
        const viaMethod = JSON.parse(JSON.stringify(tool.getHar()));
        const viaFunction = JSON.parse(JSON.stringify(relationalToHar(tool.data)));
        expect(viaMethod).toEqual(viaFunction);
    });
});
