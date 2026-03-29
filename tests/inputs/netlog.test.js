import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Netlog JSON Input Processor', async (t) => {
    
    await t.test('Should effectively parse and normalize a small Netlog trace (Google)', async () => {
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
        result = JSON.parse(JSON.stringify(result)); // sanitize for assert

        assert.deepStrictEqual(result, ref, 'Parsed Netlog JSON does not match reference output');
        assert.strictEqual(result.log.version, "1.2");
        assert.strictEqual(result.log.creator.name, "waterfall-tools");
        
        assert.ok(result.log.pages.length > 0, "Should generate at least one page");
        const page = result.log.pages[0];
        
        // Check unlinked properties were added successfully
        assert.ok(Array.isArray(page._unlinked_connections), "Should have unlinked connection arrays defined");
        assert.ok(Array.isArray(page._unlinked_dns_lookups), "Should have unlinked dns arrays defined");
    });

    await t.test('Should effectively parse complex multiple domain Netlog traces (Amazon)', async () => {
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
        result = JSON.parse(JSON.stringify(result)); // sanitize for assert

        assert.deepStrictEqual(result, ref, 'Parsed Amazon Netlog JSON does not match reference output');
        assert.strictEqual(result.log.creator.name, "waterfall-tools");
        
        const entries = result.log.entries;
        assert.ok(entries.length > 0, "Should contain request entries mapped out successfully");
    });

    await t.test('Should reject invalid file paths safely', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Netlog/DOES_NOT_EXIST.json.gz');
        await assert.rejects(
            async () => {
                const tool = new WaterfallTools();
                await tool.loadFile(inputPath, { debug: true, format: 'netlog' });
            },
            { code: 'ENOENT' },
            'Should reject with ENOENT when file is missing'
        );
    });

});
