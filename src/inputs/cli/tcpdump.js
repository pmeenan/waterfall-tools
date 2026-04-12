/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processTcpdumpNode } from '../tcpdump.js';
import fs from 'node:fs';
import path from 'node:path';

async function run() {
    const args = process.argv.slice(2);
    let inputPath = '';
    let outputPath = '';
    let keyLogPath = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--input' && args[i + 1]) {
            inputPath = args[i + 1];
            i++;
        } else if (args[i] === '--output' && args[i + 1]) {
            outputPath = args[i + 1];
            i++;
        } else if (args[i] === '--keylog' && args[i + 1]) {
            keyLogPath = args[i + 1];
            i++;
        }
    }

    if (!inputPath || !outputPath) {
        console.error('Usage: node cli-tcpdump.js --input <path/to/capture.cap[.gz]> --output <path/to/output.har> [--keylog <path/to/keys>]');
        process.exit(1);
    }

    console.log(`Processing PCAP/PCAPNG file: ${inputPath}...`);
    try {
        const startTime = Date.now();
        const options = keyLogPath ? { keyLogPath } : {};
        
        const extendedHar = await processTcpdumpNode(inputPath, options);
        
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Write the normalized result to the output path
        fs.writeFileSync(outputPath, JSON.stringify(extendedHar, null, 2), 'utf-8');
        console.log(`Successfully generated Extended HAR: ${outputPath} in ${Date.now() - startTime}ms`);
    } catch (err) {
        console.error('Failed to process PCAP file:', err);
        process.exit(1);
    }
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
