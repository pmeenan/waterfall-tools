/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { relationalToHar } from '../../core/har-export.js';

/**
 * Shared driver for the single-input per-format CLI wrappers (`src/inputs/cli/*.js`).
 *
 * Contract (same as perfetto.js / qlog.js and the unified `bin/waterfall-tools.js`):
 *   node src/inputs/cli/<format>.js [--input] <path> [--output <path>] [--debug]
 * - Input may be given positionally or via `--input <path>` (back-compat).
 * - Without `--output`, the Extended HAR JSON is written to stdout.
 * - stdout is reserved for HAR JSON: every status line goes to stderr, and process-wide
 *   `console.log` (the library's `debug` telemetry channel) is rerouted to stderr so
 *   `--debug` can't corrupt redirected output.
 *
 * @param {Object} config
 * @param {string} config.label - Human-readable format label for status lines
 * @param {string} config.usageInput - Input placeholder for the usage line
 * @param {string} config.scriptName - Script file name for the usage line
 * @param {(input: string, options: Object) => Promise<Object>} config.parse - Parser returning relational data
 * @param {string[]} [argv] - CLI arguments (defaults to process.argv.slice(2))
 * @returns {Promise<void>}
 */
export async function runFormatCli({ label, usageInput, scriptName, parse }, argv = process.argv.slice(2)) {
    let inputPath = '';
    let outputPath = '';
    let debug = false;

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--input' && argv[i + 1]) {
            inputPath = argv[++i];
        } else if (argv[i] === '--output' && argv[i + 1]) {
            outputPath = argv[++i];
        } else if (argv[i] === '--debug') {
            debug = true;
        } else if (!argv[i].startsWith('--') && !inputPath) {
            inputPath = argv[i];
        }
    }

    if (!inputPath) {
        console.error(`Usage: node src/inputs/cli/${scriptName} [--input] <${usageInput}> [--output <path/to/output.har>] [--debug]`);
        console.error('Without --output the Extended HAR JSON is written to stdout (status goes to stderr).');
        process.exitCode = 1;
        return;
    }
    if (!fs.existsSync(inputPath)) {
        console.error(`File not found: ${inputPath}`);
        process.exitCode = 1;
        return;
    }

    console.log = (...logArgs) => console.error(...logArgs);
    console.error(`Processing ${label}: ${inputPath}...`);
    try {
        const startTime = Date.now();
        const data = await parse(inputPath, { debug });
        // Convert the internal relational object to true Extended HAR ({ log: {...} }).
        // relationalToHar only reads data.pages/connections, so internal root-level fields
        // (_zipFiles, _opfsStorage, _rumcapCapture) never reach the output.
        const json = JSON.stringify(relationalToHar(data), null, 2);

        if (outputPath) {
            const outputDir = path.dirname(outputPath);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            fs.writeFileSync(outputPath, json, 'utf-8');
            console.error(`Successfully generated Extended HAR: ${outputPath} in ${Date.now() - startTime}ms`);
        } else {
            process.stdout.write(json + '\n');
            console.error(`Successfully generated Extended HAR in ${Date.now() - startTime}ms`);
        }

        // Archive-backed parsers keep staged storage alive for lazy resource extraction;
        // release it so Node doesn't warn about FileHandles closed on GC.
        if (data && data._opfsStorage && typeof data._opfsStorage.destroy === 'function') {
            await data._opfsStorage.destroy();
        }
    } catch (err) {
        console.error(`Failed to process ${label}:`, err);
        process.exitCode = 1;
    }
}
