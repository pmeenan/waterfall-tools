/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processNetlogFileNode } from '../netlog.js';
import { runFormatCli } from './run-format-cli.js';

/**
 * Standalone wrapper: Netlog file -> Extended HAR JSON.
 * Usage: node src/inputs/cli/netlog.js [--input] <path/to/input.netlog[.gz]> [--output <path>] [--debug]
 * Without --output the HAR is written to stdout; status always goes to stderr.
 */
export function run(argv = process.argv.slice(2)) {
    return runFormatCli({
        label: 'Netlog file',
        usageInput: 'path/to/input.netlog[.gz]',
        scriptName: 'netlog.js',
        parse: (input, options) => processNetlogFileNode(input, options)
    }, argv);
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
