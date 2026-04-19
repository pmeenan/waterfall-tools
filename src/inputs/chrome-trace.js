/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { Netlog, normalizeNetlogToHAR } from './netlog.js';
import { JSONParser } from '@streamparser/json';
import { buildWaterfallDataFromHar } from '../core/har-converter.js';
import { foldCpuSlices, SCRIPT_TIMING_EVENTS } from '../core/mainthread-categories.js';

const PRIORITY_MAP = {
    "VeryHigh": "Highest",
    "HIGHEST": "Highest",
    "MEDIUM": "High",
    "LOW": "Medium",
    "LOWEST": "Low",
    "IDLE": "Lowest",
    "VeryLow": "Lowest"
};

function isGzip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * Port of wptagent's `Trace.ProcessTimelineEvents` / `WriteCPUSlices` / `WriteScriptTimings`
 * (Sample/Implementations/wptagent/internal/support/trace_parser.py L492-L890). Replays the
 * raw devtools.timeline / blink.resource events into a per-thread B/E stack, selects the
 * primary main thread, aggregates CPU time into fixed-size slices, and extracts per-URL JS
 * execution intervals.
 *
 * Inputs are microsecond timestamps from the Chrome trace clock. Outputs:
 *  - `cpu` in wptagent's `timeline_cpu.json` shape (main_thread string, slice_usecs,
 *    total_usecs, slices: {thread: {eventName: usecs[]}}) — feed it through
 *    `foldCpuSlices` to get the renderer-ready 5-category `_mainThreadSlices` payload.
 *  - `scripts` mirrors `script_timing.json`: {main_thread, <thread>: {url: {eventName:
 *    [[start_ms, end_ms], ...]}}}, ms relative to `baseUs` so consumers don't re-normalize.
 *  - `longTasks` — top-level main-thread events ≥ 50 ms, flattened to [[startMs, endMs], ...]
 *    with overlap coalescing so downstream renderers can shade blocking periods.
 *
 * `baseUs` is the HAR page-zero anchor (earliest request/navigation). Slices are keyed off
 * it so slice index 0 aligns with canvas x=0. `startUs` is the navigationStart filter — any
 * event whose effective start is before it is dropped (matches trace_parser's `s >= start_time`
 * guard).
 */
function buildMainThreadActivity(rawEvents, baseUs, startUs, metaMainThreads, subframePids, toplevelTasks) {
    if (!rawEvents.length) {
        return { cpu: null, scripts: null, longTasks: [] };
    }

    // Sort by ts. Chrome emits events in rough-but-not-strict order; the B/E stack can't
    // tolerate out-of-order entries or it pops the wrong parent.
    rawEvents.sort((a, b) => a.ts - b.ts);

    const ignoreThreads = new Set();
    const threads = new Map();            // `pid:tid` → Map<eventName, numericId>
    const threadStack = new Map();        // `pid:tid` → stack of open events
    const eventNames = new Map();         // name → numericId
    const eventNameLookup = [];           // idx → name
    const timelineEvents = [];            // root events (tree) in ts order
    const mainThreadCandidates = new Set(metaMainThreads);
    let mainThread = null;                // locked in once ResourceSendRequest-with-URL fires
    let endUs = null;

    for (const evt of rawEvents) {
        const thread = `${evt.pid}:${evt.tid}`;
        const data = evt.data;

        // Main-thread detection. Matches trace_parser.py L510-L530: the 127.0.0.1:8888
        // synthetic request marks a thread as ignored (wptagent bootstrap traffic),
        // and the first `isMainFrame` or `ResourceSendRequest+url` event on a thread
        // both (a) adopts it into `threads` and (b) locks it in as `mainThread` if one
        // isn't already selected.
        if (data && !ignoreThreads.has(thread)) {
            if (typeof data.url === 'string' && data.url.startsWith('http://127.0.0.1:8888')) {
                ignoreThreads.add(thread);
            }
            if (mainThread === null || data.isMainFrame) {
                const isMainFrameExplicit = data.isMainFrame === true;
                const isResourceSendWithUrl = evt.name === 'ResourceSendRequest' && typeof data.url === 'string';
                if (isMainFrameExplicit || isResourceSendWithUrl) {
                    if (!threads.has(thread)) threads.set(thread, new Map());
                    mainThread = thread;
                    mainThreadCandidates.add(thread);
                    // Python synthesizes dur=1 on instantaneous Resource events so the
                    // stack logic still counts them. Mirror that.
                    if (evt.dur === undefined) evt.dur = 1;
                }
            }
        }

        // Once main_thread is locked in, every non-ignored thread gets tracked so the
        // slice aggregator has a bucket for it.
        if (mainThread !== null && !threads.has(thread) && !ignoreThreads.has(thread) && evt.name !== 'Program') {
            threads.set(thread, new Map());
        }

        // Stack-replay for B/E/X events. Only proceed when this thread is tracked and
        // the event actually carries a duration or is half of a B/E pair.
        const nameMap = threads.get(thread);
        const hasDur = evt.dur !== undefined;
        if (!nameMap || (!hasDur && evt.ph !== 'B' && evt.ph !== 'E')) continue;

        if (!eventNames.has(evt.name)) {
            eventNames.set(evt.name, eventNameLookup.length);
            eventNameLookup.push(evt.name);
        }
        const nid = eventNames.get(evt.name);
        if (!nameMap.has(evt.name)) nameMap.set(evt.name, nid);
        if (!threadStack.has(thread)) threadStack.set(thread, []);
        const stack = threadStack.get(thread);

        let built = null;
        if (evt.ph === 'E') {
            if (stack.length > 0) {
                const top = stack.pop();
                if (top.n === nid) top.e = evt.ts;
                built = top;
            }
        } else {
            const ev = { t: thread, n: nid, s: evt.ts };
            // JS attribution. Mirrors trace_parser.py L590-L600: EvaluateScript / v8.compile /
            // v8.parseOnBackground use args.data.url; FunctionCall prefers scriptName, falling
            // back to url (fragment-stripped).
            if (data) {
                if ((evt.name === 'EvaluateScript' || evt.name === 'v8.compile' || evt.name === 'v8.parseOnBackground')
                    && typeof data.url === 'string' && data.url.startsWith('http')) {
                    ev.js = data.url;
                } else if (evt.name === 'FunctionCall') {
                    if (typeof data.scriptName === 'string' && data.scriptName.startsWith('http')) {
                        ev.js = data.scriptName;
                    } else if (typeof data.url === 'string' && data.url.startsWith('http')) {
                        ev.js = data.url.split('#', 1)[0];
                    }
                }
            }
            if (evt.ph === 'B') {
                stack.push(ev);
            } else if (hasDur) {
                ev.e = ev.s + evt.dur;
                built = ev;
            }
        }

        if (built !== null && built.e !== undefined && built.s >= startUs && built.e >= built.s) {
            if (endUs === null || built.e > endUs) endUs = built.e;
            if (stack.length > 0) {
                const parent = stack.pop();
                if (!parent.c) parent.c = [];
                parent.c.push(built);
                stack.push(parent);
            } else {
                timelineEvents.push(built);
            }
        }
    }

    if (timelineEvents.length === 0 || endUs === null || endUs <= baseUs) {
        return { cpu: null, scripts: null, longTasks: [] };
    }

    // Slice sizing: largest power of 10 µs that still gives us > 2000 slices. This mirrors
    // Python's `while slice_count > 2000` loop — `last_exp` is the last exp that produced
    // > 2000 slices, so slice_usecs = 10^last_exp.
    const spanUs = endUs - baseUs;
    let exp = 0, lastExp = 0;
    let sliceCount = spanUs;
    while (sliceCount > 2000) {
        lastExp = exp;
        exp++;
        sliceCount = Math.ceil(spanUs / Math.pow(10, exp));
    }
    const sliceUsecs = Math.pow(10, lastExp);
    const finalSliceCount = Math.ceil(spanUs / sliceUsecs);
    if (finalSliceCount <= 0) {
        return { cpu: null, scripts: null, longTasks: [] };
    }

    // Pre-allocate per-thread per-name float arrays. `total` tracks the sum across named
    // categories so AdjustTimelineSlice can enforce the 100%-per-slot cap.
    const slices = {};
    for (const [thread, nameMap] of threads) {
        const t = { total: new Array(finalSliceCount).fill(0) };
        for (const name of nameMap.keys()) t[name] = new Array(finalSliceCount).fill(0);
        slices[thread] = t;
    }

    const scripts = {};          // thread → url → name → output pairs (ms)
    const longTasks = [];        // coalesced [ms_start, ms_end]

    function pushLongTask(msStart, msEnd) {
        if (!longTasks.length) { longTasks.push([msStart, msEnd]); return; }
        const last = longTasks[longTasks.length - 1];
        if (msStart >= last[1]) { longTasks.push([msStart, msEnd]); return; }
        if (msEnd > last[1]) {
            last[1] = msEnd;
            if (msStart < last[0]) last[0] = msStart;
        }
    }

    function adjustSlice(thread, sliceNumber, name, parentName, elapsed) {
        if (name === parentName) return;
        const fraction = Math.min(1.0, elapsed / sliceUsecs);
        const t = slices[thread];
        t[name][sliceNumber] += fraction;
        t.total[sliceNumber] += fraction;
        if (parentName !== null && t[parentName] && t[parentName][sliceNumber] >= fraction) {
            t[parentName][sliceNumber] -= fraction;
            t.total[sliceNumber] -= fraction;
        }
        if (t[name][sliceNumber] > 1.0) t[name][sliceNumber] = 1.0;
        if (t.total[sliceNumber] > 1.0) {
            let available = Math.max(0, 1.0 - fraction);
            for (const sliceName of Object.keys(t)) {
                if (sliceName === 'total' || sliceName === name) continue;
                t[sliceName][sliceNumber] = Math.min(t[sliceName][sliceNumber], available);
                available = Math.max(0, available - t[sliceName][sliceNumber]);
            }
            t.total[sliceNumber] = Math.min(1.0, Math.max(0, 1.0 - available));
        }
    }

    function walk(evt, parentName, stackUsed) {
        // Use `baseUs` as the slice origin so index 0 lines up with the HAR's page-zero.
        // Python uses `self.start_time` because wptagent's page_start_time == start_time;
        // for Chrome traces the netlog can start before navigation, so we key off base and
        // let the leading slices remain empty.
        const relStart = evt.s - baseUs;
        const relEnd = evt.e - baseUs;
        if (relEnd <= relStart) return;
        const elapsed = relEnd - relStart;
        const thread = evt.t;
        const name = eventNameLookup[evt.n];

        // Long tasks: top-level events on any tracked main-thread candidate, >= 50 ms.
        if (parentName === null && elapsed > 50000 && mainThreadCandidates.has(thread)) {
            pushLongTask(Math.floor(relStart / 1000), Math.ceil(relEnd / 1000));
        }

        // JS attribution: produce [start_ms, end_ms] pairs per (thread, url, eventName).
        // De-dup by inherited stack — if an ancestor event already covers this exact
        // (url, name) span, skip it (trace_parser.py L836-L844).
        let nextStack = stackUsed;
        if (evt.js) {
            const url = evt.js;
            const jsStart = relStart / 1000;
            const jsEnd = relEnd / 1000;
            if (!scripts[thread]) scripts[thread] = {};
            const perUrl = scripts[thread][url] || (scripts[thread][url] = {});
            const perName = perUrl[name] || (perUrl[name] = []);

            let localStack = stackUsed;
            const tu = localStack[thread];
            const priorPeriods = tu && tu[url] && tu[url][name];
            let covered = false;
            if (priorPeriods) {
                for (const p of priorPeriods) {
                    if (p.length >= 2 && jsStart >= p[0] && jsEnd <= p[1]) { covered = true; break; }
                }
            }
            if (!covered) {
                perName.push([jsStart, jsEnd]);
                // Shallow clone of stackUsed so sibling recursion doesn't see each other.
                nextStack = { ...stackUsed };
                const threadStackCopy = nextStack[thread] ? { ...nextStack[thread] } : {};
                nextStack[thread] = threadStackCopy;
                const urlStackCopy = threadStackCopy[url] ? { ...threadStackCopy[url] } : {};
                threadStackCopy[url] = urlStackCopy;
                urlStackCopy[name] = (urlStackCopy[name] || []).concat([[jsStart, jsEnd]]);
            }
        }

        // Slice aggregation.
        const first = Math.floor(relStart / sliceUsecs);
        const last = Math.floor(relEnd / sliceUsecs);
        for (let s = first; s <= last && s < finalSliceCount; s++) {
            if (s < 0) continue;
            const sliceStart = s * sliceUsecs;
            const sliceEnd = sliceStart + sliceUsecs;
            const usedStart = Math.max(sliceStart, relStart);
            const usedEnd = Math.min(sliceEnd, relEnd);
            const sliceElapsed = usedEnd - usedStart;
            if (sliceElapsed > 0) adjustSlice(thread, s, name, parentName, sliceElapsed);
        }

        if (evt.c) {
            for (const child of evt.c) walk(child, name, nextStack);
        }
    }

    for (const evt of timelineEvents) walk(evt, null, {});

    // Merge `toplevel` RunTask durations into long tasks. Only the subset that ran on
    // one of the main-thread candidates counts — we ignore ThreadPool_RunTask work on
    // worker threads, because "Long Tasks" in WPT waterfall semantics is specifically
    // main-thread blocking time. This has to run after the timelineEvents walk so
    // `pushLongTask` can coalesce with whatever the devtools-stack path emitted.
    //
    // Candidate set is intentionally generous (every thread the streaming pass flagged
    // as a main-thread candidate) — narrowing to the single picked `bestThread` runs
    // below. Until that pick happens we take every candidate's long tasks, then filter
    // at the end.
    if (Array.isArray(toplevelTasks) && toplevelTasks.length) {
        toplevelTasks.sort((a, b) => a.ts - b.ts);
        for (const t of toplevelTasks) {
            const thread = `${t.pid}:${t.tid}`;
            if (!mainThreadCandidates.has(thread)) continue;
            const relStart = t.ts - baseUs;
            const relEnd = relStart + t.dur;
            if (relEnd <= 0) continue;
            pushLongTask(Math.floor(Math.max(0, relStart) / 1000), Math.ceil(relEnd / 1000));
        }
        // pushLongTask assumed monotonic input; after merging two sources we need a
        // final sort + re-coalesce to keep the array clean.
        longTasks.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const lt of longTasks) {
            if (merged.length && lt[0] <= merged[merged.length - 1][1]) {
                if (lt[1] > merged[merged.length - 1][1]) merged[merged.length - 1][1] = lt[1];
            } else {
                merged.push(lt);
            }
        }
        longTasks.length = 0;
        longTasks.push(...merged);
    }

    // Convert float fractions to integer µs (drop the `total` tracker along the way).
    for (const thread of Object.keys(slices)) {
        delete slices[thread].total;
        for (const name of Object.keys(slices[thread])) {
            const arr = slices[thread][name];
            for (let i = 0; i < arr.length; i++) arr[i] = Math.round(arr[i] * sliceUsecs);
        }
    }

    // Pick the primary main thread: candidate with the most cumulative CPU. Mirrors
    // trace_parser.py L745-L764. Subframes are NOT excluded — Python doesn't filter them
    // either, and dropping them would lose main-thread activity on single-process traces
    // where the document itself is labelled Subframe. Falls back to any tracked thread
    // if no candidates produced measurable work.
    let candidates = [...mainThreadCandidates].filter(t => slices[t]);
    if (candidates.length === 0) candidates = Object.keys(slices);
    let bestThread = null;
    let bestTotal = -1;
    for (const t of candidates) {
        let total = 0;
        for (const arr of Object.values(slices[t])) {
            for (const v of arr) total += v;
        }
        if (total > bestTotal) { bestTotal = total; bestThread = t; }
    }
    if (!bestThread && mainThread && slices[mainThread]) bestThread = mainThread;

    const cpu = {
        main_thread: bestThread,
        main_threads: [...mainThreadCandidates],
        subframes: [...subframePids],
        valid: true,
        total_usecs: spanUs,
        slice_usecs: sliceUsecs,
        slices
    };

    const scriptsOut = Object.keys(scripts).length ? { main_thread: bestThread, ...scripts } : null;

    return { cpu, scripts: scriptsOut, longTasks };
}

export async function processChromeTraceFileNode(input, options = {}) {

    let stream = input;
    let isGz = options.isGz === true;
    let hasTraceEventsWrapper = options.hasTraceEventsWrapper === true;
    let nodeFsStream = null;
    let reader = null;

    const onProgress = options.onProgress || (() => {});
    const totalBytes = options.totalBytes || 0;

    const keepAlive = globalThis.setInterval ? globalThis.setInterval(() => {}, 1000) : null;

    try {
        if (typeof input === 'string') {
            const fs = await import(/* @vite-ignore */ 'node:fs');

            const header = new Uint8Array(2);
            try {
                const fd = fs.openSync(input, 'r');
                fs.readSync(fd, header, 0, 2, 0);
                fs.closeSync(fd);
            } catch (e) {
                throw e;
            }

            isGz = isGzip(header);

            // Only peek if wrapper state isn't explicitly passed.
            // When called via the Conductor/orchestrator, hasTraceEventsWrapper is already
            // detected during format sniffing. This path only fires from standalone CLI usage.
            if (options.hasTraceEventsWrapper === undefined) {
                const { Readable } = await import(/* @vite-ignore */ 'node:stream');
                let peekFsStream = fs.createReadStream(input);
                let peekWebStream = Readable.toWeb(peekFsStream);
                if (isGz) {
                    peekWebStream = peekWebStream.pipeThrough(new DecompressionStream('gzip'));
                }
                const peekReader = peekWebStream.pipeThrough(new TextDecoderStream()).getReader();
                let prefix = '';
                try {
                    // Scan up to 64KB (matches orchestrator's sniff window). DevTools-saved
                    // traces put `{"metadata":{...}}` before `traceEvents`, so a 30-char
                    // peek would miss the wrapper and we'd stream `$.*` instead of
                    // `$.traceEvents.*`, extracting nothing.
                    while (prefix.length < 65536) {
                        const { done, value } = await peekReader.read();
                        if (done) break;
                        prefix += value;
                    }
                } finally {
                    try { peekReader.cancel(); } catch (e) {}
                    peekFsStream.destroy();
                }
                hasTraceEventsWrapper = prefix.replace(/\s/g, '').includes('"traceEvents":[');
            }

            const { Readable } = await import(/* @vite-ignore */ 'node:stream');
            nodeFsStream = fs.createReadStream(input);
            stream = Readable.toWeb(nodeFsStream);
        }

        if (isGz) {
            stream = stream.pipeThrough(new DecompressionStream('gzip'));
        }

        const netlog = new Netlog();
        const timeline_requests = {};
        // Tracks whether a `cat: netlog` event was ever seen. When false, the trace has no
        // netlog coverage and we have to synthesize every request from devtools.timeline alone
        // (with stricter quality gates). When true, netlog is the source of truth and
        // timeline serves only to enrich netlog entries with priority / initiator / render
        // blocking / JS timing overlays — timeline-only synthesis is reserved for the rare
        // case where a request appears in devtools but not in netlog at all.
        let netlog_event_count = 0;

        // `toplevel` RunTask captures. Trace events in the `toplevel` / `ipc,toplevel`
        // categories wrap the synchronous work on a message-loop tick; their duration IS
        // the task's wall-clock duration. Modern Chrome traces captured through the
        // DevTools Performance panel (as opposed to wptagent) rarely have any
        // `devtools.timeline` events that are themselves ≥ 50 ms — the work lives in
        // short nested child events under a long `ThreadControllerImpl::RunTask`. So for
        // long-task detection we collect tasks from `toplevel` separately and pick the
        // subset that ran on a main-thread candidate after the stack replay has chosen
        // the primary `main_thread`. Slice aggregation still ignores `toplevel` because
        // nesting it with `devtools.timeline` children would double-count CPU.
        const toplevel_tasks = [];

        // Raw `devtools.timeline` / `blink.resource` events captured for the WriteCPUSlices +
        // WriteScriptTimings port. Stored minimally (only the fields the stack-replay and JS
        // attribution in `buildMainThreadActivity` need) to keep the accumulator under control
        // on large traces — theverge ships ~300k timeline events across 20+ threads.
        const raw_timeline_events = [];
        const thread_names = new Map();        // `pid:tid` → thread_name from __metadata
        const subframe_pids = new Set();       // pids the browser labelled `Subframe:`
        const cr_renderer_threads = new Set(); // threads named CrRendererMain
        let marker_main_thread = null;         // `pid:tid` of ResourceSendRequest=wpt-start-recording
        let first_nav_main_thread = null;      // `pid:tid` of earliest navigationStart/fetchStart

        let start_time = null;
        let marked_start_time = null;
        let pageTimings = { onLoad: -1, onContentLoad: -1, _startRender: -1 };
        let custom_user_marks = {};

        // Wall-clock epoch estimation: Chrome traces use CLOCK_MONOTONIC (system uptime)
        // for all ts values. We need a real UNIX epoch for HAR startedDateTime generation.
        // Strategy: extract the first HTTP "date:" response header from netlog events,
        // pair it with the monotonic ts at which the response was received, and compute
        // the offset (real_epoch_us - monotonic_ts_us). This offset converts any monotonic
        // timestamp to real wall-clock time.
        let monotonicToEpochOffsetUs = null; // microseconds: add to monotonic ts to get epoch

        const targetPaths = hasTraceEventsWrapper ? ['$.traceEvents.*'] : ['$.*'];
        const parser = new JSONParser({ paths: targetPaths, keepStack: false });

        parser.onValue = ({ value: trace_event }) => {
            try {
                if (trace_event.ts) trace_event.ts = parseInt(trace_event.ts);
                const cat = trace_event.cat || '';
                const name = trace_event.name || '';
                const ph = trace_event.ph || '';
                const args = trace_event.args;
                const data = args && args.data ? args.data : null;

                // 1. Process Netlog
                if (cat === 'netlog' || cat.includes('netlog')) {
                    netlog_event_count++;
                    netlog.addTraceEvent(trace_event);
                    return;
                }

                // 1b. Capture `toplevel` RunTask durations for long-task detection. We
                //     only record `ph: 'X'` (complete w/ dur) events ≥ 50 ms — anything
                //     shorter isn't a long task, and B/E pairs in `toplevel` are rare in
                //     practice (Chrome emits the whole task as a single X event).
                //
                //     Filtering here (in the streaming callback) instead of in the
                //     post-pass lets us drop the hundreds of thousands of short
                //     RunTasks before they ever enter memory.
                if (cat === 'toplevel' || cat === 'ipc,toplevel') {
                    if (ph === 'X' && typeof trace_event.dur === 'number' && trace_event.dur >= 50000) {
                        toplevel_tasks.push({
                            ts: trace_event.ts,
                            dur: trace_event.dur,
                            pid: trace_event.pid,
                            tid: trace_event.tid
                        });
                    }
                    return;
                }

                // 0. Thread metadata — needed before main-thread selection runs.
                //    Chrome emits these as `ph: 'M'` with `cat: '__metadata'`. `thread_name`
                //    is the recorded human-readable thread identifier (we key off
                //    `CrRendererMain`); `process_labels` flagging `Subframe:` marks the pid
                //    as a subframe so its renderer thread doesn't outrank the outermost main
                //    frame when we pick `main_thread`.
                if (cat === '__metadata') {
                    const thread = `${trace_event.pid}:${trace_event.tid}`;
                    if (name === 'thread_name' && args && args.name) {
                        thread_names.set(thread, args.name);
                        if (args.name === 'CrRendererMain') cr_renderer_threads.add(thread);
                    } else if (name === 'process_labels' && args && typeof args.labels === 'string' && args.labels.startsWith('Subframe:')) {
                        subframe_pids.add(String(trace_event.pid));
                    }
                    return;
                }

                // 2. Process User Timings & Navigations
                if (cat.includes('blink.user_timing') || cat.includes('rail') || cat.includes('loading') || cat.includes('navigation')) {
                    if (marked_start_time === null && name.includes('navigationStart')) {
                        if (start_time === null || trace_event.ts < start_time) {
                            start_time = trace_event.ts;
                        }
                    }
                    // Mirror trace_parser.py's ProcessTraceEvent: the first navigationStart /
                    // fetchStart pins the main thread if one isn't already locked in via
                    // the devtools.timeline path below.
                    if ((name === 'navigationStart' || name === 'fetchStart') && first_nav_main_thread === null) {
                        first_nav_main_thread = `${trace_event.pid}:${trace_event.tid}`;
                    }
                    if (name.includes('domContentLoadedEventStart') || name === 'domContentLoaded') {
                        if (start_time !== null) pageTimings.onContentLoad = trace_event.ts;
                    }
                    if (name.includes('loadEventStart') || name === 'load') {
                        if (start_time !== null) pageTimings.onLoad = trace_event.ts;
                    }
                    if (name.includes('firstContentfulPaint') || name === 'firstContentfulPaint') {
                        if (start_time !== null) {
                            pageTimings._startRender = trace_event.ts;
                            pageTimings._firstContentfulPaint = trace_event.ts;
                        }
                    }
                    if (name.includes('largestContentfulPaint::Candidate') || name === 'largestContentfulPaint::Candidate') {
                        if (start_time !== null) pageTimings._LargestContentfulPaint = trace_event.ts;
                    }
                    if (name === 'LayoutShift' && trace_event.args && trace_event.args.data && trace_event.args.data.score) {
                        pageTimings._CumulativeLayoutShift = (pageTimings._CumulativeLayoutShift || 0) + trace_event.args.data.score;
                    }
                    // Capture generic user marks (usually blink.user_timing)
                    if (cat.includes('blink.user_timing') && start_time !== null && trace_event.ts >= start_time) {
                        const standardIgnores = new Set(['navigationStart', 'domContentLoadedEventStart', 'domContentLoaded', 'loadEventStart', 'load', 'firstContentfulPaint', 'firstPaint', 'largestContentfulPaint::Candidate']);
                        if (!standardIgnores.has(name) && !name.startsWith('requestStart')) {
                            // Only capture instantaneous Marks (phase 'R', 'I' or just simple markers) or Starts
                            if (trace_event.ph === 'R' || trace_event.ph === 'I' || trace_event.ph === 'b') {
                                custom_user_marks[name] = trace_event.ts;
                            }
                        }
                    }
                }
                
                // 3. Process Timeline requests
                if (cat === 'devtools.timeline' || cat.includes('devtools.timeline') || cat.includes('blink.resource')) {
                    if (name === 'ResourceSendRequest' && data && data.url === 'http://127.0.0.1:8888/wpt-start-recording') {
                        marked_start_time = trace_event.ts;
                        start_time = trace_event.ts;
                        marker_main_thread = `${trace_event.pid}:${trace_event.tid}`;
                    }

                    // Capture the raw event for later stack-replay (WriteCPUSlices +
                    // WriteScriptTimings port). Filter to phases that contribute to
                    // duration accounting — 'X' (complete w/ dur) and 'B'/'E' pairs —
                    // plus instantaneous ResourceSend/Receive signals that the
                    // main-thread detector needs (`isMainFrame` + url).
                    if (ph === 'X' || ph === 'B' || ph === 'E' || name === 'ResourceSendRequest' || name === 'ResourceReceiveResponse') {
                        // Keep only the data fields the builder actually reads. Retaining
                        // the full `args` object balloons memory by 10× on theverge.
                        let slimData = null;
                        if (data) {
                            slimData = {};
                            if (data.url !== undefined) slimData.url = data.url;
                            if (data.scriptName !== undefined) slimData.scriptName = data.scriptName;
                            if (data.isMainFrame !== undefined) slimData.isMainFrame = data.isMainFrame;
                        }
                        raw_timeline_events.push({
                            ph,
                            ts: trace_event.ts,
                            dur: trace_event.dur,
                            name,
                            pid: trace_event.pid,
                            tid: trace_event.tid,
                            data: slimData
                        });
                    }

                    let request_id = null;
                    let has_real_request_id = false;
                    if (trace_event.args && trace_event.args.data && trace_event.args.data.requestId) {
                        request_id = trace_event.args.data.requestId;
                        has_real_request_id = true;
                    } else if (trace_event.args && trace_event.args.url) {
                        // URL-only fallback. `blink.resource` fires prefetch/preload candidate
                        // events that never produce an actual network fetch (URL is present
                        // but no `requestId`). We keep them for URL-matching during netlog
                        // augmentation, but they are disqualified from timeline-only synthesis
                        // because there's no proof a real HTTP transaction ever started.
                        request_id = trace_event.args.url;
                    }

                    if (request_id) {
                        if (!timeline_requests[request_id]) timeline_requests[request_id] = { bytesIn: 0 };
                        const req = timeline_requests[request_id];
                        if (has_real_request_id) req.has_real_id = true;

                        if (trace_event.args && trace_event.args.url) req.url = trace_event.args.url;
                        
                        const data = trace_event.args && trace_event.args.data ? trace_event.args.data : null;
                        
                        if (name === 'ResourceSendRequest' && data) {
                            req.requestTime = trace_event.ts / 1000.0;
                            req.was_sent = true;
                            if (data.priority) {
                                req.priority = data.priority;
                                if (PRIORITY_MAP[req.priority]) req.priority = PRIORITY_MAP[req.priority];
                            }
                            if (data.renderBlocking !== undefined) req.renderBlocking = data.renderBlocking;
                            if (data.frame) req.frame = data.frame;
                            if (data.url && !req.url) req.url = data.url;
                            if (data.requestMethod) req.method = data.requestMethod;
                            if (data.initiator) req.initiator = data.initiator;
                            if (data.resourceType) req.resourceType = data.resourceType;
                            
                            if (data.headers) {
                                req.request_headers = [];
                                if (Array.isArray(data.headers)) {
                                    for (const h of data.headers) {
                                        req.request_headers.push(`${h.name}: ${h.value}`);
                                    }
                                } else {
                                    for (const [k, v] of Object.entries(data.headers)) {
                                        req.request_headers.push(`${k}: ${v}`);
                                    }
                                }
                            }
                        } else if (name === 'ResourceReceiveResponse' && data) {
                            req.had_response = true;
                            if (data.fromCache) req.from_cache = true;
                            if (data.fromServiceWorker) req.from_service_worker = true;
                            if (data.statusCode) req.status = data.statusCode;
                            if (data.mimeType) req.mimeType = data.mimeType;
                            if (data.protocol) req.protocol = data.protocol;
                            // Stash `responseTime` + event ts for the no-netlog epoch bridge
                            // below. Applied only when the trace has zero netlog coverage —
                            // otherwise the authoritative HTTP `date:` header wins.
                            if (req.responseMonotonicMs === undefined && typeof data.responseTime === 'number' && typeof trace_event.ts === 'number') {
                                req.responseEpochMs = data.responseTime;
                                req.responseMonotonicMs = trace_event.ts / 1000.0;
                            }
                            
                            if (data.headers) {
                                req.response_headers = [];
                                if (Array.isArray(data.headers)) {
                                    for (const h of data.headers) {
                                        req.response_headers.push(`${h.name}: ${h.value}`);
                                    }
                                } else {
                                    for (const [k, v] of Object.entries(data.headers)) {
                                        req.response_headers.push(`${k}: ${v}`);
                                    }
                                }
                            }
                            
                            if (data.timing) {
                                req.timing = data.timing;
                                // Fallback wall-clock extraction removed to natively protect trace_event.ts monotonic scaling cleanly.
                            }
                        } else if (name === 'ResourceReceivedData' && data) {
                            if (data.encodedDataLength) req.bytesIn += data.encodedDataLength;
                        } else if (name === 'ResourceFinish' && data) {
                            if (data.encodedDataLength && req.bytesIn === 0) req.bytesIn = data.encodedDataLength;
                            req.finishTime = data.finishTime ? data.finishTime * 1000 : trace_event.ts / 1000.0;
                        } else if (name === 'Network.requestIntercepted' && data && data.overwrittenURL) {
                            req.overwrittenURL = data.overwrittenURL;
                        }
                    }
                }
                
            } catch (e) {
                // Ignore single event errors
            }
        };
        
        const pipeline = stream.pipeThrough(new TextDecoderStream());
        reader = pipeline.getReader();

        onProgress('Parsing trace...', 0);
        let bytesRead = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesRead += value.length;
            parser.write(value);
            if (totalBytes > 0) onProgress('Parsing trace...', Math.round((bytesRead / totalBytes) * 80));
        }
        onProgress('Processing events...', 80);
        if (options.debug) console.log(`[chrome-trace.js] Finished reading stream stream.`);

        // No netlog in the trace (DevTools Performance panel captures). Bridge
        // CLOCK_MONOTONIC → epoch using the first `ResourceReceiveResponse`'s
        // `responseTime` (ms epoch) paired with its monotonic `ts`. Without
        // this the downstream `final_start_time` fallback is `Date.now()`,
        // which shifts every entry's absolute timings to the current wall
        // clock (wrong day, harmless) and — more importantly — leaves
        // `_connectTimeMs` etc. anchored to today instead of the capture.
        // Traces WITH netlog keep using the HTTP `date:` response header
        // (netlog.dateHeaderEpoch is authoritative in that case).
        if (netlog_event_count === 0 && !netlog.dateHeaderEpoch) {
            for (const tl of Object.values(timeline_requests)) {
                if (typeof tl.responseEpochMs === 'number' && typeof tl.responseMonotonicMs === 'number') {
                    netlog.dateHeaderEpoch = { epochMs: tl.responseEpochMs, monotonicMs: tl.responseMonotonicMs };
                    break;
                }
            }
        }

        const results = netlog.postProcessEvents();
        let requests = results ? (results.requests || []) : [];
        let unlinked_sockets = results ? (results.unlinked_sockets || []) : [];
        let unlinked_dns = results ? (results.unlinked_dns || []) : [];
        
        // Correct massive divergence offsets where Perfetto maps timeline threads natively as Epoch but network threads as Monotonic Uptime natively.
        let timeline_epoch_offset_ms = 0;
        for (const tl of Object.values(timeline_requests)) {
             if (tl.requestTime !== undefined && tl.timing && tl.timing.requestTime) {
                 const opaqueMs = tl.timing.requestTime * 1000.0;
                 const diffMs = opaqueMs - tl.requestTime;
                 if (Math.abs(diffMs) > 60000) { timeline_epoch_offset_ms = diffMs; }
                 break;
             }
        }
        
        if (timeline_epoch_offset_ms !== 0) {
            for (const [reqId, tl_req] of Object.entries(timeline_requests)) {
                // The base bounds (requestTime, finishTime) are already correctly zero-indexed.
                // The inner `timing` block natively preserves the massive OS clock string in args.
                // Thus, we subtract the massive diff to zero-index the inner timing array natively.
                if (tl_req.timing && tl_req.timing.requestTime) {
                    tl_req.timing.requestTime -= (timeline_epoch_offset_ms / 1000.0);
                }
                
                // DevTools natively stamps `finishTime` as monotonic uptime bounds exactly mirroring timeline alignments natively
                if (tl_req.finishTime && tl_req.finishTime > 10000000) {
                     tl_req.finishTime -= timeline_epoch_offset_ms;
                }
            }
        }

        // Every candidate below must be a finite number — `netlog.start_time` is
        // `null` when the trace has no netlog events (DevTools Performance panel
        // captures), and `null < anything` coerces to `0 < anything`, which would
        // silently poison base_time_microseconds to `null` and make every entry's
        // `_start` equal to its raw CLOCK_MONOTONIC timestamp.
        //
        // Noise URLs (chrome://tracing buffer polls, wptagent bootstrap, browser
        // extensions) are filtered out of the HAR downstream, but they still
        // appear in `timeline_requests`. If one fires before the first real
        // navigation — the chrome://tracing DevTools panel polls its own buffer
        // every few seconds — it would otherwise pull the page anchor backwards
        // and push every real request forward by that delta on the waterfall.
        // Only real network requests anchor the page start. Two classes of
        // timeline_requests would otherwise pull it backwards and push every
        // real request to the right on the waterfall:
        //   1. Noise URLs — chrome://tracing (DevTools panel buffer polls), the
        //      wptagent bootstrap probe, and chrome-extension:// traffic all
        //      get filtered out of the HAR downstream but remain in the
        //      timeline_requests map.
        //   2. Entries without a URL — blink.resource prefetch probes and
        //      stray ResourceReceiveResponse fragments whose ResourceSendRequest
        //      never fired. These also fail the synthesis gate below, so
        //      letting them influence the anchor anchors the page on something
        //      that isn't in the HAR.
        const baseTimeIsNoise = (u) => typeof u === 'string' && (
            u.startsWith('http://127.0.0.1:8888') || u.startsWith('chrome://tracing') || u.startsWith('chrome-extension://')
        );
        const baseTimeEligible = (tl) => typeof tl.url === 'string' && tl.url.length > 0 && !baseTimeIsNoise(tl.url);
        let base_time_microseconds = Number.MAX_VALUE;
        if (typeof start_time === 'number' && start_time < base_time_microseconds) base_time_microseconds = start_time;
        if (results && typeof results.start_time === 'number' && results.start_time < base_time_microseconds) base_time_microseconds = results.start_time;
        for (const tl of Object.values(timeline_requests)) {
            if (!baseTimeEligible(tl)) continue;
            if (typeof tl.requestTime === 'number' && (tl.requestTime * 1000.0) < base_time_microseconds) base_time_microseconds = tl.requestTime * 1000.0;
            if (tl.timing && typeof tl.timing.requestTime === 'number' && (tl.timing.requestTime * 1000000.0) < base_time_microseconds) base_time_microseconds = tl.timing.requestTime * 1000000.0;
        }
        if (base_time_microseconds === Number.MAX_VALUE) base_time_microseconds = 0;

        let final_start_time = base_time_microseconds / 1000.0;

        // Apply monotonic-to-epoch offset if we extracted one from HTTP date headers.
        // Chrome traces use CLOCK_MONOTONIC (system uptime) for timestamps. To produce
        // valid absolute epoch values we need a mapping from monotonic → real time.
        // The netlog parser extracts this from the first HTTP "date:" response header.
        if (final_start_time < 946684800000) { // looks like monotonic, not epoch
            if (netlog.dateHeaderEpoch) {
                // dateHeaderEpoch.epochMs = real wall-clock ms when the date header was received
                // dateHeaderEpoch.monotonicMs = monotonic ms of that same event
                // final_start_time is in monotonic ms, so shift it to epoch ms
                const offsetMs = netlog.dateHeaderEpoch.epochMs - netlog.dateHeaderEpoch.monotonicMs;
                final_start_time = final_start_time + offsetMs;
            } else {
                // No date header found in the trace; fall back to Date.now() which will
                // produce non-deterministic absolute timestamps but keeps the relative
                // timing correct.
                final_start_time = Date.now();
            }
        }

        // --------------------------------------------------------------------
        // Step 1: filter netlog-derived requests to those that actually went
        //         to the network. Chrome's URL_REQUEST lifecycle creates an
        //         entry for every *candidate* fetch — cache hits, prefetch
        //         probes, service worker intercepts, cancelled preloads, and
        //         transient redirect placeholders. None of those produce
        //         meaningful waterfall rows; we want only requests with
        //         proof of a real HTTP transaction.
        //
        //         "Proof" = a `start` timestamp (HTTP_TRANSACTION_SEND_REQUEST
        //         fired) AND at least one of: response headers were parsed,
        //         first-byte landed, bytes_in > 0, or `end` was recorded by
        //         URL_REQUEST_JOB_BYTES_READ. Anything short of that indicates
        //         the request never materialized over the wire.
        //
        //         Wptagent bootstrap traffic (http://127.0.0.1:8888/) and the
        //         DevTools UI's own fetches (chrome://tracing/…) are filtered
        //         out because they belong to the recording harness, not the
        //         page under test.
        // --------------------------------------------------------------------
        function isNoiseUrl(u) {
            if (typeof u !== 'string') return false;
            if (u.startsWith('http://127.0.0.1:8888')) return true;
            if (u.startsWith('chrome://tracing')) return true;
            if (u.startsWith('chrome-extension://')) return true;
            return false;
        }
        function netlogRequestHasNetworkActivity(r) {
            if (r.start === undefined) return false;
            if (r.response_headers && r.response_headers.length > 0) return true;
            if (r.first_byte !== undefined) return true;
            if (r.end !== undefined && r.end > r.start) return true;
            if (r.bytes_in !== undefined && r.bytes_in > 0) return true;
            return false;
        }
        const preFilterCount = requests.length;
        requests = requests.filter(r => !isNoiseUrl(r.url) && netlogRequestHasNetworkActivity(r));
        if (options.debug) console.log(`[chrome-trace.js] Filtered ${preFilterCount - requests.length} incomplete netlog requests (kept ${requests.length}).`);

        // Create a quick lookup for timeline requests by URL
        const timeline_by_url = new Map();
        for (const tl_req of Object.values(timeline_requests)) {
            if (tl_req.url) timeline_by_url.set(tl_req.url, tl_req);
            if (tl_req.overwrittenURL) timeline_by_url.set(tl_req.overwrittenURL, tl_req);
        }

        // Step 2: augment netlog requests with timeline data and mark matched
        // timeline entries so they don't get re-synthesized below. Matching
        // is by URL — the timeline `requestId` and the netlog `URL_REQUEST`
        // source id live in different ID spaces (devtools_requestId is
        // frame-local, netlog id is a C++ pointer), so URL is the only
        // reliable join key. This is fine for waterfall-level enrichment:
        // timeline only supplies priority / renderBlocking / initiator /
        // resourceType metadata we'd otherwise lack.
        const netlogUrlsPresent = new Set();
        for (const req of requests) {
            if (!req.url) continue;
            netlogUrlsPresent.add(req.url);
            const matched_timeline_req = timeline_by_url.get(req.url);

            if (matched_timeline_req) {
                matched_timeline_req._matched = true;
                if (matched_timeline_req.priority && !req.priority) req.priority = matched_timeline_req.priority;
                if (matched_timeline_req.renderBlocking !== undefined) req.renderBlocking = matched_timeline_req.renderBlocking;
                if (matched_timeline_req.frame) req.frame = matched_timeline_req.frame;
                if (matched_timeline_req.initiator) req.initiator = matched_timeline_req.initiator;
                if (req.type === undefined && matched_timeline_req.resourceType) req.type = matched_timeline_req.resourceType;
                if ((!req.bytesIn || req.bytesIn === 0) && matched_timeline_req.bytesIn) req.bytesIn = matched_timeline_req.bytesIn;
                if (!req.mimeType && matched_timeline_req.mimeType) req.mimeType = matched_timeline_req.mimeType;
                // If netlog couldn't parse a status line out of stored response_headers
                // (e.g. H2 / QUIC pseudo-headers were stripped, or netlog truncation),
                // inherit the statusCode the timeline observed on ResourceReceiveResponse.
                if ((req.status === undefined || req.status === 0) && matched_timeline_req.status) {
                    req.status = matched_timeline_req.status;
                }

                if ((!req.request_headers || req.request_headers.length === 0) && matched_timeline_req.request_headers && matched_timeline_req.request_headers.length > 0) {
                    req.request_headers = matched_timeline_req.request_headers;
                }
                if ((!req.response_headers || req.response_headers.length === 0) && matched_timeline_req.response_headers && matched_timeline_req.response_headers.length > 0) {
                    req.response_headers = matched_timeline_req.response_headers;
                }
            }
        }

        if (base_time_microseconds === 0) {
            let earliest_ms = Number.MAX_VALUE;
            for (const tl of Object.values(timeline_requests)) {
                if (tl.requestTime !== undefined && tl.requestTime < earliest_ms) {
                    earliest_ms = tl.requestTime; // in MILLISECONDS
                }
            }
            if (earliest_ms !== Number.MAX_VALUE) {
                base_time_microseconds = earliest_ms * 1000.0; // scale back to MICROSECONDS
                final_start_time = earliest_ms; // map back for HAR entries natively
            }
        }

        // Step 3: synthesize requests from devtools.timeline only.
        //
        // Two code paths land here:
        //   (a) netlog is present but some requests appear in devtools without
        //       a corresponding URL_REQUEST (iframe / subframe / worker traffic
        //       the netlog filter missed). We still want those, but only if
        //       the timeline proves a full send+receive cycle.
        //   (b) netlog is absent entirely (the user captured with the DevTools
        //       Performance panel or wptagent-without-netlog profile). Then
        //       this is the *only* source of request data, and the quality
        //       bar is the same: we refuse to emit a request unless it was
        //       actually sent and either got a response or had a proper
        //       network timing block.
        //
        // Quality gates shared by both paths:
        //   - Request had a real `requestId` (not just a URL lifted from a
        //     blink.resource prefetch probe event).
        //   - ResourceSendRequest fired (`was_sent`).
        //   - URL exists and isn't recording-harness / DevTools noise.
        //   - EITHER ResourceReceiveResponse fired AND status > 0, OR
        //     `tl_req.timing` was populated (full connect/send/wait breakdown)
        //     — this indicates the request reached the transport layer.
        //   - Not already represented by a netlog request with the same URL.
        let synthesized = 0;
        for (const [reqId, tl_req] of Object.entries(timeline_requests)) {
            if (tl_req._matched) continue;
            if (!tl_req.has_real_id) continue;
            if (!tl_req.was_sent) continue;
            if (tl_req.requestTime === undefined) continue;
            if (!tl_req.url || isNoiseUrl(tl_req.url)) continue;
            if (netlogUrlsPresent.has(tl_req.url)) continue;
            // Cache hits and service-worker-intercepted responses aren't network
            // requests — they never left the tab. Including them would double-count
            // resources that any netlog pass would (correctly) omit.
            if (tl_req.from_cache || tl_req.from_service_worker) continue;
            const hasStatus = typeof tl_req.status === 'number' && tl_req.status > 0;
            const hasTiming = tl_req.timing && tl_req.timing.requestTime;
            if (!(hasTiming || (tl_req.had_response && hasStatus))) continue;

            const r = {
                _id: reqId,
                netlog_id: reqId,
                url: tl_req.url,
                method: tl_req.method || 'GET',
                protocol: tl_req.protocol || '',
                status: tl_req.status || 0,
                priority: tl_req.priority || 'Lowest',
                renderBlocking: tl_req.renderBlocking,
                frame: tl_req.frame,
                initiator: tl_req.initiator,
                type: tl_req.resourceType,
                mimeType: tl_req.mimeType,
                bytesIn: tl_req.bytesIn || 0,
                request_headers: tl_req.request_headers || [],
                response_headers: tl_req.response_headers || []
            };

            // Expected bounds track strictly microsecond ranges relative to base arrays naturally.
            r.start = (tl_req.requestTime * 1000.0) - base_time_microseconds;
            r.end = ((tl_req.finishTime || tl_req.requestTime) * 1000.0) - base_time_microseconds;
            r.first_byte = r.end;

            if (tl_req.timing) {
                const rt = (tl_req.timing.requestTime * 1000000.0) - base_time_microseconds;
                r.start = rt;

                if (tl_req.timing.receiveHeadersEnd > 0) r.first_byte = rt + (tl_req.timing.receiveHeadersEnd * 1000.0);
                if (tl_req.timing.dnsStart >= 0) r.dns_start = rt + (tl_req.timing.dnsStart * 1000.0);
                if (tl_req.timing.dnsEnd >= 0) r.dns_end = rt + (tl_req.timing.dnsEnd * 1000.0);
                if (tl_req.timing.connectStart >= 0) r.connect_start = rt + (tl_req.timing.connectStart * 1000.0);
                if (tl_req.timing.connectEnd >= 0) r.connect_end = rt + (tl_req.timing.connectEnd * 1000.0);
                if (tl_req.timing.sslStart >= 0) r.ssl_start = rt + (tl_req.timing.sslStart * 1000.0);
                if (tl_req.timing.sslEnd >= 0) r.ssl_end = rt + (tl_req.timing.sslEnd * 1000.0);
            }

            requests.push(r);
            synthesized++;
        }

        if (options.debug) console.log(`[chrome-trace.js] Netlog requests: ${preFilterCount}→${requests.length - synthesized}; timeline-synthesized: ${synthesized}; netlog events seen: ${netlog_event_count}.`);

        // Scale ALL internal times from MICROSECONDS to MILLISECONDS since HAR mappings require ms natively.
        const scaleTimes = ['dns_start', 'dns_end', 'connect_start', 'connect_end', 'ssl_start', 'ssl_end', 'start', 'created', 'first_byte', 'end'];
        for (const req of requests) {
             for (const tname of scaleTimes) {
                 if (req[tname] !== undefined) req[tname] /= 1000.0;
             }
             if (req.chunks_in) { for (const c of req.chunks_in) if (c.ts !== undefined) c.ts /= 1000.0; }
             if (req.chunks_out) { for (const c of req.chunks_out) if (c.ts !== undefined) c.ts /= 1000.0; }
        }
        for (const s of unlinked_sockets) {
             for (const tname of scaleTimes) {
                 if (s[tname] !== undefined) s[tname] /= 1000.0;
             }
        }
        for (const d of unlinked_dns) {
             if (d.start !== undefined) d.start /= 1000.0;
             if (d.end !== undefined) d.end /= 1000.0;
        }

        // normalizeNetlogToHAR now takes the real wall-clock epoch ms for
        // the trace's earliest event. `final_start_time` is already in ms
        // — converted from monotonic via the HTTP "date:" header offset
        // earlier in this function — so we pass it through unchanged.
        const har = normalizeNetlogToHAR(requests, unlinked_sockets, unlinked_dns, final_start_time);
        
        // Add minimal layout mapping overrides for Chrome trace
        if (har.log && har.log.pages.length > 0) {
            const page = har.log.pages[0];
            page.title = 'Chrome Trace Default View';
            if (!page.pageTimings) page.pageTimings = {};
            if (pageTimings.onLoad > 0) page.pageTimings.onLoad = (pageTimings.onLoad - base_time_microseconds) / 1000.0;
            if (pageTimings.onContentLoad > 0) page.pageTimings.onContentLoad = (pageTimings.onContentLoad - base_time_microseconds) / 1000.0;
            if (pageTimings._startRender > 0) page.pageTimings._startRender = (pageTimings._startRender - base_time_microseconds) / 1000.0;
            if (pageTimings._firstContentfulPaint > 0) page._firstContentfulPaint = (pageTimings._firstContentfulPaint - base_time_microseconds) / 1000.0;
            if (pageTimings._LargestContentfulPaint > 0) page._LargestContentfulPaint = (pageTimings._LargestContentfulPaint - base_time_microseconds) / 1000.0;
            if (pageTimings._CumulativeLayoutShift > 0) page._CumulativeLayoutShift = pageTimings._CumulativeLayoutShift;
            
            if (Object.keys(custom_user_marks).length > 0) {
                page._userTimes = {};
                for (const [evtName, evtTs] of Object.entries(custom_user_marks)) {
                    page._userTimes[evtName] = (evtTs - base_time_microseconds) / 1000.0;
                }
            }

            // Main-thread flame chart + per-request JS execution overlays. Port of
            // wptagent's WriteCPUSlices / WriteScriptTimings (see buildMainThreadActivity
            // docstring). `startUs` is navigationStart when we know it, otherwise we fall
            // back to `base_time_microseconds` so the stack-replay has a sensible low bound.
            const startUs = start_time !== null ? start_time : base_time_microseconds;
            const metaMainThreads = new Set(cr_renderer_threads);
            if (marker_main_thread) metaMainThreads.add(marker_main_thread);
            if (first_nav_main_thread) metaMainThreads.add(first_nav_main_thread);
            const mt = buildMainThreadActivity(
                raw_timeline_events,
                base_time_microseconds,
                startUs,
                metaMainThreads,
                subframe_pids,
                toplevel_tasks
            );
            if (mt.cpu) {
                const folded = foldCpuSlices(mt.cpu);
                if (folded) page._mainThreadSlices = folded;
            }
            // Always attach `_longTasks` — even when empty — so the renderer can
            // distinguish "data source supports long-task detection but there
            // were none" (render the band as a fully-green interactive bar)
            // from "data source doesn't instrument long tasks at all" (omit the
            // band entirely). `mt.cpu` is the signal that the stack replay ran
            // successfully; we only attach when that path produced something,
            // otherwise there's no real evidence we'd have *seen* a long task.
            if (mt.cpu) {
                page._longTasks = Array.isArray(mt.longTasks) ? mt.longTasks : [];
            }
            if (mt.scripts) {
                // Walk script timings, flatten allowlisted event names per URL, attach to
                // the first matching HAR entry by URL. Mirrors the `$used` de-dup in
                // Sample/Implementations/webpagetest/www/waterfall.inc#L2004-L2011.
                const mainKey = mt.scripts.main_thread;
                const mainThreadScripts = mainKey && mt.scripts[mainKey];
                if (mainThreadScripts) {
                    const perUrl = {};
                    for (const [url, events] of Object.entries(mainThreadScripts)) {
                        const flat = [];
                        for (const ev of SCRIPT_TIMING_EVENTS) {
                            const pairs = events[ev];
                            if (!Array.isArray(pairs)) continue;
                            for (const pair of pairs) {
                                if (Array.isArray(pair) && pair.length >= 2
                                    && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
                                    flat.push([pair[0], pair[1]]);
                                }
                            }
                        }
                        if (flat.length) perUrl[url] = flat;
                    }
                    const used = new Set();
                    for (const entry of har.log.entries) {
                        const url = entry._full_url || (entry.request && entry.request.url);
                        if (!url || used.has(url)) continue;
                        const pairs = perUrl[url];
                        if (!pairs) continue;
                        entry._js_timing = pairs;
                        used.add(url);
                    }
                }
            }
        }
        
        if (options.debug) console.log(`[chrome-trace.js] Finished applying HAR generation successfully.`);
        
        // Use statically imported buildWaterfallDataFromHar
        return buildWaterfallDataFromHar(har.log, 'chrome-trace');

    } catch (e) {
        throw e;
    } finally {
        if (reader) try { reader.releaseLock(); } catch (e) {}
        if (keepAlive) globalThis.clearInterval(keepAlive);
        if (nodeFsStream) nodeFsStream.destroy();
    }
}
