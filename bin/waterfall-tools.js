#!/usr/bin/env node

/**
 * Waterfall Tools Root CLI Wrapper
 * Usage: waterfall-tools <input-file> [output-file] [--keylog <keylog-file>] [--debug]
 */

import fs from 'node:fs';
import path from 'node:path';
import { Conductor } from '../src/core/conductor.js';

async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.error('Usage: waterfall-tools <input-file> [output-file] [--keylog <keylog-file>] [--debug]');
        process.exit(1);
    }
    
    let inputFile = args[0];
    let outputFile = null;
    let keyLogPath = null;
    const options = { debug: false };
    
    // Parse arguments
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--keylog') {
            keyLogPath = args[i + 1];
            i++; // skip next
        } else if (args[i] === '--debug') {
            options.debug = true;
        } else if (!outputFile && !args[i].startsWith('--')) {
            outputFile = args[i];
        }
    }
    
    if (!outputFile) {
        // default output: input.har
        const basename = path.basename(inputFile);
        const name = basename.split('.')[0];
        outputFile = `${name}.har`;
    }
    
    if (!fs.existsSync(inputFile)) {
        console.error(`Error: File ${inputFile} not found.`);
        process.exit(1);
    }
    
    if (keyLogPath) {
        options.keyLogInput = keyLogPath;
    }
    
    try {
        console.log(`Processing file: ${inputFile}`);
        const har = await Conductor.processFile(inputFile, options);
        fs.writeFileSync(outputFile, JSON.stringify(har, null, 2));
        console.log(`Successfully parsed network data.`);
        console.log(`Saved Extended HAR to ${outputFile}`);
    } catch (e) {
        console.error("Failed to process file:", e);
        process.exit(1);
    }
}

main();
