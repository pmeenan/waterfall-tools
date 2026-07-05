/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processQlogNode, buildQlogHarLog } from '../../src/inputs/qlog.js';
import { relationalToHar } from '../../src/core/har-export.js';
import {
    isJsonSeq,
    normalizeEventName,
    parseReferenceTime,
    resolveClock,
    createTimeConverter,
    parseJsonSeqTraces,
    decodeQlogTraces
} from '../../src/inputs/utilities/qlog/decoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_DIR = path.resolve(__dirname, '../../Sample/Data/qlog');
const REGENERATE_FIXTURES = process.env.REGENERATE_FIXTURES === 'true';

const AIOQUIC_FILES = [
    'aioquic/www.google.com.qlog.gz',
    'aioquic/fonts.gstatic.com.qlog.gz',
    'aioquic/ogads-pa.clients6.google.com.qlog.gz',
    'aioquic/play.google.com.qlog.gz',
    'aioquic/www.gstatic.com.qlog.gz'
];

function samplePath(rel) {
    return path.join(SAMPLE_DIR, rel);
}

function checkGoldenFixture(result, fixtureName) {
    const refPath = path.resolve(__dirname, `../fixtures/${fixtureName}`);
    if (!fs.existsSync(refPath) || REGENERATE_FIXTURES) {
        console.log(`Generating golden fixture for ${fixtureName}...`);
        fs.mkdirSync(path.dirname(refPath), { recursive: true });
        fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        if (REGENERATE_FIXTURES) return;
    }
    // Sanitize via JSON round-trip so undefined-vs-missing mismatches can't hang the runner.
    const normalizedResult = JSON.parse(JSON.stringify(result));
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
    expect(normalizedResult).toEqual(ref);
}

/**
 * Unanchored qlog captures (curl's `reference_time: 0`) get a synthesized Date.now() page
 * epoch, so every absolute-epoch field is dynamic run-to-run. Rewrite them as offsets from
 * the page epoch (the relative values ARE deterministic) so the fixture compare is stable.
 */
function normalizeSynthesizedEpochs(har) {
    const clone = JSON.parse(JSON.stringify(har));
    const epochMs = new Date(clone.log.pages[0].startedDateTime).getTime();
    const rel = (v) => Math.round((v - epochMs) * 1000) / 1000;
    for (const page of clone.log.pages) page.startedDateTime = '<synthesized>';
    for (const entry of clone.log.entries) {
        entry.startedDateTime = rel(new Date(entry.startedDateTime).getTime());
        if (Array.isArray(entry._chunks)) {
            for (const c of entry._chunks) c.ts = rel(c.ts);
        }
        for (const key of ['_connectTimeMs', '_connectEndTimeMs', '_sslStartTimeMs', '_dnsTimeMs', '_dnsEndTimeMs']) {
            if (typeof entry[key] === 'number') entry[key] = rel(entry[key]);
        }
    }
    return clone;
}

describe('qlog decoder utilities', () => {

    it('normalizes both event-name generations to the canonical namespace set', () => {
        // draft-0.3 names (everything in the wild) → current IETF names
        expect(normalizeEventName('transport:packet_sent')).toBe('quic:packet_sent');
        expect(normalizeEventName('transport:packet_received')).toBe('quic:packet_received');
        expect(normalizeEventName('http:frame_created')).toBe('http3:frame_created');
        expect(normalizeEventName('http:stream_type_set')).toBe('http3:stream_type_set');
        // current names pass through unchanged
        expect(normalizeEventName('quic:packet_sent')).toBe('quic:packet_sent');
        expect(normalizeEventName('http3:frame_parsed')).toBe('http3:frame_parsed');
        // untouched namespaces
        expect(normalizeEventName('recovery:metrics_updated')).toBe('recovery:metrics_updated');
        expect(normalizeEventName('connectivity:connection_state_updated')).toBe('connectivity:connection_state_updated');
        // historical dot separator tolerance
        expect(normalizeEventName('transport.packet_sent')).toBe('quic:packet_sent');
        expect(normalizeEventName('http.frame_parsed')).toBe('http3:frame_parsed');
        // no separator → unchanged
        expect(normalizeEventName('packet_sent')).toBe('packet_sent');
    });

    it('parses number / string / object reference_time forms liberally', () => {
        expect(parseReferenceTime(1700000000000)).toBe(1700000000000);
        expect(parseReferenceTime(0)).toBeNull(); // 0 means unanchored, NOT epoch-0
        expect(parseReferenceTime(undefined)).toBeNull();
        expect(parseReferenceTime('1700000000000')).toBe(1700000000000);
        expect(parseReferenceTime({ clock_type: 'system', wall_clock_time: '2026-01-02T03:04:05.000Z' }))
            .toBe(Date.parse('2026-01-02T03:04:05.000Z'));
        expect(parseReferenceTime({ clock_type: 'monotonic', epoch: 'unknown' })).toBeNull();
        expect(parseReferenceTime({ clock_type: 'system', epoch: '2026-01-02T03:04:05.000Z' }))
            .toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    });

    it('resolves the clock: truthy reference_time anchors relative times', () => {
        const clock = resolveClock({ time_format: 'relative', reference_time: 1700000000000 }, 5);
        expect(clock.anchored).toBe(true);
        expect(clock.anchorEpochMs).toBe(1700000000000);
        const toRel = createTimeConverter(clock, 5);
        expect(toRel(5)).toBe(5);
        expect(toRel(123.5)).toBe(123.5);
    });

    it('resolves the clock: absolute-epoch heuristic for undeclared epoch-ms times', () => {
        // aioquic: common_fields carry only the ODCID; times are epoch ms floats
        const first = 1783211253465.573;
        const clock = resolveClock({ ODCID: '0871f2e9444efcee' }, first);
        expect(clock.timeFormat).toBe('absolute');
        expect(clock.anchored).toBe(true);
        expect(clock.anchorEpochMs).toBe(first);
        const toRel = createTimeConverter(clock, first);
        expect(toRel(first)).toBe(0);
        expect(toRel(first + 36.5)).toBeCloseTo(36.5, 3);
    });

    it('resolves the clock: reference_time 0 with small relative times stays unanchored', () => {
        // curl/ngtcp2: relative ms with no wall-clock anchor at all — must NEVER become 1970
        const clock = resolveClock({ time_format: 'relative', reference_time: 0 }, 0);
        expect(clock.anchored).toBe(false);
        expect(clock.anchorEpochMs).toBeNull();
        expect(createTimeConverter(clock, 0)(17)).toBe(17);
    });

    it('resolves the clock: a declared-absolute trace with sub-epoch times degrades to unanchored', () => {
        const clock = resolveClock({ time_format: 'absolute' }, 12.5);
        expect(clock.anchored).toBe(false);
        // ...but times still rebase off the first event so nothing lands at 1970.
        const toRel = createTimeConverter(clock, 12.5);
        expect(toRel(12.5)).toBe(0);
        expect(toRel(20)).toBe(7.5);
    });

    it('cumulative-sums delta time format', () => {
        const clock = resolveClock({ time_format: 'delta', reference_time: 1700000000000 }, 5);
        expect(clock.timeFormat).toBe('delta');
        expect(clock.anchored).toBe(true);
        const toRel = createTimeConverter(clock, 5);
        expect(toRel(5)).toBe(5);
        expect(toRel(3)).toBe(8);
        expect(toRel(2.5)).toBe(10.5);
    });

    it('detects JSON-SEQ by the RFC 7464 record separator, not extension', () => {
        expect(isJsonSeq(new Uint8Array([0x1e, 0x7b]))).toBe(true);
        expect(isJsonSeq(new TextEncoder().encode('{"qlog_format":"JSON"}'))).toBe(false);
        expect(isJsonSeq(new Uint8Array([]))).toBe(false);
    });

    it('splits JSON-SEQ on 0x1E and survives a truncated trailing record', () => {
        const header = JSON.stringify({
            qlog_format: 'JSON-SEQ', qlog_version: '0.3',
            trace: { vantage_point: { name: 'test', type: 'client' }, common_fields: { group_id: 'abcd1234' } }
        });
        const ev1 = JSON.stringify({ time: 1, name: 'transport:packet_sent', data: {} });
        const ev2 = JSON.stringify({ time: 2, name: 'transport:packet_received', data: {} });
        const text = `\x1e${header}\n\x1e${ev1}\n\x1e${ev2}\n\x1e{"time":3,"na`; // truncated tail
        const traces = parseJsonSeqTraces(new TextEncoder().encode(text));
        expect(traces.length).toBe(1);
        expect(traces[0].commonFields.group_id).toBe('abcd1234');
        expect(traces[0].vantagePoint.type).toBe('client');
        expect(traces[0].events.length).toBe(2);
    });

    it('stream-parses plain-JSON traces and skips event-less TraceError objects', async () => {
        const doc = JSON.stringify({
            qlog_format: 'JSON', qlog_version: '0.3',
            traces: [
                { common_fields: { ODCID: 'feed' }, events: [{ time: 1, name: 'transport:packet_sent', data: {} }] },
                { error_description: 'boom' }
            ]
        });
        const traces = await decodeQlogTraces(new TextEncoder().encode(doc));
        expect(traces.length).toBe(1);
        expect(traces[0].qlogVersion).toBe('0.3');
        expect(traces[0].commonFields.ODCID).toBe('feed');
        expect(traces[0].events.length).toBe(1);
    });
});

describe('qlog Input Processor (rich mode: aioquic plain JSON)', () => {

    it('parses www.google.com against the golden fixture', async () => {
        const data = await processQlogNode(samplePath('aioquic/www.google.com.qlog.gz'), { debug: true });
        const har = relationalToHar(data);
        checkGoldenFixture(har, 'qlog-google.har.json');
        if (REGENERATE_FIXTURES) return;

        const log = har.log;
        expect(log.pages.length).toBe(1);
        expect(log.entries.length).toBe(29);

        // Anchored clock: real capture date, no synthesized epoch, definitely no 1970.
        expect(log.pages[0]._clockSynthesized).toBeUndefined();
        for (const entry of log.entries) {
            expect(new Date(entry.startedDateTime).getFullYear()).toBeGreaterThan(2000);
        }

        // Rich mode: every entry has a real decoded status and a www.google.com URL.
        for (const entry of log.entries) {
            expect([200, 204]).toContain(entry.response.status);
            expect(entry._statusAssumed).toBeUndefined();
            expect(new URL(entry.request.url).hostname).toBe('www.google.com');
            expect(entry._protocol).toBe('HTTP/3');
            expect(entry.request.httpVersion).toBe('HTTP/3');
            // qlog carries no DNS events — the fields must be absent, never fabricated.
            expect(entry._dns_start).toBeUndefined();
            expect(entry._dns_end).toBeUndefined();
        }
        expect(log.entries.filter(e => e.response.status === 200).length).toBe(19);
        expect(log.entries.filter(e => e.response.status === 204).length).toBe(10);

        // The base page is the earliest rich request.
        const base = log.entries.find(e => e._is_base_page);
        expect(base).toBeDefined();
        expect(base.request.url).toBe('https://www.google.com/');
        expect(base.request.url).toBe(log.pages[0].title);
        expect(base.response.content.mimeType).toContain('text/html');

        // Connection-owner convention: exactly one entry carries the handshake, and the
        // QUIC handshake is TLS-integral (connect span == ssl span).
        const owners = log.entries.filter(e => e._connect_start !== undefined);
        expect(owners.length).toBe(1);
        expect(owners[0]._ssl_start).toBe(owners[0]._connect_start);
        expect(owners[0]._ssl_end).toBe(owners[0]._connect_end);
        expect(owners[0]._connect_end).toBeGreaterThan(owners[0]._connect_start);
        // The request rides the fresh connection — it can't have started before it was usable.
        expect(owners[0]._load_start).toBeGreaterThanOrEqual(owners[0]._connect_end);

        // The two big /xjs/ fetches starting ~180ms overlap in time (HTTP/3 multiplexing).
        const xjs = log.entries.filter(e => e.request.url.includes('/xjs/')).sort((a, b) => a._load_start - b._load_start);
        expect(xjs.length).toBeGreaterThanOrEqual(2);
        expect(xjs[0]._load_start).toBeGreaterThan(150);
        expect(xjs[0]._load_start).toBeLessThan(220);
        expect(xjs[1]._load_start).toBeLessThan(xjs[0]._download_end); // overlapping streams

        // Large responses carry multi-chunk byte progressions with absolute-ms timestamps.
        const large = log.entries.filter(e => e._bytesIn > 100000);
        expect(large.length).toBeGreaterThan(0);
        for (const entry of large) {
            expect(entry._chunks.length).toBeGreaterThan(1);
            const entryEpoch = new Date(entry.startedDateTime).getTime();
            for (const chunk of entry._chunks) {
                expect(chunk.bytes).toBeGreaterThan(0);
                expect(chunk.ts).toBeGreaterThanOrEqual(entryEpoch - 1);
            }
            // Chunk bytes reconcile exactly with the rx STREAM frame total.
            expect(entry._chunks.reduce((sum, c) => sum + c.bytes, 0)).toBe(entry._bytesIn);
        }

        // Page-level context
        expect(log.pages[0]._bwDown).toBeGreaterThan(0);
        expect(log.pages[0]._qlogTraces.length).toBe(1);
        expect(log.pages[0]._qlogTraces[0].odcid).toBe('0871f2e9444efcee');
        expect(log.pages[0]._qlogTraces[0].anchored).toBe(true);
        expect(log.pages[0]._qlogMetrics.rtt.length).toBeGreaterThan(0);
        expect(log.pages[0]._qlogMetrics.cwnd.length).toBeGreaterThan(0);
        expect(log.pages[0]._qlogMetrics.rtt.length).toBeLessThanOrEqual(301);
        expect(log.pages[0]._qlogMetrics.cwnd.length).toBeLessThanOrEqual(301);
    });

    it('maps RFC 9218 priority, bytes, and timing derivations coherently', async () => {
        const data = await processQlogNode(samplePath('aioquic/www.google.com.qlog.gz'));
        const har = relationalToHar(data);
        for (const entry of har.log.entries) {
            // Phase ordering must be monotone wherever both endpoints exist.
            expect(entry._load_start).toBeGreaterThanOrEqual(entry._created);
            if (entry._ttfb_end !== undefined) {
                expect(entry._ttfb_end).toBeGreaterThanOrEqual(entry._ttfb_start);
                expect(entry._ttfb_ms).toBeCloseTo(entry._ttfb_end - entry._load_start, 3);
            }
            if (entry._download_end !== undefined && entry._ttfb_end !== undefined) {
                expect(entry._download_end).toBeGreaterThanOrEqual(entry._ttfb_end);
            }
            expect(entry._all_end).toBeGreaterThanOrEqual(entry._all_start);
            expect(entry._bytesIn).toBeGreaterThan(0);
            expect(entry._bytesOut).toBeGreaterThan(0);
            // No NaN/Infinity may ever reach the renderer's path-poisoning-sensitive canvas.
            for (const key of ['_created', '_all_start', '_all_end', '_load_start', '_ttfb_start', '_ttfb_end', '_download_start', '_download_end']) {
                if (entry[key] !== undefined) expect(isFinite(entry[key])).toBe(true);
            }
        }
    });
});

describe('qlog Input Processor (degraded mode: curl/ngtcp2 JSON-SEQ)', () => {

    it('parses cloudflare-quic.com-parallel against the golden fixture', async () => {
        const data = await processQlogNode(samplePath('curl/cloudflare-quic.com-parallel.sqlog.gz'), { debug: true });
        const har = relationalToHar(data);
        // Unanchored capture → synthesized page epoch: rewrite absolute fields as offsets
        // (deterministic) before fixture comparison, per the house scrubbing rules.
        const normalized = normalizeSynthesizedEpochs(har);
        checkGoldenFixture(normalized, 'qlog-curl-parallel.har.json');
        if (REGENERATE_FIXTURES) return;

        const log = har.log;
        expect(log.entries.length).toBe(4);
        expect(log.pages[0]._clockSynthesized).toBe(true);
        // Synthesized epoch is "now-ish", never 1970.
        const pageEpoch = new Date(log.pages[0].startedDateTime).getTime();
        expect(Math.abs(Date.now() - pageEpoch)).toBeLessThan(60 * 1000);

        // ngtcp2 emits no http-namespace events: synthetic connection-URL naming, assumed
        // statuses, but real byte counts and stream timings from the transport frames.
        const streamIds = [];
        for (const entry of log.entries) {
            expect(entry._statusAssumed).toBe(true);
            expect(entry.response.status).toBe(200);
            expect(entry.request.url).toMatch(/^https:\/\/connection-048246e7\/stream-\d+$/);
            expect(entry._bytesIn).toBeGreaterThan(0);
            expect(entry._bytesOut).toBeGreaterThan(0);
            expect(entry._chunks.length).toBeGreaterThan(0);
            expect(entry._download_end).toBeGreaterThan(entry._load_start);
            streamIds.push(entry._stream_id);
        }
        // Client-initiated bidirectional streams only (0 mod 4) — control/QPACK uni
        // streams must never surface as requests.
        expect(streamIds.sort((a, b) => a - b)).toEqual([0, 4, 8, 12]);

        // The handshake lands on the connection's first request only.
        const owners = log.entries.filter(e => e._connect_start !== undefined);
        expect(owners.length).toBe(1);
        expect(owners[0]._stream_id).toBe(0);
        expect(owners[0]._connect_start).toBe(0);
        expect(owners[0]._connect_end).toBeGreaterThan(0);

        expect(log.pages[0]._bwDown).toBeGreaterThan(0);
        expect(log.pages[0]._qlogTraces[0].anchored).toBe(false);
        expect(log.pages[0]._qlogTraces[0].format).toBe('JSON-SEQ');
    });
});

describe('qlog Input Processor (spec-final quiche, both vantage points)', () => {
    // Generated by running quiche's example client against quiche's example server
    // locally with QLOGDIR set on both sides — the same exchange observed from both
    // ends. quiche emits SPEC-FINAL qlog: no qlog_version (self-identifies via
    // urn:ietf:params:qlog file/event-schema URNs), current quic:/http3: namespaces,
    // object-form reference_time (wall_clock_time anchor), RawInfo frame lengths, and
    // quic:recovery_metrics_updated.
    const CLIENT = 'quiche/quiche-localhost-client.sqlog.gz';
    const SERVER = 'quiche/quiche-localhost-server.sqlog.gz';
    const URLS = ['/index.html', '/style.css', '/app.js', '/image.svg', '/data.bin'];

    it('parses the client vantage against the golden fixture', async () => {
        const data = await processQlogNode(samplePath(CLIENT), { debug: true });
        const har = relationalToHar(data);
        checkGoldenFixture(har, 'qlog-quiche-client.har.json');
        if (REGENERATE_FIXTURES) return;

        const log = har.log;
        expect(log.entries.length).toBe(5);
        // Anchored via the object-form reference_time's wall_clock_time — real capture
        // date, no synthesized epoch.
        expect(log.pages[0]._clockSynthesized).toBeUndefined();
        expect(log.pages[0]._qlogTraces[0].anchored).toBe(true);
        expect(log.pages[0]._qlogTraces[0].vantagePoint.type).toBe('client');
        // Spec-final files carry no qlog_version — the file-schema URN identifies them.
        expect(log.pages[0]._qlogTraces[0].qlogVersion).toBe('urn:ietf:params:qlog:file:sequential');
        // quic:recovery_metrics_updated (renamed from recovery:metrics_updated) feeds
        // the metrics series.
        expect(log.pages[0]._qlogMetrics.rtt.length).toBeGreaterThan(0);

        const paths = log.entries.map(e => new URL(e.request.url).pathname).sort();
        expect(paths).toEqual([...URLS].sort());
        for (const entry of log.entries) {
            expect(entry.response.status).toBe(200);
            expect(entry._statusAssumed).toBeUndefined();
            // RawInfo frame lengths (raw.payload_length) must produce real byte counts.
            expect(entry._bytesIn).toBeGreaterThan(0);
            expect(entry._bytesOut).toBeGreaterThan(0);
            expect(entry._chunks.length).toBeGreaterThan(0);
        }
        const appJs = log.entries.find(e => e.request.url.endsWith('/app.js'));
        expect(appJs._bytesIn).toBeGreaterThan(400000);
    });

    it('parses the server vantage of the same exchange with matching wire truth', async () => {
        const clientHar = relationalToHar(await processQlogNode(samplePath(CLIENT)));
        const serverHar = relationalToHar(await processQlogNode(samplePath(SERVER), { debug: true }));
        checkGoldenFixture(serverHar, 'qlog-quiche-server.har.json');
        if (REGENERATE_FIXTURES) return;

        const log = serverHar.log;
        expect(log.entries.length).toBe(5);
        expect(log.pages[0]._qlogTraces[0].vantagePoint.type).toBe('server');
        expect(log.pages[0]._qlogTraces[0].anchored).toBe(true);

        // The server observes the same requests: identical URLs, methods, statuses —
        // and identical stream payload bytes (the wire truth seen from both ends).
        for (const serverEntry of log.entries) {
            const clientEntry = clientHar.log.entries.find(e => e.request.url === serverEntry.request.url);
            expect(clientEntry).toBeDefined();
            expect(serverEntry.request.method).toBe(clientEntry.request.method);
            expect(serverEntry.response.status).toBe(clientEntry.response.status);
            expect(serverEntry._bytesIn).toBe(clientEntry._bytesIn);
            expect(serverEntry._bytesOut).toBe(clientEntry._bytesOut);
        }
    });
});

describe('qlog multi-input merge', () => {

    it('merges all five aioquic connections into one epoch-aligned page', async () => {
        const data = await processQlogNode(AIOQUIC_FILES.map(samplePath), { debug: true });
        const har = relationalToHar(data);
        const log = har.log;

        expect(log.pages.length).toBe(1);
        expect(log.entries.length).toBe(39);
        // All five traces are absolute-epoch anchored — nothing synthesized.
        expect(log.pages[0]._clockSynthesized).toBeUndefined();
        expect(log.pages[0]._qlogTraces.length).toBe(5);
        expect(log.pages[0]._qlogTraces.every(t => t.anchored)).toBe(true);

        // Page zero is the earliest connection's start (www.google.com).
        expect(log.pages[0].startedDateTime).toBe('2026-07-05T00:27:33.468Z');

        // One connection id per trace, and one handshake owner per connection.
        const connections = new Set(log.entries.map(e => e.connection));
        expect(connections.size).toBe(5);
        expect(log.entries.filter(e => e._connect_start !== undefined).length).toBe(5);

        // Cross-connection alignment by wall clock: the fonts.gstatic.com connection was
        // opened ~340-400ms after page zero.
        const fonts = log.entries.filter(e => new URL(e.request.url).hostname === 'fonts.gstatic.com');
        expect(fonts.length).toBe(3);
        const firstFonts = Math.min(...fonts.map(e => e._created));
        expect(firstFonts).toBeGreaterThan(300);
        expect(firstFonts).toBeLessThan(450);

        // Base page comes from the earliest rich request across the whole set.
        const base = log.entries.find(e => e._is_base_page);
        expect(base.request.url).toBe('https://www.google.com/');
    });

    it('accepts raw buffers and Node Readables as array members', async () => {
        const gz = new Uint8Array(fs.readFileSync(samplePath('aioquic/play.google.com.qlog.gz')));
        const readable = fs.createReadStream(samplePath('aioquic/ogads-pa.clients6.google.com.qlog.gz'));
        const data = await processQlogNode([gz, readable]);
        const log = relationalToHar(data).log;
        expect(log.entries.length).toBe(4);
        expect(new Set(log.entries.map(e => e.connection)).size).toBe(2);
    });
});

describe('qlog buildQlogHarLog (CLI Extended HAR contract)', () => {

    it('emits a true Extended HAR log from decoded traces', async () => {
        const gz = new Uint8Array(fs.readFileSync(samplePath('aioquic/www.google.com.qlog.gz')));
        const inflated = await new Response(
            new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))
        ).arrayBuffer();
        const traces = await decodeQlogTraces(new Uint8Array(inflated));
        const log = await buildQlogHarLog(traces);

        expect(log.version).toBe('1.2');
        expect(log.creator.name).toContain('waterfall-tools');
        expect(log.pages.length).toBe(1);
        expect(log.entries.length).toBe(29);
        expect(log.entries.every(e => e.pageref === 'page_1')).toBe(true);
        // Internal relational keys must never leak into the HAR shape.
        expect(log.metadata).toBeUndefined();
    });

    it('does not exclude streams a spec-current producer types as "request"', async () => {
        // The current h3-events draft's H3StreamType includes "request" for the request
        // streams themselves — stream_type_set must only exclude NON-request roles.
        const traces = [{
            qlogFormat: 'JSON', qlogVersion: '0.4', vantagePoint: { type: 'client' },
            commonFields: { reference_time: 1700000000000 },
            events: [
                { time: 0, name: 'quic:packet_sent', data: { header: { packet_type: 'initial' }, frames: [] } },
                { time: 5, name: 'http3:stream_type_set', data: { stream_id: 0, stream_type: 'request' } },
                { time: 5, name: 'http3:stream_type_set', data: { stream_id: 2, stream_type: 'control' } },
                { time: 6, name: 'http3:frame_created', data: { stream_id: 0, frame: { frame_type: 'headers', headers: [
                    { name: ':method', value: 'GET' }, { name: ':scheme', value: 'https' },
                    { name: ':authority', value: 'example.com' }, { name: ':path', value: '/' }
                ] } } },
                { time: 20, name: 'http3:frame_parsed', data: { stream_id: 0, frame: { frame_type: 'headers', headers: [
                    { name: ':status', value: '200' }
                ] } } },
                { time: 21, name: 'quic:packet_received', data: { header: { packet_type: '1RTT' }, frames: [
                    { frame_type: 'stream', stream_id: 0, offset: 0, length: 500, fin: true }
                ] } }
            ]
        }];
        const log = await buildQlogHarLog(traces);
        expect(log.entries.length).toBe(1);
        expect(log.entries[0].request.url).toBe('https://example.com/');
        expect(log.entries[0].response.status).toBe(200);
    });

    it('rejects invalid file paths safely', async () => {
        await expect(processQlogNode(samplePath('DOES_NOT_EXIST.qlog'))).rejects.toThrow();
    });

    it('rejects inputs with no qlog traces', async () => {
        await expect(processQlogNode(new TextEncoder().encode('{"not":"qlog"}'))).rejects.toThrow(/No qlog traces/);
    });
});
