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
import { WaterfallTools, identifyFormatFromBuffer } from '../dist/node/waterfall-tools.es.js';

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.error(
            'Usage:\n' +
            '  waterfall-tools <input-file> [output-file] [--keylog <keylog-file>] [--debug]\n' +
            '  waterfall-tools <qlog-file> [more-qlog-files...] [--output <output-file>] [--debug]\n' +
            '  waterfall-tools install-viewer <target-dir>\n' +
            '\n' +
            'Omit [output-file] to write the Extended HAR JSON to stdout\n' +
            'Use --output when passing multiple qlog input files\n' +
            '(status messages go to stderr, so `waterfall-tools in.cap > out.har` is safe).'
        );
        process.exit(1);
    }

    if (args[0] === 'install-viewer') {
        const { runInstallViewer } = await import('./install-viewer.js');
        await runInstallViewer(args.slice(1));
        return;
    }

    const positional = [];
    let outputFile = null;
    let keyLogPath = null;
    const options = { debug: false };
    
    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--keylog') {
            keyLogPath = args[i + 1];
            i++; // skip next
        } else if (args[i] === '--debug') {
            options.debug = true;
        } else if (args[i] === '--output' && args[i + 1]) {
            outputFile = args[i + 1];
            i++;
        } else if (!outputFile && !args[i].startsWith('--')) {
            positional.push(args[i]);
        } else if (!args[i].startsWith('--')) {
            positional.push(args[i]);
        }
    }

    if (positional.length === 0) {
        console.error('Error: No input file provided.');
        process.exit(1);
    }

    // Backwards-compatible shorthand: `waterfall-tools input.har out.har`.
    // When every positional exists, treat them as input files so qlog page-load
    // merges work; use --output to avoid ambiguity when the output already exists.
    if (!outputFile && positional.length > 1 && !fs.existsSync(positional[positional.length - 1])) {
        outputFile = positional.pop();
    }

    for (const inputFile of positional) {
        if (!fs.existsSync(inputFile)) {
            console.error(`Error: File ${inputFile} not found.`);
            process.exit(1);
        }
    }
    
    if (keyLogPath) {
        options.keyLogInput = keyLogPath;
    }

    let multiInputBuffers = null;
    if (!outputFile && positional.length > 1) {
        multiInputBuffers = positional.map(file => new Uint8Array(fs.readFileSync(file)));
        const formats = await Promise.all(multiInputBuffers.map(buf => identifyFormatFromBuffer(buf).then(result => result.format)));
        if (!formats.every(format => format === 'qlog')) {
            outputFile = positional.pop();
            multiInputBuffers = null;
        }
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
        console.error(`Processing file${positional.length > 1 ? 's' : ''}: ${positional.join(', ')}`);
        const tool = new WaterfallTools();
        if (positional.length > 1) {
            const buffers = multiInputBuffers || positional.map(file => new Uint8Array(fs.readFileSync(file)));
            await tool.loadBuffers(buffers, options);
        } else {
            await tool.loadFile(positional[0], options);
        }
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
