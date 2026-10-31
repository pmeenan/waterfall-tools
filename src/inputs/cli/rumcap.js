/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processRumcapNode } from '../rumcap.js';
import { runFormatCli } from './run-format-cli.js';

/**
 * Standalone wrapper: rumcap capture -> Extended HAR JSON.
 * Usage: node src/inputs/cli/rumcap.js [--input] <path/to/capture.rcap[.gz]> [--output <path>] [--debug]
 * Without --output the HAR is written to stdout; status always goes to stderr.
 */
export function run(argv = process.argv.slice(2)) {
    return runFormatCli({
        label: 'rumcap capture',
        usageInput: 'path/to/capture.rcap[.gz]',
        scriptName: 'rumcap.js',
        parse: (input, options) => processRumcapNode(input, options)
    }, argv);
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
