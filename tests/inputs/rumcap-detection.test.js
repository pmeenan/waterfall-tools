// Format-detection tests for rumcap (.rcap) captures — Phase 10a.
// A .rcap file starts with the 4-byte cleartext magic F5 52 55 4D (0xF5 then
// ASCII "RUM"); the internal payload is gzip-compressed AFTER that header, so
// a plain .rcap does NOT start with 1f 8b. A user may additionally gzip the
// whole file (.rcap.gz), in which case the sniffers' gzip pre-pass must
// expose the inner magic. Both paths are exercised here, for both the
// orchestrator sniff and the Cloudflare Worker's inlined mirror of it.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import { identifyFormatFromBuffer } from '../../src/inputs/orchestrator.js';
import { identifyFormatFromBuffer as workerIdentifyFormat } from '../../cloudflare-worker/worker.js';

const SAMPLE_DIR = path.resolve('Sample/Data/rumcap/chrome');
const PLAIN_SAMPLE = path.join(SAMPLE_DIR, 'chrome-www-google-com.rcap');
const CPU6X_SAMPLE = path.join(SAMPLE_DIR, 'chrome-www-google-com-cpu6x.rcap');
const DEGRADED_SAMPLE = path.join(SAMPLE_DIR, 'chrome-degraded.rcap');

function largeIncompressibleRumcapLikeGzip() {
    const payload = new Uint8Array(200000);
    payload[0] = 0xf5;
    payload[1] = 0x52;
    payload[2] = 0x55;
    payload[3] = 0x4d;
    let state = 0x12345678;
    for (let i = 4; i < payload.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        payload[i] = state & 0xff;
    }
    return zlib.gzipSync(payload);
}

describe('rumcap format detection (orchestrator)', () => {
    it('identifies a plain .rcap sample as rumcap', async () => {
        const buf = fs.readFileSync(PLAIN_SAMPLE);
        const detected = await identifyFormatFromBuffer(buf, { debug: true });
        expect(detected.format).toBe('rumcap');
        expect(detected.isGz).toBe(false);
    });

    it('identifies a user-gzipped .rcap.gz as rumcap', async () => {
        // Gzip the sample in-test rather than committing a .gz sample — the
        // outer gzip layer only exists on user-compressed files.
        const gz = zlib.gzipSync(fs.readFileSync(PLAIN_SAMPLE));
        const detected = await identifyFormatFromBuffer(gz, { debug: true });
        expect(detected.format).toBe('rumcap');
        expect(detected.isGz).toBe(true);
    });

    it('identifies large incompressible user-gzipped .rcap.gz prefixes as rumcap', async () => {
        const detected = await identifyFormatFromBuffer(largeIncompressibleRumcapLikeGzip(), { debug: true });
        expect(detected.format).toBe('rumcap');
        expect(detected.isGz).toBe(true);
    });

    it('detects a TRUNCATED 64KB prefix of a large incompressible .rcap.gz (viewer drag-drop path)', async () => {
        // The viewer sniffs file.slice(0, 65536) before loading, so the gzip
        // pre-pass sees a truncated compressed stream whose decode errors before a
        // clean end. The decoder must KEEP the partial output (which starts with the
        // F5 52 55 4D magic) instead of discarding it and returning the raw gzip
        // bytes — otherwise every incompressible .rcap.gz over ~64KB reads 'unknown'.
        // largeIncompressibleRumcapLikeGzip() gzips a 200KB random payload, so its
        // output comfortably exceeds the 65536-byte slice.
        const prefix = largeIncompressibleRumcapLikeGzip().subarray(0, 65536);
        const detected = await identifyFormatFromBuffer(prefix, { debug: true });
        expect(detected.format).toBe('rumcap');
    });

    it('identifies the degraded-manifest sample as rumcap', async () => {
        const buf = fs.readFileSync(DEGRADED_SAMPLE);
        const detected = await identifyFormatFromBuffer(buf, { debug: true });
        expect(detected.format).toBe('rumcap');
    });

    it('identifies a cpu6x sample as rumcap', async () => {
        const buf = fs.readFileSync(CPU6X_SAMPLE);
        const detected = await identifyFormatFromBuffer(buf, { debug: true });
        expect(detected.format).toBe('rumcap');
    });
});

describe('rumcap format detection (Cloudflare Worker sniff parity)', () => {
    // The Worker's identifyFormatFromBuffer is a deliberately self-contained
    // mirror of the orchestrator's — these assertions lock the two in step.
    it('identifies a plain .rcap sample as rumcap', async () => {
        const buf = new Uint8Array(fs.readFileSync(PLAIN_SAMPLE));
        expect(await workerIdentifyFormat(buf)).toBe('rumcap');
    });

    it('identifies a user-gzipped .rcap.gz as rumcap', async () => {
        // The Worker gunzips the sniff prefix (gunzipPrefix) before running
        // the magic checks, so the outer-gzip path must resolve too.
        const gz = new Uint8Array(zlib.gzipSync(fs.readFileSync(PLAIN_SAMPLE)));
        expect(await workerIdentifyFormat(gz)).toBe('rumcap');
    });

    it('identifies large incompressible user-gzipped .rcap.gz prefixes as rumcap', async () => {
        expect(await workerIdentifyFormat(new Uint8Array(largeIncompressibleRumcapLikeGzip()))).toBe('rumcap');
    });

    it('detects a TRUNCATED 64KB prefix of a large incompressible .rcap.gz (Worker buffers only 64KB compressed)', async () => {
        // In production the Worker buffers only the first SNIFF_SIZE compressed
        // upstream bytes, so gunzipPrefix always decodes a truncated stream for a
        // large incompressible .rcap.gz. It must keep the partial decoded prefix
        // rather than returning the raw gzip bytes (which would 415 the request).
        const prefix = new Uint8Array(largeIncompressibleRumcapLikeGzip().subarray(0, 65536));
        expect(await workerIdentifyFormat(prefix)).toBe('rumcap');
    });

    it('identifies the degraded-manifest sample as rumcap', async () => {
        const buf = new Uint8Array(fs.readFileSync(DEGRADED_SAMPLE));
        expect(await workerIdentifyFormat(buf)).toBe('rumcap');
    });

    it('identifies a cpu6x sample as rumcap', async () => {
        const buf = new Uint8Array(fs.readFileSync(CPU6X_SAMPLE));
        expect(await workerIdentifyFormat(buf)).toBe('rumcap');
    });
});
