import { processPerfettoFileNode } from '../perfetto.js';

/**
 * Standalone wrapper for executing the Perfetto streaming parser
 * via Command Line mapping directly to standard Extended HAR objects.
 */
export async function runCLI(args) {
    if (args.length < 1) {
        console.error("Usage: node src/inputs/cli/perfetto.js <path-to-pftrace|path-to-pftrace.gz> [--debug]");
        process.exit(1);
    }
    
    const file = args[0];
    const debug = args.includes('--debug');
    
    const fs = await import('fs');
    if (!fs.existsSync(file)) {
        console.error(`File not found: ${file}`);
        process.exit(1);
    }
    
    console.log(`Processing Perfetto Proto trace: ${file}...`);
    try {
        const result = await processPerfettoFileNode(file, { debug });
        console.log("Extraction complete.");
        console.log(JSON.stringify(result, (key, value) => {
            if (key === '_zipFiles' || key === '_opfsStorage') return undefined;
            return value;
        }, 2));
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
