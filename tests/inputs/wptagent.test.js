import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaterfallTools } from '../../src/core/waterfall-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('WPTagent ZIP Input Processor', () => {

    it('Should parse roadtrip wptagent zip and extract response bodies', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/wptagent/roadtrip-wptagent.zip');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wptagent' });
        const result = tool.getHar({ debug: true });

        expect(result.log.version).toBe('1.2');
        expect(result.log.creator.name).toBe('waterfall-tools');
        expect(result.log.pages.length).toBeGreaterThan(0);
        expect(result.log.entries.length).toBeGreaterThan(0);

        // Verify that response bodies were extracted from the nested _bodies.zip
        const entriesWithBody = result.log.entries.filter(
            e => e.response && e.response.content && e.response.content.text
        );
        expect(entriesWithBody.length).toBeGreaterThan(0);

        // The first entry (the HTML document) should have a body
        const htmlEntry = result.log.entries.find(
            e => e.response && e.response.content && e.response.content.mimeType === 'text/html'
                && e.response.content.text
        );
        expect(htmlEntry).toBeTruthy();
        expect(htmlEntry.response.content.encoding).toBe('base64');

        // Verify the base64 body decodes to valid content
        const decoded = Buffer.from(htmlEntry.response.content.text, 'base64');
        expect(decoded.length).toBeGreaterThan(0);

        // The roadtrip wptagent zip has 29 body files for first view
        // Verify a reasonable number were linked
        const firstViewBodies = result.log.entries.filter(
            e => e._run === 1 && e._cached === 0
                && e.response && e.response.content && e.response.content.text
        );
        expect(firstViewBodies.length).toBeGreaterThanOrEqual(20);
    }, 30000);

    it('Should include body metadata (_body_file, _body_hash) on entries', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/wptagent/roadtrip-wptagent.zip');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'wptagent' });
        const result = tool.getHar({ debug: true });

        // Entries that originally had body_file should have _body_file preserved
        const withBodyFile = result.log.entries.filter(e => e._body_file);
        expect(withBodyFile.length).toBeGreaterThan(0);
    }, 30000);
});
