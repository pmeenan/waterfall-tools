/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processHARFileNode } from '../har.js';
import { runFormatCli } from './run-format-cli.js';

/**
 * Standalone wrapper: HAR file -> Extended HAR JSON.
 * Usage: node src/inputs/cli/har.js [--input] <path/to/input.har[.gz]> [--output <path>] [--debug]
 * Without --output the HAR is written to stdout; status always goes to stderr.
 */
export function run(argv = process.argv.slice(2)) {
    return runFormatCli({
        label: 'HAR file',
        usageInput: 'path/to/input.har[.gz]',
        scriptName: 'har.js',
        parse: (input, options) => processHARFileNode(input, options)
    }, argv);
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
