import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { processChromeTraceFileNode } from '../../src/inputs/chrome-trace.js';

test('Chrome Trace Input Processing', async (t) => {

    const files = [
        'trace_theverge.com',
        'trace_www.amazon.com',
        'trace_www.cnn.com',
        'trace_www.engadget.com',
        'trace_www.google.com'
    ];

    for (const filename of files) {
        await t.test(`Transforms ${filename} correctly`, async () => {
            const fixturePath = path.resolve(`tests/fixtures/chrome-trace/${filename}.json`);
            const inputPath = path.resolve(`Sample/Data/Chrome Traces/${filename}.json.gz`);

            const har = await processChromeTraceFileNode(inputPath, { debug: true });
            
            // Scrub dynamic Dates
            if (har.log && har.log.pages) {
                har.log.pages.forEach(p => delete p.startedDateTime);
            }
            if (har.log && har.log.entries) {
                har.log.entries.forEach(e => delete e.startedDateTime);
            }

            const cleanHar = JSON.parse(JSON.stringify(har));
            
            if (fs.existsSync(fixturePath)) {
                const snapshot = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
                if (snapshot.log && snapshot.log.pages) {
                    snapshot.log.pages.forEach(p => delete p.startedDateTime);
                }
                if (snapshot.log && snapshot.log.entries) {
                    snapshot.log.entries.forEach(e => delete e.startedDateTime);
                }
                assert.deepStrictEqual(cleanHar, snapshot);
            } else {
                console.log(`Writing baseline for ${filename}`);
                fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
                fs.writeFileSync(fixturePath, JSON.stringify(cleanHar, null, 2), 'utf-8');
            }
        });
    }

});
