/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { processPerfettoFileNode } from '../perfetto.js';
import { relationalToHar } from '../../core/har-export.js';

/**
 * Standalone wrapper for executing the Perfetto streaming parser
 * via Command Line mapping directly to standard Extended HAR objects.
 */
export async function runCLI(args) {
    if (args.length < 1) {
        console.error("Usage: node src/inputs/cli/perfetto.js <path-to-pftrace|path-to-pftrace.gz> [--output <path>] [--debug]");
        console.error("Without --output the Extended HAR JSON is written to stdout (status goes to stderr).");
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
    const file = positional[0];

    const fs = await import('fs');
    if (!file || !fs.existsSync(file)) {
        console.error(`File not found: ${file}`);
        process.exit(1);
    }

    // All status lines go to stderr — stdout is reserved for the HAR JSON so that
    // `node src/inputs/cli/perfetto.js trace.gz > out.har` produces a parseable file.
    // The parser's `debug` telemetry follows the library-wide console.log convention;
    // reroute all console.log output to stderr for the process lifetime so `--debug`
    // can't corrupt the redirected JSON (the HAR is emitted via process.stdout.write).
    // Unconditional for consistency: --output mode keeps a clean stdout too.
    console.log = (...logArgs) => console.error(...logArgs);
    console.error(`Processing Perfetto Proto trace: ${file}...`);
    try {
        const data = await processPerfettoFileNode(file, { debug });
        // Convert the internal relational object to true Extended HAR ({ log: {...} }).
        // No replacer needed: relationalToHar only reads data.pages/connections, so the
        // internal root-level fields (_zipFiles, _opfsStorage) never reach the output.
        const extendedHar = relationalToHar(data);
        const json = JSON.stringify(extendedHar, null, 2);
        if (outputPath) {
            fs.writeFileSync(outputPath, json, 'utf-8');
            console.error(`Successfully generated Extended HAR: ${outputPath}`);
        } else {
            process.stdout.write(json + '\n');
            console.error("Successfully generated Extended HAR.");
        }
    } catch (e) {
        console.error("Error processing trace:", e);
        process.exit(1);
    }
}

// Execute natively if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runCLI(process.argv.slice(2)).catch(e => {
        console.error("CLI Execution failed:", e);
        process.exit(1);
    });
}
