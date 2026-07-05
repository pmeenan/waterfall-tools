/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processQlogNode } from '../qlog.js';
import { relationalToHar } from '../../core/har-export.js';

/**
 * Standalone wrapper for the qlog parser mapping directly to standard Extended HAR
 * objects. Accepts multiple input files (one QUIC connection each) which merge into a
 * single page — the same multi-connection behavior the viewer's multi-file drop uses.
 */
export async function runCLI(args) {
    if (args.length < 1) {
        console.error('Usage: node src/inputs/cli/qlog.js <path-to-qlog|sqlog[.gz]> [more-qlog-files...] [--output <path>] [--debug]');
        console.error('Without --output the Extended HAR JSON is written to stdout (status goes to stderr).');
        process.exit(1);
    }

    const debug = args.includes('--debug');
    let outputPath = null;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--output' && args[i + 1]) {
            outputPath = args[++i];
        } else if (!args[i].startsWith('--')) {
            positional.push(args[i]);
        }
    }

    const fs = await import('fs');
    for (const file of positional) {
        if (!fs.existsSync(file)) {
            console.error(`File not found: ${file}`);
            process.exit(1);
        }
    }

    // All status lines go to stderr — stdout is reserved for the HAR JSON so that
    // `node src/inputs/cli/qlog.js capture.qlog.gz > out.har` produces a parseable file.
    // The parser's `debug` telemetry follows the library-wide console.log convention;
    // reroute all console.log output to stderr for the process lifetime so `--debug`
    // can't corrupt the redirected JSON (the HAR is emitted via process.stdout.write).
    console.log = (...logArgs) => console.error(...logArgs);
    console.error(`Processing ${positional.length} qlog file(s): ${positional.join(', ')}...`);
    try {
        const data = await processQlogNode(positional.length === 1 ? positional[0] : positional, { debug });
        // Convert the internal relational object to true Extended HAR ({ log: {...} }).
        const extendedHar = relationalToHar(data);
        const json = JSON.stringify(extendedHar, null, 2);
        if (outputPath) {
            fs.writeFileSync(outputPath, json, 'utf-8');
            console.error(`Successfully generated Extended HAR: ${outputPath}`);
        } else {
            process.stdout.write(json + '\n');
            console.error('Successfully generated Extended HAR.');
        }
    } catch (e) {
        console.error('Error processing qlog:', e);
        process.exit(1);
    }
}

// Execute natively if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runCLI(process.argv.slice(2)).catch(e => {
        console.error('CLI Execution failed:', e);
        process.exit(1);
    });
}
