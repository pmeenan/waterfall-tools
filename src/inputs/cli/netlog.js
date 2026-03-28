import { processNetlogFileNode } from '../netlog.js';
import fs from 'node:fs';
import path from 'node:path';

async function run() {
    const args = process.argv.slice(2);
    let inputPath = '';
    let outputPath = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--input' && args[i + 1]) {
            inputPath = args[i + 1];
            i++;
        } else if (args[i] === '--output' && args[i + 1]) {
            outputPath = args[i + 1];
            i++;
        }
    }

    if (!inputPath || !outputPath) {
        console.error('Usage: node cli-netlog.js --input <path/to/input.netlog[.gz]> --output <path/to/output.json>');
        process.exit(1);
    }

    console.log(`Processing Netlog file: ${inputPath}...`);
    try {
        const startTime = Date.now();
        const extendedHar = await processNetlogFileNode(inputPath);
        
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        fs.writeFileSync(outputPath, JSON.stringify(extendedHar, null, 2), 'utf-8');
        console.log(`Successfully generated Extended HAR: ${outputPath} in ${Date.now() - startTime}ms`);
    } catch (err) {
        console.error('Failed to process Netlog file:', err);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
