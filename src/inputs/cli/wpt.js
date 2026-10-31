/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processWPTFileNode } from '../wpt-json.js';
import { runFormatCli } from './run-format-cli.js';

/**
 * Standalone wrapper: WebPageTest JSON file -> Extended HAR JSON.
 * Usage: node src/inputs/cli/wpt.js [--input] <path/to/input-wpt.json[.gz]> [--output <path>] [--debug]
 * Without --output the HAR is written to stdout; status always goes to stderr.
 */
export function run(argv = process.argv.slice(2)) {
    return runFormatCli({
        label: 'WebPageTest JSON file',
        usageInput: 'path/to/input-wpt.json[.gz]',
        scriptName: 'wpt.js',
        parse: (input, options) => processWPTFileNode(input, options)
    }, argv);
}

// Ensure it only runs if it is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
