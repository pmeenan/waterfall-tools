/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processCDPFileNode } from '../cdp.js';
import { runFormatCli } from './run-format-cli.js';

/**
 * Standalone wrapper: CDP JSON file -> Extended HAR JSON.
 * Usage: node src/inputs/cli/cdp.js [--input] <path/to/input-devtools.json[.gz]> [--output <path>] [--debug]
 * Without --output the HAR is written to stdout; status always goes to stderr.
 */
export function run(argv = process.argv.slice(2)) {
    return runFormatCli({
        label: 'CDP JSON file',
        usageInput: 'path/to/input-devtools.json[.gz]',
        scriptName: 'cdp.js',
        parse: (input, options) => processCDPFileNode(input, options)
    }, argv);
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
