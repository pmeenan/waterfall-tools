import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processWPTFileNode } from '../../src/inputs/wpt-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('WebPageTest JSON Input Processor', async (t) => {
    
    await t.test('Should effectively parse and normalize a small WPT JSON trace', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/www.google.com-wpt.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/wpt-google.har.json');
        
        const result = await processWPTFileNode(inputPath, { debug: true });
        
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

        assert.deepStrictEqual(scrubbedResult, ref, 'Parsed WPT JSON does not match reference output');
        assert.strictEqual(result.log.version, "1.2");
        assert.strictEqual(result.log.creator.name, "waterfall-tools");
        
        // Verify we dropped bloated keys
        assert.ok(result.log.pages.length > 0, "Should generate at least one page");
        const page = result.log.pages[0];
        assert.strictEqual(page._almanac, undefined, "Large tracking key _almanac should be pruned from parsed output");
        assert.strictEqual(page['_generated-html'], undefined, "Large tracking key generated-html should be pruned from parsed output");
    });

    await t.test('Should safely process massive WPT JSON traces (CNN) without hitting V8 Memory bounds', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/www.cnn.com-wpt.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/wpt-cnn.har.json');
        
        // This execution naturally exercises the custom PRUNING Token Filter. 
        // If it was just Assembler, Node would likely OutOfMemory / choke on a 13MB gzipped string buffer organically.
        const result = await processWPTFileNode(inputPath, { debug: true });
        
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

        assert.deepStrictEqual(scrubbedResult, ref, 'Parsed CNN WPT JSON does not match reference output');
        assert.strictEqual(result.log.creator.name, "waterfall-tools");
        
        const page = result.log.pages[0];
        assert.strictEqual(page._almanac, undefined, "Large tracking key _almanac should be pruned from parsed output");
    });

    await t.test('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/WebPageTest JSON/DOES_NOT_EXIST.json');
        await assert.rejects(
            async () => await processWPTFileNode(inputPath, { debug: true }),
            { code: 'ENOENT' },
            'Should reject with ENOENT when file is missing'
        );
    });
});
