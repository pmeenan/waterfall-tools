/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSimpleJSON } from '../../src/outputs/simple-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Simple JSON Output Processor', () => {
    it('Should transform an Extended HAR object into simple flat objects', () => {
        const fixturePath = path.resolve(__dirname, '../fixtures/chrome-google.har.json');
        const rawData = fs.readFileSync(fixturePath, 'utf8');
        const harData = JSON.parse(rawData);

        const result = generateSimpleJSON(harData);

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(harData.log.entries.length);

        // Check the first entry explicitly
        const first = result[0];
        expect(first.index).toBe(0);
        expect(first.url.length).toBeGreaterThan(0);
        expect(first.method).toBeTruthy();
        expect(first.status).toBe(harData.log.entries[0].response.status);
    });

    it('Should handle empty or invalid HAR safely', () => {
        expect(generateSimpleJSON(null)).toEqual([]);
        expect(generateSimpleJSON({})).toEqual([]);
        expect(generateSimpleJSON({ log: {} })).toEqual([]);
    });

    it('Should map Extended properties if present natively', () => {
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
        expect(result.length).toBe(1);

        const first = result[0];
        expect(first.url).toBe("http://example.com/test");
        expect(first.method).toBe("POST");
        expect(first.status).toBe(204);
        expect(first.bytesIn).toBe(1500);
        expect(first.bytesOut).toBe(500);
        expect(first.dns_ms).toBe(10);
        expect(first.ttfb_ms).toBe(50);
        expect(first.load_ms).toBe(100);
        expect(first.ip).toBe("1.2.3.4");
    });
});
