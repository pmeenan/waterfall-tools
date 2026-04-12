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

describe('Netlog JSON Input Processor', () => {

    it('Should effectively parse and normalize a small Netlog trace (Google)', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Netlog/www.google.com-netlog.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/netlog-google.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'netlog' });
        let result = tool.getHar({ debug: true });

        // Auto-generate golden reference file if absent
        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for netlog-google.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        result = JSON.parse(JSON.stringify(result)); // sanitize for comparison

        expect(result).toEqual(ref);
        expect(result.log.version).toBe("1.2");
        expect(result.log.creator.name).toBe("waterfall-tools");

        expect(result.log.pages.length).toBeGreaterThan(0);
        const page = result.log.pages[0];

        // Check unlinked properties were added successfully
        expect(Array.isArray(page._unlinked_connections)).toBe(true);
        expect(Array.isArray(page._unlinked_dns_lookups)).toBe(true);
    });

    it('Should effectively parse complex multiple domain Netlog traces (Amazon)', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Netlog/amazon1_netlog.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/netlog-amazon1.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'netlog' });
        let result = tool.getHar({ debug: true });

        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for netlog-amazon1.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        result = JSON.parse(JSON.stringify(result)); // sanitize for comparison

        expect(result).toEqual(ref);
        expect(result.log.creator.name).toBe("waterfall-tools");

        const entries = result.log.entries;
        expect(entries.length).toBeGreaterThan(0);
    });

    it('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Netlog/DOES_NOT_EXIST.json.gz');
        await expect(async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(inputPath, { debug: true, format: 'netlog' });
        }).rejects.toThrow();
    });

});
