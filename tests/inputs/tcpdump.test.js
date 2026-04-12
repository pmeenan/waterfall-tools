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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGENERATE_FIXTURES = process.env.REGENERATE_FIXTURES === 'true';

describe('Tcpdump Processor', () => {

    it('Generates Valid HAR', async () => {
        const inputPath = path.join(__dirname, '../../Sample/Data/tcpdump/www.google.com-tcpdump.cap.gz');
        const fixturePath = path.join(__dirname, '../fixtures/tcpdump-google-har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'tcpdump' });
        const har = tool.getHar({ debug: true });

        // Dynamic assertions verifying parser integrity
        expect(har.log.version).toBe("1.2");
        expect(har.log.pages.length).toBe(1);
        expect(har.log.entries.length).toBeGreaterThanOrEqual(1);

        // Validate custom extensions
        expect(['TCP', 'QUIC']).toContain(har.log.entries[0]._protocol);

        // Verify that response bodies are extracted for at least some entries
        const entriesWithBody = har.log.entries.filter(
            e => e.response && e.response.content && e.response.content.text
        );
        expect(entriesWithBody.length).toBeGreaterThan(0);

        // Scrub dynamic keys before comparison
        har.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        har.log.entries.forEach(e => {
            e.startedDateTime = "SCRUBBED";
            e.time = 0;
            e.timings = {
                dns: -1,
                connect: -1,
                ssl: -1,
                send: 0,
                wait: 0,
                receive: 0
            };
            // Strip large body content to keep fixture manageable
            if (e.response && e.response.content) {
                delete e.response.content.text;
                delete e.response.content.encoding;
            }
        });

        const scrubbedHarStr = JSON.parse(JSON.stringify(har));

        // Regenerate mode
        if (REGENERATE_FIXTURES) {
            fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
            fs.writeFileSync(fixturePath, JSON.stringify(scrubbedHarStr, null, 2), 'utf-8');
            console.log('Regenerated TCP Dump HAR Fixture');
            return;
        }

        if (fs.existsSync(fixturePath)) {
            const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
            expect(scrubbedHarStr).toEqual(fixture);
        } else {
            console.warn(`Snapshot not found. Run with REGENERATE_FIXTURES=true to create ${fixturePath}`);
        }
    });
});
