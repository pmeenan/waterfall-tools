/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processRumcapNode } from '../rumcap.js';
import { relationalToHar } from '../../core/har-export.js';
import fs from 'node:fs';
import path from 'node:path';

async function run() {
    const args = process.argv.slice(2);
    let inputPath = '';
    let outputPath = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--input' && args[i + 1]) {
            inputPath = args[i + 1];
            i++;
        } else if (args[i] === '--output' && args[i + 1]) {
            outputPath = args[i + 1];
            i++;
        }
    }

    if (!inputPath || !outputPath) {
        console.error('Usage: node rumcap.js --input <path/to/capture.rcap[.gz]> --output <path/to/output.json>');
        process.exit(1);
    }

    console.log(`Processing rumcap capture: ${inputPath}...`);
    try {
        const startTime = Date.now();
        // processRumcapNode handles all input plumbing (path/gunzip/decode); convert its
        // relational output to true Extended HAR the same way every other wrapper (and the
        // unified CLI's getHar()) does. relationalToHar reads data.pages, never the retained
        // data._rumcapCapture, so the raw capture cannot leak into the output.
        const data = await processRumcapNode(inputPath);
        const har = relationalToHar(data);

        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Write the normalized result to the output path
        fs.writeFileSync(outputPath, JSON.stringify(har, null, 2), 'utf-8');
        console.log(`Successfully generated Extended HAR: ${outputPath} in ${Date.now() - startTime}ms`);
    } catch (err) {
        console.error('Failed to process rumcap capture:', err);
        process.exit(1);
    }
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
