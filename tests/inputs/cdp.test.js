import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCDPFileNode } from '../../src/inputs/cdp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Chrome DevTools Protocol (CDP) Input Processor', async (t) => {
    
    await t.test('Should effectively parse and normalize a small CDP JSON trace', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Chrome Devtools Protocol/www.google.com-devtools.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/cdp-google.har.json');
        
        const result = await processCDPFileNode(inputPath);
        
        // Auto-generate golden reference file if absent
        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for cdp-google.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const normalizedResult = JSON.parse(JSON.stringify(result));
        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        // Delete dynamic fields before comparison
        normalizedResult.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        ref.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        normalizedResult.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");
        ref.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");

        assert.deepStrictEqual(normalizedResult, ref, 'Parsed CDP JSON does not match reference output');
        assert.strictEqual(normalizedResult.log.version, "1.2");
        assert.strictEqual(normalizedResult.log.creator.name, "waterfall-tools (devtools)");
        
        assert.ok(normalizedResult.log.pages.length > 0, "Should generate at least one page");
        assert.ok(normalizedResult.log.entries.length > 0, "Should generate multiple entries");
    });

    await t.test('Should safely process massive CDP JSON traces (CNN) streaming effectively', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Chrome Devtools Protocol/www.cnn.com-devtools.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/cdp-cnn.har.json');
        
        const result = await processCDPFileNode(inputPath);
        
        if (!fs.existsSync(refPath)) {
            console.log("Generating golden fixture for cdp-cnn.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }

        const normalizedResult = JSON.parse(JSON.stringify(result));
        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        normalizedResult.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        ref.log.pages.forEach(p => p.startedDateTime = "SCRUBBED");
        normalizedResult.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");
        ref.log.entries.forEach(e => e.startedDateTime = "SCRUBBED");

        assert.deepStrictEqual(normalizedResult, ref, 'Parsed CNN CDP JSON does not match reference output');
        assert.strictEqual(normalizedResult.log.creator.name, "waterfall-tools (devtools)");
    });

    await t.test('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Chrome Devtools Protocol/DOES_NOT_EXIST.json');
        await assert.rejects(
            async () => await processCDPFileNode(inputPath),
            { code: 'ENOENT' },
            'Should reject with ENOENT when file is missing'
        );
    });
});
