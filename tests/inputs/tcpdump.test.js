import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processTcpdumpNode } from '../../src/inputs/tcpdump.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGENERATE_FIXTURES = process.env.REGENERATE_FIXTURES === 'true';

test('Tcpdump Processor Generates Valid HAR', async (t) => {
    const inputPath = path.join(__dirname, '../../Sample/Data/tcpdump/www.google.com-tcpdump.cap.gz');
    const fixturePath = path.join(__dirname, '../fixtures/tcpdump-google-har.json');

    // Run processor natively loading keylogs dynamically configured per naming rules internally
    const har = await processTcpdumpNode(inputPath);

    // Dynamic assertions verifying parser integrity
    assert.strictEqual(har.log.version, "1.2");
    assert.ok(har.log.pages.length === 1, "Should generate exactly 1 Page entry");
    assert.ok(har.log.entries.length >= 1, "Should contain some entries");
    
    // Validate custom extensions
    assert.ok(har.log.entries[0]._protocol === 'TCP' || har.log.entries[0]._protocol === 'QUIC');

    // Scrub dynamic keys before comparison (Dates shifting rapidly across epochs unaligned visually)
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
    });

    const scrubbedHarStr = JSON.parse(JSON.stringify(har));

    // Regenerate mode
    if (REGENERATE_FIXTURES) {
        fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
        fs.writeFileSync(fixturePath, JSON.stringify(scrubbedHarStr, null, 2), 'utf-8');
        console.log('✅ Regenerated TCP Dump HAR Fixture');
        return;
    }

    if (fs.existsSync(fixturePath)) {
        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
        assert.deepStrictEqual(scrubbedHarStr, fixture);
    } else {
        console.warn(`Snapshot not found. Run with REGENERATE_FIXTURES=true to create ${fixturePath}`);
        // Pass cleanly locally enabling remote build actions failing explicit diffs 
    }
});
