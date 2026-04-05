import { createStorage } from '../platforms/storage.js';
import { ZipReader } from './utilities/zip.js';
import { getBaseWptHar, processWPTFlatStreamNode, formatWptUtilization } from './wpt-json.js';
import { buildWaterfallDataFromHar } from '../core/har-converter.js';

async function parseWptagentProgressCsv(stream, isGz) {
    if (isGz && typeof DecompressionStream !== 'undefined') {
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    const pipeline = stream.pipeThrough(new TextDecoderStream());
    const reader = pipeline.getReader();
    let text = '';
    while (true) {
        const { done, value } = await reader.read();
        if (value) text += value;
        if (done) break;
    }
    const lines = text.split('\n');
    const util = {
        cpu: { data: {}, max: 100, count: 0 },
        bw: { data: {}, max: 0, count: 0 },
        mem: { data: {}, max: 0, count: 0 }
    };
    
    // Offset Time (ms),Bandwidth In (bps),CPU Utilization (%),Memory
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const [time, bw, cpu, mem] = line.split(',');
        const t = parseInt(time, 10);
        if (isNaN(t)) continue;
        
        if (bw !== undefined) {
            const val = parseInt(bw, 10);
            util.bw.data[t] = val;
            util.bw.max = Math.max(util.bw.max, val);
            util.bw.count++;
        }
        if (cpu !== undefined) {
            const val = parseFloat(cpu);
            util.cpu.data[t] = val;
            util.cpu.max = 100.0;
            util.cpu.count++;
        }
        if (mem !== undefined && mem !== '-1') {
            const val = parseInt(mem, 10);
            util.mem.data[t] = val;
            util.mem.max = Math.max(util.mem.max, val);
            util.mem.count++;
        }
    }
    
    if (util.bw.count === 0) delete util.bw;
    if (util.cpu.count === 0) delete util.cpu;
    if (util.mem.count === 0) delete util.mem;
    return util;
}

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

    if (fileList.includes('testinfo.json')) {
        const stream = await zip.getFileStream('testinfo.json');
        if (stream) {
            const pipeline = stream.pipeThrough(new TextDecoderStream());
            const reader = pipeline.getReader();
            let text = '';
            while (true) {
                const { done, value } = await reader.read();
                if (value) text += value;
                if (done) break;
            }
            try {
                const testinfo = JSON.parse(text);
                // WPT `testinfo.json` natively provides `bwIn` and `bwOut` in Kbps matching legacy standards
                if (testinfo.bwIn) outputHar.log._bwDown = testinfo.bwIn;
                if (testinfo.bwOut) outputHar.log._bwUp = testinfo.bwOut;
                if (testinfo.latency) outputHar.log._latency = testinfo.latency;
                if (testinfo.plr) outputHar.log._plr = testinfo.plr;
                outputHar.log._testinfo = testinfo;
            } catch(e) {
                // Ignore silent JSON parse issues gracefully
            }
        }
    }

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

    // Parse any progress.csv matching run identifiers for utilization mapping
    const progressRegex = /^(\d+)(_Cached)?_progress\.csv(\.gz)?$/;
    for (const file of fileList) {
        const match = file.match(progressRegex);
        if (match) {
            const runStr = match[1];
            const cachedNum = match[2] ? 1 : 0;
            const stream = await zip.getFileStream(file);
            if (stream) {
                const rawUtil = await parseWptagentProgressCsv(stream, file.endsWith('.gz'));
                const pageId = `page_${runStr}_${cachedNum}`;
                const targetPage = outputHar.log.pages.find(p => p.id === pageId);
                if (targetPage) {
                    targetPage._utilization = formatWptUtilization(rawUtil, outputHar.log._bwDown || 0);
                }
            }
        }
    }

    if (outputHar.log._bwDown && outputHar.log._bwDown > 0) {
        outputHar.log.pages.forEach(p => p._bwDown = outputHar.log._bwDown);
    }

    const finalData = buildWaterfallDataFromHar(outputHar.log, 'wpt');
    
    // Bind storage directly into return object mapping lifecycle cleanly
    finalData._opfsStorage = storage;

    return finalData;
}
