import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('WebPageTest JSON Input Processor', () => {

    it('Should effectively parse and normalize a small WPT JSON trace', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/www.google.com-wpt.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/wpt-google.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wpt' });
        let result = tool.getHar({ debug: true });

        // Auto-generate golden reference file if absent
        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for wpt-google.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        const scrubbedResult = JSON.parse(JSON.stringify(result));
        scrubbedResult.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        ref.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        scrubbedResult.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");
        ref.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");

        expect(scrubbedResult).toEqual(ref);
        expect(result.log.version).toBe("1.2");
        expect(result.log.creator.name).toBe("waterfall-tools");

        // Verify we dropped bloated keys
        expect(result.log.pages.length).toBeGreaterThan(0);
        const page = result.log.pages[0];
        expect(page._almanac).toBeUndefined();
        expect(page['_generated-html']).toBeUndefined();
    });

    it('Should safely process massive WPT JSON traces (CNN) without hitting V8 Memory bounds', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/www.cnn.com-wpt.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/wpt-cnn.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wpt' });
        let result = tool.getHar({ debug: true });

        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for wpt-cnn.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        const scrubbedResult = JSON.parse(JSON.stringify(result));
        scrubbedResult.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        ref.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        scrubbedResult.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");
        ref.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");

        expect(scrubbedResult).toEqual(ref);
        expect(result.log.creator.name).toBe("waterfall-tools");

        const page = result.log.pages[0];
        expect(page._almanac).toBeUndefined();
    });

    it('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/DOES_NOT_EXIST.json');
        await expect(async () => {
            const tool = new WaterfallTools();
            await tool.loadFile(inputPath, { debug: true, format: 'wpt' });
        }).rejects.toThrow();
    });
});
