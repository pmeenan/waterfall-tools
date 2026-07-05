// Format-detection tests for qlog (IETF QUIC/HTTP-3 structured logging) — Phase 2.
// qlog has two serializations:
//   - JSON-SEQ (.sqlog, RFC 7464): first byte is the 0x1E record separator,
//     each record is 0x1E + JSON + LF (curl/ngtcp2 output).
//   - Plain JSON (.qlog): top-level object with "qlog_version" and "traces"
//     (aioquic output).
// The `"qlog_version"` token is unambiguous across all supported formats; the
// 0x1E leading byte is additionally required to carry that token within the
// sniff window (a lone 0x1E could be any RFC 7464 stream). Both serializations
// are exercised plain and gzipped, for both the orchestrator sniff and the
// Cloudflare Worker's inlined mirror of it (same parity pattern as
// rumcap-detection.test.js).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import { identifyFormatFromBuffer } from '../../src/inputs/orchestrator.js';
import { identifyFormatFromBuffer as workerIdentifyFormat } from '../../cloudflare-worker/worker.js';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

const SAMPLE_DIR = path.resolve('Sample/Data/qlog');
const QLOG_GZ_SAMPLE = path.join(SAMPLE_DIR, 'aioquic', 'www.google.com.qlog.gz');
const SQLOG_GZ_SAMPLE = path.join(SAMPLE_DIR, 'curl', 'cloudflare-quic.com-parallel.sqlog.gz');

describe('qlog format detection (orchestrator)', () => {
    it('identifies plain .qlog bytes (aioquic JSON) as qlog', async () => {
        const buf = zlib.gunzipSync(fs.readFileSync(QLOG_GZ_SAMPLE));
        const detected = await identifyFormatFromBuffer(buf, { debug: true });
        expect(detected.format).toBe('qlog');
        expect(detected.isGz).toBe(false);
    });

    it('identifies a gzipped .qlog.gz as qlog', async () => {
        const detected = await identifyFormatFromBuffer(fs.readFileSync(QLOG_GZ_SAMPLE), { debug: true });
        expect(detected.format).toBe('qlog');
        expect(detected.isGz).toBe(true);
    });

    it('identifies plain .sqlog bytes (curl JSON-SEQ) as qlog', async () => {
        const buf = zlib.gunzipSync(fs.readFileSync(SQLOG_GZ_SAMPLE));
        // Sanity: JSON-SEQ files must lead with the RFC 7464 record separator.
        expect(buf[0]).toBe(0x1e);
        const detected = await identifyFormatFromBuffer(buf, { debug: true });
        expect(detected.format).toBe('qlog');
        expect(detected.isGz).toBe(false);
    });

    it('identifies a gzipped .sqlog.gz as qlog', async () => {
        const detected = await identifyFormatFromBuffer(fs.readFileSync(SQLOG_GZ_SAMPLE), { debug: true });
        expect(detected.format).toBe('qlog');
        expect(detected.isGz).toBe(true);
    });

    it('does not misidentify qlog-derived Extended HAR as qlog', async () => {
        const har = {
            log: {
                version: '1.2',
                creator: { name: 'waterfall-tools', version: 'test' },
                pages: [{
                    id: 'page_1',
                    startedDateTime: new Date(0).toISOString(),
                    title: 'qlog export',
                    pageTimings: {},
                    _qlogTraces: [{ qlogVersion: 'urn:ietf:params:qlog:file:sequential' }]
                }],
                entries: []
            }
        };
        const buf = new TextEncoder().encode(JSON.stringify(har));
        expect((await identifyFormatFromBuffer(buf, { debug: true })).format).toBe('har');
        expect(await workerIdentifyFormat(buf)).toBe('har');
    });
});

describe('qlog format detection (spec-final quiche: no qlog_version token)', () => {
    // quiche emits spec-final qlog whose header has NO qlog_version — it
    // self-identifies via urn:ietf:params:qlog file/event-schema URNs. Detection
    // must accept either token.
    const QUICHE_GZ = path.join(SAMPLE_DIR, 'quiche', 'quiche-localhost-server.sqlog.gz');

    it('identifies plain quiche .sqlog bytes as qlog (orchestrator)', async () => {
        const buf = zlib.gunzipSync(fs.readFileSync(QUICHE_GZ));
        expect(buf.includes(Buffer.from('"qlog_version"'))).toBe(false); // the point of this suite
        const detected = await identifyFormatFromBuffer(buf, { debug: true });
        expect(detected.format).toBe('qlog');
    });

    it('identifies a gzipped quiche .sqlog.gz as qlog (orchestrator)', async () => {
        const detected = await identifyFormatFromBuffer(fs.readFileSync(QUICHE_GZ), { debug: true });
        expect(detected.format).toBe('qlog');
        expect(detected.isGz).toBe(true);
    });

    it('identifies quiche .sqlog bytes as qlog (Worker parity)', async () => {
        expect(await workerIdentifyFormat(new Uint8Array(zlib.gunzipSync(fs.readFileSync(QUICHE_GZ))))).toBe('qlog');
        expect(await workerIdentifyFormat(new Uint8Array(fs.readFileSync(QUICHE_GZ)))).toBe('qlog');
    });
});

describe('qlog format detection (Cloudflare Worker sniff parity)', () => {
    // The Worker's identifyFormatFromBuffer is a deliberately self-contained
    // mirror of the orchestrator's — these assertions lock the two in step.
    it('identifies plain .qlog bytes as qlog', async () => {
        const buf = new Uint8Array(zlib.gunzipSync(fs.readFileSync(QLOG_GZ_SAMPLE)));
        expect(await workerIdentifyFormat(buf)).toBe('qlog');
    });

    it('identifies a gzipped .qlog.gz as qlog', async () => {
        const buf = new Uint8Array(fs.readFileSync(QLOG_GZ_SAMPLE));
        expect(await workerIdentifyFormat(buf)).toBe('qlog');
    });

    it('identifies plain .sqlog bytes as qlog', async () => {
        const buf = new Uint8Array(zlib.gunzipSync(fs.readFileSync(SQLOG_GZ_SAMPLE)));
        expect(await workerIdentifyFormat(buf)).toBe('qlog');
    });

    it('identifies a gzipped .sqlog.gz as qlog', async () => {
        const buf = new Uint8Array(fs.readFileSync(SQLOG_GZ_SAMPLE));
        expect(await workerIdentifyFormat(buf)).toBe('qlog');
    });
});

describe('qlog end-to-end via WaterfallTools auto-detect', () => {
    it('loadFile routes a .qlog.gz through the orchestrator to the qlog parser', async () => {
        const tool = new WaterfallTools();
        try {
            await tool.loadFile(QLOG_GZ_SAMPLE, { debug: true });
            const har = tool.getHar();
            expect(har.log.creator.name).toContain('waterfall-tools');
            expect(har.log.entries.length).toBe(29);
        } finally {
            await tool.destroy();
        }
    });

    it('loadBuffer routes gzipped .sqlog bytes (raw, parser does its own gunzip) end-to-end', async () => {
        const tool = new WaterfallTools();
        try {
            await tool.loadBuffer(fs.readFileSync(SQLOG_GZ_SAMPLE), { debug: true });
            const har = tool.getHar();
            expect(har.log.entries.length).toBe(4);
        } finally {
            await tool.destroy();
        }
    });
});
