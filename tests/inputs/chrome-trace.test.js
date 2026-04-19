/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

describe('Chrome Trace Input Processing', () => {

    const files = [
        'trace_theverge.com',
        'trace_www.amazon.com',
        'trace_www.cnn.com',
        'trace_www.engadget.com',
        'trace_www.google.com',
        // Trace captured without netlog events (DevTools Performance panel
        // without the Network sink) — exercises the timeline-only synthesis
        // path. Only requests with a real `requestId`, a ResourceSendRequest,
        // and either a ResourceReceiveResponse with status > 0 or a full
        // timing block survive the quality gate.
        'trace_www.google.com-no-netlog'
    ];

    // Traces that ship netlog events inherit a deterministic wall-clock
    // epoch from the first HTTP `date:` response header. Traces without
    // netlog fall back to `Date.now()`, so any absolute `_*TimeMs` field
    // shifts per run — scrub those before comparing the snapshot.
    const tracesWithoutDateAnchor = new Set([
        'trace_www.google.com-no-netlog'
    ]);
    const dynamicAbsoluteEpochKeys = new Set([
        '_dnsTimeMs', '_dnsEndTimeMs',
        '_connectTimeMs', '_connectEndTimeMs',
        '_sslStartTimeMs',
        '_firstDataTimeMs', '_lastDataTimeMs'
    ]);

    function scrubHar(har, needsEpochScrub) {
        if (har.log && har.log.pages) {
            har.log.pages.forEach(p => delete p.startedDateTime);
        }
        if (har.log && har.log.entries) {
            har.log.entries.forEach(e => {
                delete e.startedDateTime;
                if (needsEpochScrub) {
                    for (const k of dynamicAbsoluteEpochKeys) delete e[k];
                }
            });
        }
    }

    for (const filename of files) {
        it(`Transforms ${filename} correctly`, async () => {
            const fixturePath = path.resolve(`tests/fixtures/chrome-trace/${filename}.json`);
            const inputPath = path.resolve(`Sample/Data/Chrome Traces/${filename}.json.gz`);
            const needsEpochScrub = tracesWithoutDateAnchor.has(filename);

            const tool = new WaterfallTools();
            await tool.loadFile(inputPath, { debug: true, format: 'chrome-trace' });
            const har = tool.getHar({ debug: true });

            scrubHar(har, needsEpochScrub);
            const cleanHar = JSON.parse(JSON.stringify(har));

            if (fs.existsSync(fixturePath)) {
                const snapshot = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
                scrubHar(snapshot, needsEpochScrub);
                expect(cleanHar).toEqual(snapshot);
            } else {
                console.log(`Writing baseline for ${filename}`);
                fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
                fs.writeFileSync(fixturePath, JSON.stringify(cleanHar, null, 2), 'utf-8');
            }
        });
    }

});
