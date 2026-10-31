/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processChromeTraceFileNode } from '../chrome-trace.js';
import { runFormatCli } from './run-format-cli.js';

/**
 * Standalone wrapper: Chrome Trace file -> Extended HAR JSON.
 * Usage: node src/inputs/cli/chrome-trace.js [--input] <path/to/input.trace[.gz]> [--output <path>] [--debug]
 * Without --output the HAR is written to stdout; status always goes to stderr.
 */
export function run(argv = process.argv.slice(2)) {
    return runFormatCli({
        label: 'Chrome Trace file',
        usageInput: 'path/to/input.trace[.gz]',
        scriptName: 'chrome-trace.js',
        parse: (input, options) => processChromeTraceFileNode(input, options)
    }, argv);
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
