/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

// Canonical WebPageTest flame-chart categories. Every trace-event name that Chrome emits is
// folded into one of these five buckets so the renderer only has to manage five colors. The
// mapping mirrors the reference PHP implementation at
// Sample/Implementations/webpagetest/www/waterfall.inc (lines 437-491) — keep them in sync.
export const MAIN_THREAD_CATEGORY_MAP = (() => {
    const map = new Map();
    const add = (category, names) => { for (const n of names) map.set(n, category); };
    add('ParseHTML', ['ParseHTML', 'ResourceReceivedData', 'ResourceSendRequest', 'ResourceReceivedResponse', 'ResourceReceiveResponse', 'ResourceFinish', 'CommitLoad']);
    add('Layout', ['Layout', 'RecalculateStyles', 'ParseAuthorStyleSheet', 'ScheduleStyleRecalculation', 'InvalidateLayout', 'UpdateLayoutTree']);
    add('Paint', ['Paint', 'PaintImage', 'PaintSetup', 'CompositeLayers', 'DecodeImage', 'Decode Image', 'ImageDecodeTask', 'Rasterize', 'GPUTask', 'SetLayerTreeId', 'layerId', 'UpdateLayer', 'UpdateLayerTree', 'Draw LazyPixelRef', 'Decode LazyPixelRef', 'PrePaint', 'Layerize']);
    add('EvaluateScript', ['EvaluateScript', 'EventDispatch', 'FunctionCall', 'GCEvent', 'TimerInstall', 'TimerFire', 'TimerRemove', 'XHRLoad', 'XHRReadyStateChange', 'v8.compile', 'MinorGC', 'MajorGC', 'FireAnimationFrame', 'ThreadState::completeSweep', 'Heap::collectGarbage', 'ThreadState::performIdleLazySweep']);
    return map;
})();

// Script-timing event names the renderer cares about. Mirrors `$script_events` in
// Sample/Implementations/webpagetest/www/waterfall.inc#L1976-L1993 — each matching
// [start_ms, end_ms] pair becomes a JS-execution overlay on the request's row.
export const SCRIPT_TIMING_EVENTS = new Set([
    'EvaluateScript',
    'v8.compile',
    'FunctionCall',
    'GCEvent',
    'TimerFire',
    'EventDispatch',
    'TimerInstall',
    'TimerRemove',
    'XHRLoad',
    'XHRReadyStateChange',
    'MinorGC',
    'MajorGC',
    'FireAnimationFrame',
    'ThreadState::completeSweep',
    'Heap::collectGarbage',
    'ThreadState::performIdleLazySweep'
]);

/**
 * Fold a wptagent-style CPU slices payload (`{main_thread, slice_usecs, total_usecs, slices:
 * {thread: {event_name: usecs[]}}}`) into the compact `_mainThreadSlices` form consumed by the
 * renderer: only the primary `main_thread` is kept and raw Chrome event names are collapsed into
 * the five canonical categories (`ParseHTML`, `Layout`, `Paint`, `EvaluateScript`, `other`).
 *
 * Values stay in microseconds per slice so the renderer can derive each slice's fraction-of-time
 * in a type as `value / slice_usecs` without further scaling (matches the reference PHP
 * AverageCpuSlices contract).
 */
export function foldCpuSlices(raw) {
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
