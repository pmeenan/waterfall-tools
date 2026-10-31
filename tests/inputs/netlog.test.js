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
import { Netlog } from '../../src/inputs/netlog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Netlog JSON Input Processor', () => {

    it('Should effectively parse and normalize a small Netlog trace (Google)', async () => {
        const inputPath = path.resolve(__dirname, '../../Sample/Data/Netlog/www.google.com-netlog.json.gz');
        const refPath = path.resolve(__dirname, '../fixtures/netlog-google.har.json');

        const tool = new WaterfallTools();
        await tool.loadFile(inputPath, { debug: true, format: 'netlog' });
        let result = tool.getHar({ debug: true });

        if (process.env.UPDATE_FIXTURES) {
            console.log("Updating golden fixture for netlog-google.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }
        expect(fs.existsSync(refPath), `Missing golden fixture: ${refPath}`).toBe(true);

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

        if (process.env.UPDATE_FIXTURES) {
            console.log("Updating golden fixture for netlog-amazon1.har.json...");
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, JSON.stringify(result, null, 2), 'utf-8');
        }
        expect(fs.existsSync(refPath), `Missing golden fixture: ${refPath}`).toBe(true);

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

    it('Should assign h2_session onto the underlying socket and accumulate inflated chunk bytes', () => {
        const nl = new Netlog();
        nl.setConstants({
            logEventTypes: {
                TCP_CONNECT_ATTEMPT: 1,
                HTTP2_SESSION_INITIALIZED: 2,
                HTTP_TRANSACTION_SEND_REQUEST: 3,
                HTTP_TRANSACTION_READ_RESPONSE_HEADERS: 4,
                URL_REQUEST_JOB_BYTES_READ: 5,
                URL_REQUEST_JOB_FILTERED_BYTES_READ: 6
            },
            logSourceType: {
                SOCKET: 1,
                HTTP2_SESSION: 2,
                URL_REQUEST: 3
            },
            logEventPhase: {
                PHASE_BEGIN: 1,
                PHASE_END: 2,
                PHASE_NONE: 0
            }
        });

        nl.addEvent({ type: 1, phase: 1, time: '100', source: { id: 10, type: 1 }, params: { address: '93.184.216.34:443' } });
        nl.addEvent({ type: 1, phase: 2, time: '110', source: { id: 10, type: 1 } });
        nl.addEvent({ type: 2, phase: 0, time: '112', source: { id: 20, type: 2 }, params: { host: 'example.com:443', source_dependency: { id: 10, type: 1 } } });

        expect(nl.netlog.socket[10].h2_session).toBe(20);

        nl.addEvent({ type: 3, phase: 0, time: '120', source: { id: 30, type: 3 }, params: { url: 'https://example.com/' } });
        nl.addEvent({ type: 4, phase: 0, time: '130', source: { id: 30, type: 3 }, params: { headers: ['HTTP/1.1 200 OK', 'content-type: text/html'] } });
        nl.addEvent({ type: 5, phase: 0, time: '135', source: { id: 30, type: 3 }, params: { byte_count: 1024 } });
        nl.addEvent({ type: 6, phase: 0, time: '135', source: { id: 30, type: 3 }, params: { byte_count: 2000 } });
        nl.addEvent({ type: 6, phase: 0, time: '136', source: { id: 30, type: 3 }, params: { byte_count: 3500 } });

        const { requests } = nl.postProcessEvents();
        expect(requests.length).toBe(1);
        expect(requests[0].chunks.length).toBe(1);
        expect(requests[0].chunks[0].bytes).toBe(1024);
        expect(requests[0].chunks[0].inflated).toBe(5500);
    });

});
