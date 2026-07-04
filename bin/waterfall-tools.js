#!/usr/bin/env node
/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

/**
 * Waterfall Tools Root CLI Wrapper
 * Usage:
 *   waterfall-tools <input-file> [output-file] [--keylog <keylog-file>] [--debug]
 *   waterfall-tools install-viewer <target-dir>
 */

import fs from 'node:fs';
import { WaterfallTools } from '../dist/node/waterfall-tools.es.js';

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.error(
            'Usage:\n' +
            '  waterfall-tools <input-file> [output-file] [--keylog <keylog-file>] [--debug]\n' +
            '  waterfall-tools install-viewer <target-dir>\n' +
            '\n' +
            'Omit [output-file] to write the Extended HAR JSON to stdout\n' +
            '(status messages go to stderr, so `waterfall-tools in.cap > out.har` is safe).'
        );
        process.exit(1);
    }

    if (args[0] === 'install-viewer') {
        const { runInstallViewer } = await import('./install-viewer.js');
        await runInstallViewer(args.slice(1));
        return;
    }
    
    const inputFile = args[0];
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
    
    if (!fs.existsSync(inputFile)) {
        console.error(`Error: File ${inputFile} not found.`);
        process.exit(1);
    }
    
    if (keyLogPath) {
        options.keyLogInput = keyLogPath;
    }

    // Stdout is reserved for HAR JSON (emitted via process.stdout.write); the library's
    // `debug` telemetry convention is console.log, so reroute ALL console.log output
    // (parser debug lines, stray dependency logging) to stderr for the process lifetime.
    // Unconditional for consistency: file-output mode keeps a clean stdout too.
    console.log = (...logArgs) => console.error(...logArgs);

    try {
        // Status goes to stderr: with no [output-file] the HAR JSON is written to stdout
        // (the README-documented `waterfall-tools in.cap > out.har` contract), so stdout
        // must stay pure JSON.
        console.error(`Processing file: ${inputFile}`);
        const tool = new WaterfallTools();
        await tool.loadFile(inputFile, options);
        const har = tool.getHar(options);
        const json = JSON.stringify(har, null, 2);

        if (outputFile) {
            fs.writeFileSync(outputFile, json);
            console.error(`Successfully parsed network data.`);
            console.error(`Saved Extended HAR to ${outputFile}`);
        } else {
            process.stdout.write(json + '\n');
            console.error(`Successfully parsed network data.`);
        }
    } catch (e) {
        console.error("Failed to process file:", e);
        process.exit(1);
    }
}

main();
