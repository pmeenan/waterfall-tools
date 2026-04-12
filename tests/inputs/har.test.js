/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getRawJSON(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    }
    return JSON.parse(buf.toString('utf8'));
}

describe('HAR Input Processor', () => {

    it('Should correctly parse and normalize a Gzipped WebPageTest HAR', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/WebPageTest/amazon.har.gz');
        const refPath = path.resolve(__dirname, '../fixtures/amazon.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'har' });
        const result = JSON.parse(JSON.stringify(tool.getHar({ debug: true })));

        if (!fs.existsSync(refPath)) {
            console.log(`Generating golden fixture for amazon.har.json...`);
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        expect(result).toEqual(ref);
        expect(result.log.version).toBe("1.2");
        expect(result.log.creator.name).toBe("waterfall-tools");

        const rawHar = getRawJSON(inputPath);
        expect(result.log.entries.length).toBe(rawHar.log.entries?.length || 0);
        expect(result.log.pages.length).toBe(rawHar.log.pages?.length || 0);
    });

    it('Should correctly parse and normalize a plain Text Chrome HAR', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/Chrome/www.google.com.har');
        const refPath = path.resolve(__dirname, '../fixtures/chrome-google.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'har' });
        const result = JSON.parse(JSON.stringify(tool.getHar({ debug: true })));

        if (!fs.existsSync(refPath)) {
            console.log(`Generating golden fixture for chrome-google.har.json...`);
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        expect(result).toEqual(ref);
        expect(result.log.creator.name).toBe("waterfall-tools");

        const rawHar = getRawJSON(inputPath);
        expect(result.log.entries.length).toBe(rawHar.log.entries?.length || 0);
        expect(result.log.pages.length).toBe(rawHar.log.pages?.length || 0);
    });

    it('Should correctly parse and normalize a plain Text Firefox HAR', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/Firefox/www.google.com_Archive [26-03-27 17-36-46].har');
        const refPath = path.resolve(__dirname, '../fixtures/firefox-google.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'har' });
        const result = JSON.parse(JSON.stringify(tool.getHar({ debug: true })));

        if (!fs.existsSync(refPath)) {
            console.log(`Generating golden fixture for firefox-google.har.json...`);
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        expect(result).toEqual(ref);
        expect(result.log.creator.name).toBe("waterfall-tools");

        const rawHar = getRawJSON(inputPath);
        // Firefox HAR may contain data: URLs which are filtered out by the library
        const nonDataEntries = rawHar.log.entries.filter(e => !e.request.url.startsWith('data:'));
        expect(result.log.entries.length).toBe(nonDataEntries.length);
        expect(result.log.pages.length).toBe(rawHar.log.pages?.length || 0);
    });

    it('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/DOES_NOT_EXIST.har');
        await expect(async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(inputPath, { debug: true, format: 'har' });
        }).rejects.toThrow();
    });
});
