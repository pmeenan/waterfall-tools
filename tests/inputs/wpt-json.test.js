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
import { formatWptUtilization } from '../../src/inputs/wpt-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('WebPageTest JSON Input Processor', () => {

    it('Should effectively parse and normalize a small WPT JSON trace', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/www.google.com-wpt.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/wpt-google.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wpt' });
        const result = tool.getHar({ debug: true });

        if (process.env.UPDATE_FIXTURES) {
            console.log("Updating golden fixture for wpt-google.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }
        expect(fs.existsSync(refPath), `Missing golden fixture: ${refPath}`).toBe(true);

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        const scrubbedResult = JSON.parse(JSON.stringify(result));
        scrubbedResult.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        ref.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        scrubbedResult.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");
        ref.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");

        expect(scrubbedResult).toEqual(ref);
        expect(result.log.version).toBe("1.2");
        expect(result.log.creator.name).toBe("waterfall-tools");

        expect(result.log.pages.length).toBeGreaterThan(0);
    });

    it('Should safely process massive WPT JSON traces (CNN) without hitting V8 Memory bounds', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/www.cnn.com-wpt.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/wpt-cnn.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wpt' });
        const result = tool.getHar({ debug: true });

        if (process.env.UPDATE_FIXTURES) {
            console.log("Updating golden fixture for wpt-cnn.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }
        expect(fs.existsSync(refPath), `Missing golden fixture: ${refPath}`).toBe(true);

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        const scrubbedResult = JSON.parse(JSON.stringify(result));
        scrubbedResult.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        ref.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        scrubbedResult.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");
        ref.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");

        expect(scrubbedResult).toEqual(ref);
        expect(result.log.creator.name).toBe("waterfall-tools");
    }, 15_000);

    it('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/DOES_NOT_EXIST.json');
        await expect(async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(inputPath, { debug: true, format: 'wpt' });
        }).rejects.toThrow();
    });

    it('Should bound bandwidth redistribution for pathological val/limit ratios and non-finite samples', () => {
        const rawUtil = {
            bw: {
                data: {
                    0: 1e15,
                    100: 'NaN',
                    200: 500000
                },
                max: 1e15,
                count: 3
            }
        };
        const t0 = performance.now();
        const formatted = formatWptUtilization(rawUtil, 1); // limit = 1000 bps -> 1e12x ratio
        const elapsedMs = performance.now() - t0;

        expect(elapsedMs).toBeLessThan(100);
        expect(Array.isArray(formatted.bw)).toBe(true);
        // 3 original points + at most 100 prepended points
        expect(formatted.bw.length).toBeLessThanOrEqual(103);
        for (const [ts, pct] of formatted.bw) {
            expect(Number.isFinite(ts)).toBe(true);
            expect(Number.isFinite(pct)).toBe(true);
            expect(pct).toBeGreaterThanOrEqual(0);
            expect(pct).toBeLessThanOrEqual(100);
        }
    });
});
