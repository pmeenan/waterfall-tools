#!/usr/bin/env node

import { processTcpdumpNode } from './tcpdump.js';
import fs from 'node:fs';

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: cli-tcpdump <path/to/capture.cap>');
        process.exit(1);
    }

    const filePath = args[0];
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    console.log(`Processing capture file: ${filePath}`);
    const start = performance.now();
    
    try {
        const packets = await processTcpdumpNode(filePath);
        const end = performance.now();

        console.log(`\nParsed ${packets.length} valid IP packets in ${(end - start).toFixed(2)}ms`);
        if (packets.length > 0) {
            console.log(`First packet time: ${packets[0].time}`);
            console.log(`Last packet time: ${packets[packets.length - 1].time}`);
            
            let tcpCount = 0;
            let udpCount = 0;
            let bytesIn = 0;
            let bytesOut = 0;
            
            for (const p of packets) {
                if (p.transport.type === 'TCP') tcpCount++;
                if (p.transport.type === 'UDP') udpCount++;
                if (p.ethernet.direction === 'in') bytesIn += p.origLen;
                if (p.ethernet.direction === 'out') bytesOut += p.origLen;
            }
            
            console.log(`TCP packets: ${tcpCount}`);
            console.log(`UDP packets: ${udpCount}`);
            console.log(`Bytes In: ${bytesIn}`);
            console.log(`Bytes Out: ${bytesOut}`);
        }
    } catch (err) {
        console.error('Error parsing tcpdump:', err);
        process.exit(1);
    }
}

main();
