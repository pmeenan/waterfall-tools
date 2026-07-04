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

    it('identifies the degraded-manifest sample as rumcap', async () => {
        const buf = new Uint8Array(fs.readFileSync(DEGRADED_SAMPLE));
        expect(await workerIdentifyFormat(buf)).toBe('rumcap');
    });

    it('identifies a cpu6x sample as rumcap', async () => {
        const buf = new Uint8Array(fs.readFileSync(CPU6X_SAMPLE));
        expect(await workerIdentifyFormat(buf)).toBe('rumcap');
    });
});
