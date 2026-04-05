// File: src/inputs/wptagent.js
import { createStorage } from '../platforms/storage.js';
import { ZipReader } from './utilities/zip.js';
import { getBaseWptHar, processWPTFlatStreamNode } from './wpt-json.js';
import { buildWaterfallDataFromHar } from '../core/har-converter.js';

/**
 * Normalizes an input (Buffer/ArrayBuffer/NodeBuffer) safely to Uint8Array.
 */
function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return new Uint8Array(input);
}

export async function processWptagentZip(input, options = {}) {
    let hashName = `wptagent_temp_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    
    // Leverage instance Id passed from conductor natively if available
    if (options.instanceId) {
        hashName = `wptagent_${options.instanceId}`;
    } else if (typeof input === 'string') {
        // simplistic string hash fallback
        let h = 0;
        for (let i = 0; i < input.length; i++) {
            h = Math.imul(31, h) + input.charCodeAt(i) | 0;
        }
        hashName = `wptagent_file_${h}`;
    }

    const storage = await createStorage(hashName);
    
    // Safely write isomorphic input streams into generic storage abstraction
    if (typeof input === 'string') {
        const fs = await import(/* @vite-ignore */ 'node:fs');
        const readStream = fs.createReadStream(input);
        const { Readable } = await import(/* @vite-ignore */ 'node:stream');
        await storage.writeStream(Readable.toWeb(readStream));
    } else if (input instanceof Uint8Array || input instanceof ArrayBuffer || (input && input.buffer instanceof ArrayBuffer)) {
        await storage.writeBuffer(toUint8Array(input));
    } else if (input && typeof input.getReader === 'function') {
        await storage.writeStream(input);
    } else {
        throw new Error("Unsupported input type for wptagent processor");
    }

    const zip = new ZipReader(storage);
    await zip.init();

    const outputHar = getBaseWptHar();
    const fileList = zip.getFileList();
    outputHar.log._zipFiles = fileList;

    const devtoolsRegex = /^(\d+)(_Cached)?_devtools_requests\.json(\.gz)?$/;
    let foundDevTools = false;

    for (const file of fileList) {
        const match = file.match(devtoolsRegex);
        if (match) {
            foundDevTools = true;
            const runStr = match[1];
            const cachedNum = match[2] ? 1 : 0;
            const stream = await zip.getFileStream(file);
            if (stream) {
                await processWPTFlatStreamNode(stream, runStr, cachedNum, outputHar, { isGz: file.endsWith('.gz') });
            }
        }
    }

    if (!foundDevTools) {
        throw new Error("Invalid wptagent zip: missing devtools_requests payload files.");
    }

    const finalData = buildWaterfallDataFromHar(outputHar.log, 'wpt');
    
    // Bind storage directly into return object mapping lifecycle cleanly
    finalData._opfsStorage = storage;

    return finalData;
}
