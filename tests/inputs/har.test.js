import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { processHARFileNode } from '../../src/inputs/har.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getRawJSON(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    }
    return JSON.parse(buf.toString('utf8'));
}

test('HAR Input Processor', async (t) => {
    
    await t.test('Should correctly parse and normalize a Gzipped WebPageTest HAR', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/WebPageTest/amazon.har.gz');
        const refPath = path.resolve(__dirname, '../fixtures/amazon.har.json');
        
        const result = await processHARFileNode(inputPath);
        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        assert.deepStrictEqual(result, ref, 'Parsed WPT HAR does not match reference output');
        assert.strictEqual(result.log.version, "1.2");
        assert.strictEqual(result.log.creator.name, "waterfall-tools");
        
        const rawHar = getRawJSON(inputPath);
        assert.strictEqual(result.log.entries.length, rawHar.log.entries?.length || 0, "Parsed entries count must match source exactly");
        assert.strictEqual(result.log.pages.length, rawHar.log.pages?.length || 0, "Parsed pages count must match source exactly");
    });

    await t.test('Should correctly parse and normalize a plain Text Chrome HAR', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/Chrome/www.google.com.har');
        const refPath = path.resolve(__dirname, '../fixtures/chrome-google.har.json');
        
        const result = await processHARFileNode(inputPath);
        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        assert.deepStrictEqual(result, ref, 'Parsed Chrome HAR does not match reference output');
        assert.strictEqual(result.log.creator.name, "waterfall-tools");
        
        const rawHar = getRawJSON(inputPath);
        assert.strictEqual(result.log.entries.length, rawHar.log.entries?.length || 0, "Parsed entries count must match source exactly");
        assert.strictEqual(result.log.pages.length, rawHar.log.pages?.length || 0, "Parsed pages count must match source exactly");
    });

    await t.test('Should correctly parse and normalize a plain Text Firefox HAR', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/Firefox/www.google.com_Archive [26-03-27 17-36-46].har');
        const refPath = path.resolve(__dirname, '../fixtures/firefox-google.har.json');
        
        const result = await processHARFileNode(inputPath);
        const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

        assert.deepStrictEqual(result, ref, 'Parsed Firefox HAR does not match reference output');
        assert.strictEqual(result.log.creator.name, "waterfall-tools");

        const rawHar = getRawJSON(inputPath);
        assert.strictEqual(result.log.entries.length, rawHar.log.entries?.length || 0, "Parsed entries count must match source exactly");
        assert.strictEqual(result.log.pages.length, rawHar.log.pages?.length || 0, "Parsed pages count must match source exactly");
    });

    await t.test('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/HARs/DOES_NOT_EXIST.har');
        await assert.rejects(
            async () => await processHARFileNode(inputPath),
            { code: 'ENOENT' },
            'Should reject with ENOENT when file is missing'
        );
    });
});
