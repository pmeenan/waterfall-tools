/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { createStorage } from '../platforms/storage.js';
import { ZipReader } from './utilities/zip.js';
import { getBaseWptHar, processWPTFlatStreamNode, formatWptUtilization } from './wpt-json.js';
import { buildWaterfallDataFromHar } from '../core/har-converter.js';

// Canonical WebPageTest flame-chart categories. Every trace-event name that Chrome emits is
// folded into one of these five buckets so the renderer only has to manage five colors. The
// mapping mirrors the reference PHP implementation at
// Sample/Implementations/webpagetest/www/waterfall.inc (lines 437-491) — keep them in sync.
const MAIN_THREAD_CATEGORY_MAP = (() => {
    const map = new Map();
    const add = (category, names) => { for (const n of names) map.set(n, category); };
    add('ParseHTML', ['ParseHTML', 'ResourceReceivedData', 'ResourceSendRequest', 'ResourceReceivedResponse', 'ResourceReceiveResponse', 'ResourceFinish', 'CommitLoad']);
    add('Layout', ['Layout', 'RecalculateStyles', 'ParseAuthorStyleSheet', 'ScheduleStyleRecalculation', 'InvalidateLayout', 'UpdateLayoutTree']);
    add('Paint', ['Paint', 'PaintImage', 'PaintSetup', 'CompositeLayers', 'DecodeImage', 'Decode Image', 'ImageDecodeTask', 'Rasterize', 'GPUTask', 'SetLayerTreeId', 'layerId', 'UpdateLayer', 'UpdateLayerTree', 'Draw LazyPixelRef', 'Decode LazyPixelRef', 'PrePaint', 'Layerize']);
    add('EvaluateScript', ['EvaluateScript', 'EventDispatch', 'FunctionCall', 'GCEvent', 'TimerInstall', 'TimerFire', 'TimerRemove', 'XHRLoad', 'XHRReadyStateChange', 'v8.compile', 'MinorGC', 'MajorGC', 'FireAnimationFrame', 'ThreadState::completeSweep', 'Heap::collectGarbage', 'ThreadState::performIdleLazySweep']);
    return map;
})();

/**
 * Fold a wptagent `timeline_cpu.json` payload into the compact `_mainThreadSlices` page field
 * consumed by the renderer. Only the primary `main_thread` data is carried over — background
 * threads (parse-on-background, GC helpers, etc.) are dropped to keep page payloads small.
 *
 * Values stay in microseconds per slice so the renderer can derive each slice's fraction-of-time
 * in a type as `value / slice_usecs` without further scaling (matches the reference PHP
 * AverageCpuSlices contract).
 */
function foldCpuSlices(raw) {
    if (!raw || typeof raw !== 'object' || !raw.slice_usecs || !raw.slices) return null;
    const mainThreadKey = raw.main_thread;
    const threadSlices = mainThreadKey && raw.slices[mainThreadKey];
    if (!threadSlices || typeof threadSlices !== 'object') return null;

    let sliceCount = 0;
    for (const arr of Object.values(threadSlices)) {
        if (Array.isArray(arr) && arr.length > sliceCount) sliceCount = arr.length;
    }
    if (sliceCount === 0) return null;

    const folded = { ParseHTML: null, Layout: null, Paint: null, EvaluateScript: null, other: null };
    for (const [type, values] of Object.entries(threadSlices)) {
        if (!Array.isArray(values) || values.length === 0) continue;
        const category = MAIN_THREAD_CATEGORY_MAP.get(type) || 'other';
        let bucket = folded[category];
        if (!bucket) {
            bucket = new Array(sliceCount).fill(0);
            folded[category] = bucket;
        }
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (v > 0) bucket[i] += v;
        }
    }

    const slices = {};
    for (const [cat, arr] of Object.entries(folded)) {
        if (arr) slices[cat] = arr;
    }
    if (Object.keys(slices).length === 0) return null;

    return {
        slice_usecs: raw.slice_usecs,
        total_usecs: raw.total_usecs || (sliceCount * raw.slice_usecs),
        slices
    };
}

async function parseWptagentTimelineCpu(stream, isGz) {
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
    try {
        return foldCpuSlices(JSON.parse(text));
    } catch (_) {
        return null;
    }
}

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

    const testinfoFile = fileList.includes('testinfo.json') ? 'testinfo.json' : (fileList.includes('testinfo.json.gz') ? 'testinfo.json.gz' : null);
    if (testinfoFile) {
        let stream = await zip.getFileStream(testinfoFile);
        if (stream) {
            if (testinfoFile.endsWith('.gz') && typeof DecompressionStream !== 'undefined') {
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

    // Extract response bodies from nested _bodies.zip archives and link them to matching HAR entries.
    // Body files are referenced by the `_body_file` custom property on each entry (set during
    // processWPTView from the original devtools_requests `body_file` field).
    const bodiesRegex = /^(\d+)(_Cached)?_bodies\.zip$/;
    for (const file of fileList) {
        const match = file.match(bodiesRegex);
        if (!match) continue;

        const runStr = match[1];
        const cachedNum = match[2] ? 1 : 0;

        // Extract the nested bodies zip into a temporary storage so ZipReader can random-access it
        const bodiesStorageName = `${hashName}_bodies_${runStr}_${cachedNum}`;
        let bodiesStorage = null;
        try {
            bodiesStorage = await createStorage(bodiesStorageName);
            const bodiesStream = await zip.getFileStream(file);
            if (!bodiesStream) continue;
            await bodiesStorage.writeStream(bodiesStream);

            const bodiesZip = new ZipReader(bodiesStorage);
            await bodiesZip.init();
            const bodyFiles = new Set(bodiesZip.getFileList());

            // Walk HAR entries matching this run/cached combination and attach bodies
            for (const entry of outputHar.log.entries) {
                if (entry._run !== parseInt(runStr, 10) || entry._cached !== cachedNum) continue;
                const bodyFile = entry._body_file;
                if (!bodyFile || !bodyFiles.has(bodyFile)) continue;

                const bodyStream = await bodiesZip.getFileStream(bodyFile);
                if (!bodyStream) continue;

                // Read the body file contents into a single Uint8Array
                const reader = bodyStream.getReader();
                const chunks = [];
                let totalLen = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    totalLen += value.length;
                }
                const fullArr = new Uint8Array(totalLen);
                let offset = 0;
                for (const c of chunks) {
                    fullArr.set(c, offset);
                    offset += c.length;
                }

                // Encode as base64 using chunked String.fromCharCode.apply
                // to avoid both call-stack limits and O(n²) string concatenation
                const CHUNK = 8192;
                const parts = [];
                for (let i = 0; i < fullArr.length; i += CHUNK) {
                    parts.push(String.fromCharCode.apply(null, fullArr.subarray(i, i + CHUNK)));
                }
                entry.response.content.text = btoa(parts.join(''));
                entry.response.content.encoding = 'base64';
            }
        } catch (e) {
            if (options.debug) {
                console.error(`[wptagent] Failed to extract bodies from ${file}:`, e);
            }
        } finally {
            // Clean up the temporary bodies storage immediately
            if (bodiesStorage) {
                try { await bodiesStorage.destroy(); } catch (_) { /* ignore cleanup errors */ }
            }
        }
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

    // Parse any timeline_cpu.json for main-thread flame-chart slices.
    // Page ids produced by processWPTView are `page_${run}_${cached}_1` (run view) — match on the
    // `_run`/`_cached` props rather than id suffix to stay robust across future id scheme changes.
    const cpuSliceRegex = /^(\d+)(_Cached)?_timeline_cpu\.json(\.gz)?$/;
    for (const file of fileList) {
        const match = file.match(cpuSliceRegex);
        if (!match) continue;
        const runNum = parseInt(match[1], 10);
        const cachedNum = match[2] ? 1 : 0;
        const stream = await zip.getFileStream(file);
        if (!stream) continue;
        const slices = await parseWptagentTimelineCpu(stream, file.endsWith('.gz'));
        if (!slices) continue;
        for (const page of outputHar.log.pages) {
            if (page._run === runNum && page._cached === cachedNum) {
                page._mainThreadSlices = slices;
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
