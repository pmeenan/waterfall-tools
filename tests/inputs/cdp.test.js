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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CDP generates absolute timestamps based on Date.now() which shift between runs.
// Scrub all dynamic absolute timestamp fields before fixture comparison.
const DYNAMIC_ENTRY_KEYS = [
    'startedDateTime', '_dnsTimeMs', '_dnsEndTimeMs',
    '_connectTimeMs', '_connectEndTimeMs', '_sslStartTimeMs',
    '_firstDataTimeMs', '_lastDataTimeMs'
];

function scrubDynamic(har) {
    if (har.log && har.log.pages) {
        har.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
    }
    if (har.log && har.log.entries) {
        har.log.entries.forEach(e => {
            for (const key of DYNAMIC_ENTRY_KEYS) {
                if (e[key] !== undefined) e[key] = "SCRUBBED";
            }
        });
    }
}

describe('Chrome DevTools Protocol (CDP) Input Processor', () => {

    it('Should effectively parse and normalize a small CDP JSON trace', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Chrome Devtools Protocol/www.google.com-devtools.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/cdp-google.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'cdp' });
        const result = tool.getHar({ debug: true });

        // Auto-generate golden reference file if absent
        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for cdp-google.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const normalizedResult = JSON.parse(JSON.stringify(result));
        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        scrubDynamic(normalizedResult);
        scrubDynamic(ref);

        expect(normalizedResult).toEqual(ref);
        expect(result.log.version).toBe("1.2");
        expect(result.log.creator.name).toBe("waterfall-tools");

        expect(result.log.pages.length).toBeGreaterThan(0);
        expect(result.log.entries.length).toBeGreaterThan(0);
    });

    it('Should safely process massive CDP JSON traces (CNN) streaming effectively', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Chrome Devtools Protocol/www.cnn.com-devtools.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/cdp-cnn.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'cdp' });
        const result = tool.getHar({ debug: true });

        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for cdp-cnn.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const normalizedResult = JSON.parse(JSON.stringify(result));
        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        scrubDynamic(normalizedResult);
        scrubDynamic(ref);

        expect(normalizedResult).toEqual(ref);
        expect(result.log.creator.name).toBe("waterfall-tools");
    });

    it('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Chrome Devtools Protocol/DOES_NOT_EXIST.json');
        await expect(async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(inputPath, { debug: true, format: 'cdp' });
        }).rejects.toThrow();
    });
});
