import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSimpleJSON } from '../../src/outputs/simple-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Simple JSON Output Processor', async (t) => {
    await t.test('Should transform an Extended HAR object into simple flat objects', () => {
        const fixturePath = path.resolve(__dirname, '../fixtures/chrome-google.har.json');
        const rawData = fs.readFileSync(fixturePath, 'utf8');
        const harData = JSON.parse(rawData);

        const result = generateSimpleJSON(harData);

        assert.ok(Array.isArray(result), 'Result should be an array');
        assert.strictEqual(result.length, harData.log.entries.length, 'Should map exactly 1:1 to entries');

        // Check the first entry explicitly
        const first = result[0];
        assert.strictEqual(first.index, 0);
        assert.ok(first.url.length > 0, 'URL should be populated');
        assert.ok(first.method, 'Method should be found');
        assert.strictEqual(first.status, harData.log.entries[0].response.status);
    });

    await t.test('Should handle empty or invalid HAR safely', () => {
        assert.deepStrictEqual(generateSimpleJSON(null), [], 'Should handle null');
        assert.deepStrictEqual(generateSimpleJSON({}), [], 'Should handle empty object');
        assert.deepStrictEqual(generateSimpleJSON({ log: {} }), [], 'Should handle missing entries array');
    });

    await t.test('Should map Extended properties if present natively', () => {
        const fakeHar = {
            log: {
                entries: [
                    {
                        "request": { "url": "http://example.com/test", "method": "POST" },
                        "response": { "status": 204 },
                        "_url": "http://example.com/test",
                        "_method": "POST",
                        "_responseCode": 204,
                        "_bytesIn": 1500,
                        "_bytesOut": 500,
                        "_dns_ms": 10,
                        "_ttfb_ms": 50,
                        "_load_ms": 100,
                        "_ip_addr": "1.2.3.4"
                    }
                ]
            }
        };

        const result = generateSimpleJSON(fakeHar);
        assert.strictEqual(result.length, 1);
        
        const first = result[0];
        assert.strictEqual(first.url, "http://example.com/test");
        assert.strictEqual(first.method, "POST");
        assert.strictEqual(first.status, 204);
        assert.strictEqual(first.bytesIn, 1500);
        assert.strictEqual(first.bytesOut, 500);
        assert.strictEqual(first.dns_ms, 10);
        assert.strictEqual(first.ttfb_ms, 50);
        assert.strictEqual(first.load_ms, 100);
        assert.strictEqual(first.ip, "1.2.3.4");
    });
});
