/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { WaterfallTools, identifyFormatFromBuffer, Layout } from 'waterfall-tools';
import { saveToHistory, getAllHistory, updateHistoryInfo, clearAllHistory } from './history.js';

const ui = {
    loading: document.getElementById('loading'),
    loadingText: document.getElementById('loading-text'),
    progressContainer: document.getElementById('progress-container'),
    progressBar: document.getElementById('progress-bar'),
    progressDetail: document.getElementById('progress-detail'),
    dropZone: document.getElementById('drop-zone'),
    canvasContainer: document.getElementById('canvas-container'),
    summaryView: document.getElementById('summary-view'),
    waterfallView: document.getElementById('waterfall-view'),
    fileInput: document.getElementById('file-input'),
    uploadBtn: document.getElementById('upload-btn'),
    tileView: document.getElementById('tile-view'),
    tileGrid: document.getElementById('tile-grid'),
    btnBackTiles: document.getElementById('btn-back-tiles'),
    btnSettings: document.getElementById('btn-settings'),
    settingsOverlay: document.getElementById('settings-overlay'),
    btnSettingsClose: document.getElementById('btn-settings-close'),
    viewerTitle: document.getElementById('viewer-title'),
    tabLighthouse: document.getElementById('tab-lighthouse'),
    lighthouseView: document.getElementById('lighthouse-view'),
    lighthouseFrame: document.getElementById('lighthouse-frame'),
    tabDevtools: document.getElementById('tab-devtools'),
    devtoolsView: document.getElementById('devtools-view'),
    devtoolsFrame: document.getElementById('devtools-frame'),
    devtoolsOverlay: document.getElementById('devtools-overlay'),
    devtoolsOverlayContent: document.getElementById('devtools-overlay-content'),
    tabTrace: document.getElementById('tab-trace'),
    traceView: document.getElementById('trace-view'),
    traceFrame: document.getElementById('trace-frame'),
    traceOverlay: document.getElementById('trace-overlay'),
    traceOverlayContent: document.getElementById('trace-overlay-content'),
    tabNetlog: document.getElementById('tab-netlog'),
    netlogView: document.getElementById('netlog-view'),
    netlogFrame: document.getElementById('netlog-frame'),
    netlogOverlay: document.getElementById('netlog-overlay'),
    netlogOverlayContent: document.getElementById('netlog-overlay-content'),
    viewerTabs: document.getElementById('viewer-tabs'),
    tabsScrollWrapper: document.getElementById('tabs-scroll-wrapper'),
    hamburgerBtn: document.getElementById('hamburger-btn'),
    btnCloseTab: document.getElementById('btn-close-tab'),
    labelsSlider: document.getElementById('labels-slider'),
    labelsSliderContent: document.getElementById('labels-slider-content'),
    labelsSliderToggle: document.getElementById('labels-slider-toggle'),
    historyBtn: document.getElementById('history-btn'),
    historyView: document.getElementById('history-view'),
    historyFilter: document.getElementById('history-filter'),
    historyPageSize: document.getElementById('history-page-size'),
    historyPrevBtn: document.getElementById('history-prev-btn'),
    historyNextBtn: document.getElementById('history-next-btn'),
    historyPageInfo: document.getElementById('history-page-info'),
    historyTable: document.getElementById('history-table'),
    historyTbody: document.getElementById('history-tbody'),
    historyClearBtn: document.getElementById('history-clear-btn')
};

let waterfallTool = null;
let rendererCanvas = null;
let activeBlobUrls = [];
let pendingTabLoads = {};

function loadTracePerfetto(traceBuffer) {
    ui.traceOverlay.style.display = 'flex';
    ui.traceOverlayContent.innerText = 'Loading Trace Viewer...';
    
    if (ui.traceFrame.src === 'about:blank' || !ui.traceFrame.src) {
        ui.traceFrame.src = 'https://ui.perfetto.dev';
    }

    const ORIGIN = 'https://ui.perfetto.dev';
    let loaded = false;
    let pingInterval;

    const onMessage = (e) => {
        if (e.origin !== ORIGIN) return;
        if (e.data === 'PONG') {
            if (!loaded) {
                loaded = true;
                clearInterval(pingInterval);
                ui.traceOverlayContent.innerText = 'Loading Trace Data...';
                ui.traceFrame.contentWindow.postMessage({
                    perfetto: {
                        buffer: traceBuffer,
                        title: 'WaterfallTools Trace'
                    }
                }, ORIGIN);
                
                setTimeout(() => {
                    ui.traceOverlay.style.display = 'none';
                    window.removeEventListener('message', onMessage);
                }, 1500);
            }
        }
    };
    
    window.addEventListener('message', onMessage);

    pingInterval = setInterval(() => {
        if (ui.traceFrame && ui.traceFrame.contentWindow) {
            ui.traceFrame.contentWindow.postMessage('PING', ORIGIN);
        }
    }, 500);

    const onLoad = () => {
        if (ui.traceFrame && ui.traceFrame.contentWindow && !loaded) {
            ui.traceFrame.contentWindow.postMessage('PING', ORIGIN);
        }
    };
    ui.traceFrame.addEventListener('load', onLoad, { once: true });
}

function getDevtoolsPath() {
    // The build script (prod) and vite.dev.config.js (dev) both populate this meta tag
    // with the relative URL of the versioned devtools bundle, e.g. "./devtools-1.20260412.0/".
    const meta = document.querySelector('meta[name="waterfall-devtools-path"]');
    const val = meta && meta.getAttribute('content');
    return val ? val : null;
}

function loadDevtools() {
    const path = getDevtoolsPath();
    if (!path || !ui.devtoolsFrame) return;

    ui.devtoolsOverlay.style.display = 'flex';
    ui.devtoolsOverlayContent.innerText = 'Loading DevTools...';

    const target = path + 'index.html';
    if (ui.devtoolsFrame.src === 'about:blank' || !ui.devtoolsFrame.src || !ui.devtoolsFrame.src.endsWith(target.replace(/^\.\//, ''))) {
        ui.devtoolsFrame.src = target;
    }

    const onLoad = () => {
        // Give the frontend a moment to initialize before hiding the overlay
        setTimeout(() => {
            ui.devtoolsOverlay.style.display = 'none';
        }, 300);
    };
    ui.devtoolsFrame.addEventListener('load', onLoad, { once: true });
}

function loadNetlog(netlogBuffer) {
    ui.netlogOverlay.style.display = 'flex';
    ui.netlogOverlayContent.innerText = 'Loading netlog viewer...';
    
    if (ui.netlogFrame.src === 'about:blank' || !ui.netlogFrame.src) {
        ui.netlogFrame.src = 'netlog-viewer/index.html';
    }

    let loaded = false;

    const onLoad = async () => {
        if (loaded) return;
        ui.netlogOverlayContent.innerText = 'Loading Netlog Data...';
        
        let finalBuffer = netlogBuffer;
        try {
            const uint8View = netlogBuffer instanceof Uint8Array ? netlogBuffer : new Uint8Array(netlogBuffer);
            // Check for gzip magic bytes
            if (uint8View.length > 2 && uint8View[0] === 0x1f && uint8View[1] === 0x8b) {
                ui.netlogOverlayContent.innerText = 'Decompressing Netlog...';
                const ds = new DecompressionStream('gzip');
                const writer = ds.writable.getWriter();
                writer.write(uint8View);
                writer.close();
                const response = new Response(ds.readable);
                finalBuffer = await response.arrayBuffer();
            }
        } catch (e) {
            console.error('[viewer.js] Failed to decompress netlog buffer:', e);
        }

        ui.netlogOverlayContent.innerText = 'Parsing Netlog Data...';

        // Use timeout to let the external viewer finish parsing the DOM and initializing globals
        setTimeout(() => {
            try {
                const cw = ui.netlogFrame.contentWindow;
                if (cw && cw.window && cw.window.ImportView) {
                    const iv = cw.window.ImportView.getInstance();
                    
                    // Intercept the final asynchronous phase of FileReader natively loading the file
                    const originalOnLoad = iv.onLoadLogFile;
                    iv.onLoadLogFile = function(logFile, event) {
                        originalOnLoad.call(iv, logFile, event);
                        cw.window.location.hash = '#events';
                        
                        // Drop the overlay only after the massive table DOM updates are fully rendered
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                ui.netlogOverlay.style.display = 'none';
                            });
                        });
                    };

                    const file = new File([finalBuffer], 'netlog.json', {type: 'application/json'});
                    iv.loadLogFile(file);
                    loaded = true;
                } else {
                    console.warn('[viewer.js] Error invoking Netlog Viewer: ImportView not found on window');
                    ui.netlogOverlay.style.display = 'none';
                }
            } catch (e) {
                console.warn('[viewer.js] Error invoking Netlog Viewer API:', e);
                ui.netlogOverlay.style.display = 'none';
            }
        }, 1000);
    };

    ui.netlogFrame.addEventListener('load', onLoad, { once: true });
    
    // In case of rapid toggling where the iframe is already loaded
    if (ui.netlogFrame.contentWindow && ui.netlogFrame.contentWindow.document && ui.netlogFrame.contentWindow.document.readyState === 'complete' && ui.netlogFrame.src !== 'about:blank' && ui.netlogFrame.src !== '') {
        onLoad();
    }
}

function showLoading(text = 'Loading...') {
    ui.loadingText.textContent = text;
    ui.loading.classList.remove('hidden');
    ui.dropZone.classList.add('hidden');
    ui.canvasContainer.classList.add('hidden');
    ui.tileView.classList.add('hidden');
    // Reset progress bar to hidden state
    ui.progressContainer.classList.add('hidden');
    ui.progressDetail.classList.add('hidden');
    ui.progressBar.style.width = '0%';
    ui.progressDetail.textContent = '';
}

/**
 * Updates the progress bar during file processing.
 * @param {string} phase - Description of current processing phase
 * @param {number} percent - 0-100 progress value
 */
function updateProgress(phase, percent) {
    // Show the progress elements on first call
    if (ui.progressContainer.classList.contains('hidden')) {
        ui.progressContainer.classList.remove('hidden');
        ui.progressDetail.classList.remove('hidden');
    }
    ui.loadingText.textContent = phase;
    ui.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

function hideLoading() {
    ui.loading.classList.add('hidden');
    ui.progressContainer.classList.add('hidden');
    ui.progressDetail.classList.add('hidden');
}

function showError(msg) {
    ui.loading.classList.remove('hidden');
    ui.loading.innerHTML = `<div class="upload-content"><h2 style="color:#d32f2f">Error</h2><p>${msg}</p></div>`;
}

async function fileToReadable(file) {
    return file.stream();
}

function getOptionsFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const options = WaterfallTools.getDefaultOptions();
    
    if (params.has('pageId')) options.pageId = params.get('pageId');
    if (params.has('page')) options.pageId = params.get('page');
    if (params.has('connectionView')) options.connectionView = params.get('connectionView') === 'true' || params.get('connectionView') === '1';
    if (params.has('thumbnailView')) options.thumbnailView = params.get('thumbnailView') === 'true' || params.get('thumbnailView') === '1';
    if (params.has('minWidth')) options.minWidth = parseInt(params.get('minWidth'), 10);
    if (params.has('startTime')) options.startTime = parseFloat(params.get('startTime'));
    if (params.has('endTime')) options.endTime = parseFloat(params.get('endTime'));
    if (params.has('reqFilter')) options.reqFilter = params.get('reqFilter');
    if (params.has('showPageMetrics')) options.showPageMetrics = params.get('showPageMetrics') !== 'false' && params.get('showPageMetrics') !== '0';
    if (params.has('showMarks')) options.showMarks = params.get('showMarks') !== 'false' && params.get('showMarks') !== '0';
    if (params.has('showCpu')) options.showCpu = params.get('showCpu') !== 'false' && params.get('showCpu') !== '0';
    if (params.has('showBw')) options.showBw = params.get('showBw') !== 'false' && params.get('showBw') !== '0';
    if (params.has('showMainthread')) options.showMainthread = params.get('showMainthread') !== 'false' && params.get('showMainthread') !== '0';
    if (params.has('showLongtasks')) options.showLongtasks = params.get('showLongtasks') !== 'false' && params.get('showLongtasks') !== '0';
    if (params.has('showMissing')) options.showMissing = params.get('showMissing') !== 'false' && params.get('showMissing') !== '0';
    if (params.has('showLabels')) options.showLabels = params.get('showLabels') !== 'false' && params.get('showLabels') !== '0';
    if (params.has('showChunks')) options.showChunks = params.get('showChunks') !== 'false' && params.get('showChunks') !== '0';
    if (params.has('showJsTiming')) options.showJsTiming = params.get('showJsTiming') !== 'false' && params.get('showJsTiming') !== '0';
    if (params.has('showWait')) options.showWait = params.get('showWait') !== 'false' && params.get('showWait') !== '0';
    if (params.has('showLegend')) options.showLegend = params.get('showLegend') !== 'false' && params.get('showLegend') !== '0';
    if (params.has('thumbMaxReqs')) options.thumbMaxReqs = parseInt(params.get('thumbMaxReqs'), 10);

    if (params.has('options')) {
        const optsKeyVals = params.get('options').split(',');
        for (const kv of optsKeyVals) {
            const colonIdx = kv.indexOf(':');
            if (colonIdx > 0) {
                const key = kv.substring(0, colonIdx).trim();
                let val = decodeURIComponent(kv.substring(colonIdx + 1).trim());
                if (val === 'true') val = true;
                else if (val === 'false') val = false;
                else if (!isNaN(val) && val !== '') val = Number(val);
                options[key] = val;
            }
        }
    }

    return options;
}

function humanizeBytes(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return null;
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function humanizeMs(ms) {
    if (ms === undefined || ms === null || isNaN(ms)) return null;
    if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
    return Math.round(ms) + 'ms';
}

// Format an absolute waterfall timestamp (no sign — chunks always land
// after the waterfall starts, and a leading "+" reads as redundant noise
// for an absolute axis label).
function formatAbsMs(ms) {
    if (ms === undefined || ms === null || isNaN(ms) || !isFinite(ms)) return '—';
    return Math.round(ms).toLocaleString() + ' ms';
}

// Format a chunk-to-chunk delta with an explicit sign so back-to-back
// rows visually communicate the inter-arrival gap at a glance.
function formatDeltaMs(ms) {
    if (ms === undefined || ms === null || isNaN(ms) || !isFinite(ms)) return '—';
    const sign = ms < 0 ? '-' : '+';
    return sign + Math.round(Math.abs(ms)).toLocaleString() + ' ms';
}

// Render a base64-decoded HTML body as a per-chunk table when chunk timings
// are available. Each row maps one wire chunk (sliced by inflated bytes when
// the response is content-encoded, or by wire bytes when it isn't) so the
// reader can correlate "what arrived when" against the canvas waterfall.
// Returns the inner HTML for the chunk container, or null if the request
// can't support a chunked view (no chunks, missing timings, decode failure).
//
// `waterfallZero` is the same anchor the canvas renderer uses (page
// `startedDateTime` epoch ms, see layout.js#L159-L176). Passing 0 disables
// epoch normalisation — a chunk ts is then treated as already-relative.
function buildChunkedHtmlBody(request, waterfallZero) {
    if (!request || request.bodyEncoding !== 'base64' || !request.body) return null;
    const chunks = request._chunks;
    if (!Array.isArray(chunks) || chunks.length === 0) return null;
    // Every chunk needs a timestamp for the time labels to be meaningful.
    if (!chunks.every(c => c && typeof c.ts === 'number')) return null;

    // Decode the base64 body into a raw byte buffer once. We slice by byte
    // counts (not character counts) so multi-byte UTF-8 sequences split across
    // chunk boundaries are handled correctly via TextDecoder's stream mode.
    let bytes;
    try {
        const binStr = atob(request.body);
        bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    } catch (e) {
        return null;
    }
    if (bytes.length === 0) return null;

    // Per AGENTS.md note 72, an absent `inflated` should be treated as equal
    // to `bytes` (uncompressed responses omit the field). For compressed
    // responses inflated tracks decoder output and is what the body slice
    // actually represents.
    const sliceBytes = chunks.map(c => (c.inflated !== undefined ? c.inflated : (c.bytes || 0)));

    // The body buffer holds the decoded payload, so cumulative inflated bytes
    // must not exceed buffer length. Where parsers have undercounted (or the
    // last chunk's inflated value lags), absorb the leftover into the final
    // chunk so all body content is shown.
    const totalSlice = sliceBytes.reduce((a, b) => a + b, 0);
    if (totalSlice < bytes.length) {
        sliceBytes[sliceBytes.length - 1] += (bytes.length - totalSlice);
    } else if (totalSlice > bytes.length) {
        // Clamp from the tail until totals match
        let excess = totalSlice - bytes.length;
        for (let i = sliceBytes.length - 1; i >= 0 && excess > 0; i--) {
            const drop = Math.min(sliceBytes[i], excess);
            sliceBytes[i] -= drop;
            excess -= drop;
        }
    }

    // Map any timestamp into the canvas's "relative-to-waterfall-zero" space
    // so chunk labels line up with what's drawn in the waterfall. This
    // mirrors `canvas.js#L883`: anything at or above the page anchor is an
    // absolute epoch-ms reading and gets the anchor subtracted; anything
    // below is already a relative offset (netlog/chrome-trace pre-normalise
    // their chunks via `postProcessEvents`) and passes through untouched.
    // Comparing against the page anchor (rather than the magic `> 1e12`
    // threshold canvas.js uses) keeps the math correct even when a parser
    // produces an unusually small but legitimate epoch baseline.
    const toWaterfallMs = (ts) => {
        if (waterfallZero > 0 && ts >= waterfallZero) return ts - waterfallZero;
        return ts;
    };

    // The first chunk's delta is "time since the request was sent" — i.e.,
    // wait/TTFB. We resolve the request's load-start position on the canvas
    // by running `time_start` (an epoch-ms anchor on every parser path)
    // through the same normalisation. For parsers that bulk-copy a small
    // relative `_load_start` / `_start` (netlog), the result aligns
    // identically because both `time_start` and the chunks live in the same
    // coordinate space after normalisation.
    const requestStartEpoch = (typeof request.time_start === 'number') ? request.time_start : null;
    const requestLoadStartMs = requestStartEpoch !== null ? toWaterfallMs(requestStartEpoch) : null;

    const decoder = new TextDecoder('utf-8', { fatal: false });
    let offset = 0;
    let prevAbsMs = null;
    let html = '<div class="req-chunked-body">';
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isLast = (i === chunks.length - 1);
        const take = Math.max(0, Math.min(sliceBytes[i] || 0, bytes.length - offset));
        const slice = bytes.subarray(offset, offset + take);
        offset += take;
        // stream:true keeps any partial multi-byte sequence in the decoder's
        // internal buffer so the next chunk completes it; the final chunk
        // flushes any trailing bytes.
        const text = decoder.decode(slice, { stream: !isLast });

        const absMs = toWaterfallMs(chunk.ts);
        // Inter-chunk delta: first chunk = (chunk - request load start);
        // subsequent chunks = (chunk - previous chunk). Both rest entirely
        // on values that already share the canvas's coordinate space, so
        // there's no need to ever round-trip through real epoch ms here.
        let deltaMs = null;
        if (prevAbsMs !== null) {
            deltaMs = absMs - prevAbsMs;
        } else if (requestLoadStartMs !== null) {
            deltaMs = absMs - requestLoadStartMs;
        }
        prevAbsMs = absMs;

        const inflatedBytes = (chunk.inflated !== undefined) ? chunk.inflated : null;
        const wireBytes = (typeof chunk.bytes === 'number') ? chunk.bytes : null;
        let sizeStr;
        if (inflatedBytes !== null && wireBytes !== null && inflatedBytes !== wireBytes) {
            // Compressed: show decoded / wire side-by-side
            sizeStr = `${humanizeBytes(inflatedBytes) || '0 B'} &middot; ${humanizeBytes(wireBytes) || '0 B'} wire`;
        } else if (inflatedBytes !== null) {
            sizeStr = humanizeBytes(inflatedBytes) || '0 B';
        } else if (wireBytes !== null) {
            sizeStr = humanizeBytes(wireBytes) || '0 B';
        } else {
            sizeStr = '—';
        }

        const deltaLabel = (deltaMs !== null) ? ` <span class="req-chunk-rel">(${formatDeltaMs(deltaMs)})</span>` : '';
        const altClass = (i % 2) ? ' alt' : '';
        // Render the body slice with HTML highlighting. A slice may end
        // mid-tag (perfectly valid for streamed HTML); the highlighter
        // tolerates this — unmatched tag fragments simply remain unstyled.
        html += `
            <div class="req-chunk-row${altClass}">
                <div class="req-chunk-meta">
                    <div class="req-chunk-time" title="Absolute waterfall time / delta from prior chunk (first chunk: from request sent)">
                        ${formatAbsMs(absMs)}${deltaLabel}
                    </div>
                    <div class="req-chunk-size">${sizeStr}</div>
                </div>
                <div class="req-chunk-body"><pre class="req-code-block req-chunk-code">${highlightSyntax(text, 'html')}</pre></div>
            </div>
        `;
    }
    html += '</div>';
    return html;
}

function getMetricItemHtml(label, value) {
    if (!value || value === 'N/A') return '';
    return `
        <div class="metric-item">
            <span class="metric-label">${label}</span>
            <span class="metric-value">${value}</span>
        </div>
    `;
}

function highlightSyntax(code, lang) {
    if (code === undefined || code === null) return '';
    let html = String(code).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (lang === 'json') {
        html = html.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            let cls = 'hl-number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'hl-key';
                } else {
                    cls = 'hl-string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'hl-boolean';
            } else if (/null/.test(match)) {
                cls = 'hl-null';
            }
            return '<span class="' + cls + '">' + match + '</span>';
        });
    } else if (lang === 'html') {
        html = html.replace(/(&lt;\/?[a-zA-Z0-9\-:]+)(.*?)(&gt;)/g, function(match, p1, p2, p3) {
            let attrs = p2.replace(/([a-zA-Z0-9\-]+)(=)(&quot;.*?&quot;|&#39;.*?&#39;|".*?"|'.*?')/g, '<span class="hl-attr">$1</span>$2<span class="hl-string">$3</span>');
            return '<span class="hl-tag">' + p1 + '</span>' + attrs + '<span class="hl-tag">' + p3 + '</span>';
        });
    } else if (lang === 'css') {
        html = html.replace(/([a-zA-Z0-9\-]+)(\s*:)([^;]+)(;)/g, '<span class="hl-attr">$1</span>$2<span class="hl-string">$3</span>$4');
    } else if (lang === 'js') {
        html = html.replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|true|false|null)\b/g, '<span class="hl-keyword">$1</span>');
        html = html.replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, '<span class="hl-string">$1</span>');
    }
    return html;
}

function renderSummary(pageData) {
    if (!ui.summaryView) return;
    ui.summaryView.innerHTML = `
        <div class="summary-header">
            <h2>Performance Summary</h2>
        </div>
    `;

    let startRender = pageData._render;
    if (startRender === undefined && pageData.pageTimings && pageData.pageTimings._startRender > 0) {
        startRender = pageData.pageTimings._startRender;
    }

    const getRating = (val, thresholds) => {
        if (val === undefined || val === null || val === 'N/A') return '';
        const num = parseFloat(val);
        if (isNaN(num)) return '';
        if (num <= thresholds[0]) return 'good';
        if (num <= thresholds[1]) return 'warning';
        return 'poor';
    };

    let clsValue = pageData._CumulativeLayoutShift;
    if (clsValue === undefined) clsValue = pageData['chromeUserTiming.CumulativeLayoutShift'];
    if (clsValue === undefined) clsValue = pageData['_chromeUserTiming.CumulativeLayoutShift'];
    if (clsValue === undefined && Array.isArray(pageData._chromeUserTiming)) {
        const clsEvent = pageData._chromeUserTiming.find(e => e.name === 'CumulativeLayoutShift');
        if (clsEvent) clsValue = clsEvent.value !== undefined ? clsEvent.value : clsEvent.time;
    }
    if (clsValue === undefined && Array.isArray(pageData.chromeUserTiming)) {
        const clsEvent = pageData.chromeUserTiming.find(e => e.name === 'CumulativeLayoutShift');
        if (clsEvent) clsValue = clsEvent.value !== undefined ? clsEvent.value : clsEvent.time;
    }

    let clsDisplay = null;
    let clsRaw = null;
    if (clsValue !== undefined && clsValue !== null && clsValue !== 'N/A' && !isNaN(parseFloat(clsValue))) {
        clsRaw = parseFloat(clsValue);
        clsDisplay = clsRaw.toFixed(3);
    }

    const metricsGroup = [
        { label: 'Time to First Byte', value: humanizeMs(pageData._TTFB !== undefined ? pageData._TTFB : pageData._ttfb_ms) },
        { label: 'Start Render', value: humanizeMs(startRender) },
        { label: 'First Contentful Paint', value: humanizeMs(pageData._firstContentfulPaint) },
        { label: 'Speed Index', value: pageData._SpeedIndex !== undefined ? parseInt(pageData._SpeedIndex) : null },
        { label: 'Largest Contentful Paint', value: humanizeMs(pageData._LargestContentfulPaint), rating: getRating(pageData._LargestContentfulPaint, [2500, 4000]) },
        { label: 'Cumulative Layout Shift', value: clsDisplay, rating: getRating(clsRaw, [0.1, 0.25]) },
        { label: 'Total Blocking Time', value: humanizeMs(pageData._TotalBlockingTime), rating: getRating(pageData._TotalBlockingTime, [200, 600]) },
        { label: 'Doc Complete', value: humanizeMs(pageData._docTime) },
        { label: 'Doc Requests', value: pageData._requestsDoc },
        { label: 'Doc Bytes', value: humanizeBytes(pageData._bytesInDoc) },
        { label: 'Total Time', value: humanizeMs(pageData._fullyLoaded !== undefined ? pageData._fullyLoaded : pageData._loadTime) },
        { label: 'Total Requests', value: pageData._requestsFull !== undefined ? pageData._requestsFull : pageData._requests },
        { label: 'Page Weight', value: humanizeBytes(pageData._bytesIn) }
    ];

    let gridHtml = '<div class="summary-grid">';
    for (const m of metricsGroup) {
        if (m.value !== null && m.value !== undefined && m.value !== 'N/A') {
            const ratingClass = m.rating ? ` metric-bg-${m.rating}` : '';
            gridHtml += `
                <div class="summary-metric${ratingClass}">
                    <span class="summary-metric-label">${m.label}</span>
                    <span class="summary-metric-value">${m.value}</span>
                </div>
            `;
        }
    }
    gridHtml += '</div>';

    ui.summaryView.innerHTML += `
        <div class="summary-section">
            <div class="summary-section-header" onclick="
                this.parentElement.classList.toggle('collapsed');
                const svg = this.querySelector('svg polyline');
                if (this.parentElement.classList.contains('collapsed')) {
                    svg.setAttribute('points', '6 9 12 15 18 9');
                } else {
                    svg.setAttribute('points', '18 15 12 9 6 15');
                }
            ">
                Top-Level Metrics
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
            </div>
            <div class="summary-section-body">
                ${gridHtml}
            </div>
        </div>
    `;

    if (pageData._custom) {
        let customKeys = [];
        if (Array.isArray(pageData._custom)) {
            customKeys = pageData._custom;
        } else if (typeof pageData._custom === 'object') {
            customKeys = Object.keys(pageData._custom);
        }
        
        customKeys.sort((a, b) => a.localeCompare(b));

        if (customKeys.length > 0) {
            let customHtml = '<div class="custom-metrics-grid">';
            
            for (const key of customKeys) {
                let val = '';
                if (Array.isArray(pageData._custom)) {
                    val = pageData['_' + key];
                } else {
                    val = pageData._custom[key];
                }
                
                if (val !== undefined && val !== null) {
                    let formatted = '';
                    let lang = 'text';

                    if (typeof val === 'object') {
                        formatted = JSON.stringify(val, null, 2);
                        lang = 'json';
                    } else if (typeof val === 'string') {
                        let parsedObj = null;
                        try {
                            parsedObj = JSON.parse(val);
                        } catch (e) {}

                        if (parsedObj !== null && typeof parsedObj === 'object') {
                            formatted = JSON.stringify(parsedObj, null, 2);
                            lang = 'json';
                        } else {
                            formatted = val;
                            if (formatted.trim().startsWith('<')) {
                                lang = 'html';
                            } else if (['css', 'style'].some(t => key.toLowerCase().includes(t))) {
                                lang = 'css';
                            } else if (['js', 'script'].some(t => key.toLowerCase().includes(t))) {
                                lang = 'js';
                            }
                        }
                    } else {
                        formatted = val;
                        lang = 'json'; // Numbers/booleans
                    }

                    const highlighted = highlightSyntax(formatted, lang);
                    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');

                    customHtml += `
                        <div class="custom-metric-card">
                            <div class="custom-metric-header">
                                <span>${key}</span>
                                <div class="cm-actions">
                                    <button class="expand-indicator hidden" id="cm-${safeKey}-expand" onclick="
                                        const c = document.getElementById('cm-${safeKey}-container');
                                        if (c.classList.contains('clipped')) {
                                            c.classList.remove('clipped');
                                            this.innerHTML = '<svg viewBox=\\'0 0 24 24\\' width=\\'16\\' height=\\'16\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' fill=\\'none\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><polyline points=\\'18 15 12 9 6 15\\'></polyline></svg>';
                                            this.title = 'Collapse';
                                        } else {
                                            c.classList.add('clipped');
                                            this.innerHTML = '<svg viewBox=\\'0 0 24 24\\' width=\\'16\\' height=\\'16\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' fill=\\'none\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><polyline points=\\'6 9 12 15 18 9\\'></polyline></svg>';
                                            this.title = 'Expand';
                                        }
                                    " title="Expand">
                                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                                    </button>
                                    <button class="copy-btn" data-copy-id="cm-${safeKey}" title="Copy">📋 Copy</button>
                                </div>
                            </div>
                            <div class="custom-metric-content clipped" id="cm-${safeKey}-container">
                                <pre id="cm-${safeKey}-val">${highlighted}</pre>
                            </div>
                        </div>
                    `;
                }
            }
            
            customHtml += '</div>';

            ui.summaryView.innerHTML += `
                <div class="summary-section">
            <div class="summary-section-header" onclick="
                this.parentElement.classList.toggle('collapsed');
                const svg = this.querySelector('svg polyline');
                if (this.parentElement.classList.contains('collapsed')) {
                    svg.setAttribute('points', '6 9 12 15 18 9');
                } else {
                    svg.setAttribute('points', '18 15 12 9 6 15');
                }
            ">
                Custom Metrics
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
            </div>
                    <div class="summary-section-body">
                        ${customHtml}
                    </div>
                </div>
            `;

            // Display expand indicators dynamically
            requestAnimationFrame(() => {
                for (const key of customKeys) {
                    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');
                    const preEl = document.getElementById('cm-' + safeKey + '-val');
                    const containerEl = document.getElementById('cm-' + safeKey + '-container');
                    const btnEl = document.getElementById('cm-' + safeKey + '-expand');
                    if (preEl && containerEl && btnEl) {
                        if (preEl.scrollHeight > containerEl.clientHeight + 4) {
                            btnEl.classList.remove('hidden');
                        }
                    }
                }
            });
        }
    }

    ui.summaryView.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-copy-id');
            const preEl = document.getElementById(id + '-val');
            if (preEl) {
                // Use innerText directly to ignore syntax HL spans securely
                navigator.clipboard.writeText(preEl.innerText).then(() => {
                    const originalText = e.target.innerText;
                    e.target.innerText = '✅ Copied!';
                    setTimeout(() => { e.target.innerText = originalText; }, 2000);
                });
            }
        });
    });
}

async function renderTiles(pushHistory = true) {
    if (pushHistory) history.pushState({ view: 'tiles' }, '');
    
    // Purge specific waterfall viewer properties BEFORE rendering dozens of thumbnails
    resetWaterfallUI();
    
    if (ui.historyView) ui.historyView.classList.add('hidden');
    ui.canvasContainer.classList.add('hidden');
    ui.tileView.classList.remove('hidden');
    ui.tileGrid.innerHTML = '';
    const pageKeys = Object.keys(waterfallTool.data.pages);

    for (const pageId of pageKeys) {
        const pageData = waterfallTool.getPage(pageId, { includeRequests: true });
        let bytesIn = pageData._bytesIn;
        let reqCount = pageData._requestsFull;

        if (bytesIn === undefined && pageData.requests) {
            bytesIn = 0;
            reqCount = 0;
            for (const req of Object.values(pageData.requests)) {
                if (req.bytes_in) bytesIn += req.bytes_in;
                reqCount++;
            }
        }

        const tile = document.createElement('div');
        tile.className = 'page-tile';
        
        let imgUrl = null;
        
        try {
            const resource = await waterfallTool.getPageResource(pageId, 'screenshot');
            if (resource && resource.url) {
                imgUrl = resource.url;
                activeBlobUrls.push(imgUrl);
            }
        } catch (e) {
            console.error(`[viewer.js] Failed to load screenshot for ${pageId}:`, e);
        }

        const topContainer = document.createElement('div');
        topContainer.className = 'tile-top';
        
        const titleContainer = document.createElement('div');
        titleContainer.className = 'tile-title';
        titleContainer.innerHTML = `<h3>${pageData.title || pageData._URL || pageId}</h3>`;
        topContainer.appendChild(titleContainer);

        const splitBody = document.createElement('div');
        splitBody.className = 'tile-split-body';

        const details = document.createElement('div');
        details.className = 'tile-details';
        details.innerHTML = `
            <div class="tile-metrics">
                ${getMetricItemHtml('Load Time', humanizeMs(pageData._loadTime))}
                ${getMetricItemHtml('FCP', humanizeMs(pageData._firstContentfulPaint))}
                ${getMetricItemHtml('LCP', humanizeMs(pageData._LargestContentfulPaint))}
                ${getMetricItemHtml('Fully Loaded', humanizeMs(pageData._fullyLoaded))}
                ${getMetricItemHtml('Requests', reqCount)}
                ${getMetricItemHtml('Bytes', humanizeBytes(bytesIn))}
            </div>
        `;
        splitBody.appendChild(details);

        if (imgUrl) {
             const screenshotDiv = document.createElement('div');
             screenshotDiv.className = 'tile-screenshot';
             screenshotDiv.innerHTML = `<img src="${imgUrl}" alt="Screenshot">`;
             splitBody.appendChild(screenshotDiv);
             splitBody.classList.add('has-screenshot');
             tile.classList.add('has-screenshot');
        }

        topContainer.appendChild(splitBody);

        tile.appendChild(topContainer);

        const thumbWrapper = document.createElement('div');
        thumbWrapper.className = 'tile-thumbnail-wrapper';
        const thumbContainer = document.createElement('div');
        thumbContainer.className = 'tile-thumbnail';
        thumbWrapper.appendChild(thumbContainer);
        tile.appendChild(thumbWrapper);

        ui.tileGrid.appendChild(tile);

        // Render Thumbnail asynchronously securely natively
        const opts = WaterfallTools.getDefaultOptions();
        opts.pageId = pageId;
        opts.thumbnailView = true;
        opts.minWidth = 0; // Natural Width Constraints

        // Wait to process microtask explicitly to allow DOM bounds to calc smoothly
        setTimeout(async () => {
             const tData = waterfallTool.getPage(pageId, { includeRequests: true });
             await waterfallTool.renderTo(thumbContainer, opts);
        }, 0);

        tile.addEventListener('click', () => {
             renderWaterfall(pageId);
        });
    }
    
    updateUrlWithCurrentState();
}

function renderRequestTab(request, reqNum) {
    const tabId = `req-${reqNum}`;
    
    // Push the state into the browser's history queue so the back button correctly backs out of the request tab!
    if (typeof history !== 'undefined' && rendererCanvas && rendererCanvas.options && rendererCanvas.options.pageId) {
        history.pushState({ view: 'waterfall', pageId: rendererCanvas.options.pageId, tabId: tabId }, '');
    }

    let existingTab = document.querySelector(`.viewer-tab[data-tab-id="${tabId}"]`);
    if (existingTab) {
        if (!existingTab.classList.contains('active')) existingTab.click();
        return;
    }
    
    const tab = document.createElement('div');
    tab.className = 'viewer-tab req-tab';
    tab.dataset.tabId = tabId;
    tab.draggable = true;
    
    let mime = request._contentType || request.mimeType || '';
    const urlStr = request.url || request._URL || '';
    const colors = Layout.getRequestColors(mime, urlStr);
    
    const bgColor = `rgb(${colors.ttfb.join(',')})`;
    const borderColor = `rgb(${colors.download.join(',')})`;
    
    tab.style.backgroundColor = bgColor;
    tab.style.setProperty('--req-border-color', borderColor);
    tab.style.padding = '8px 10px'; // make tab narrower
    
    tab.innerHTML = `
        <span class="tab-title" style="color: #000;"><span class="tab-prefix-mobile">Request </span>${reqNum}</span>
        <button class="tab-close" style="background:transparent; border:none; margin-left:8px; cursor:pointer; font-size:10px; color:#000;">✖</button>
    `;
    
    ui.viewerTabs.appendChild(tab);
    
    tab.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        tab.remove();
        const content = document.getElementById(`view-${tabId}`);
        if (content) content.remove();
        if (tab.classList.contains('active')) {
            if (typeof history !== 'undefined' && history.state) {
                history.back();
            } else {
                const sumTab = document.querySelector('.viewer-tab[data-tab-id="waterfall"]');
                if (sumTab) sumTab.click();
            }
        }
    });

    const contentPane = document.createElement('div');
    contentPane.id = `view-${tabId}`;
    contentPane.className = 'tab-content req-tab-content';
    
    let parsedUrl = urlStr;
    let host = '';
    try {
        const u = new URL(urlStr);
        parsedUrl = u.toString();
        host = u.host;
    } catch (e) {
        // Leave as is if invalid URL
    }

    const val = (v) => (v !== undefined && v !== null) ? v : '';

    const toggleIconSvg = `<svg class="acc-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
    const toggleIconSvgCollapsed = `<svg class="acc-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    
    const createSectionHeader = (title, collapsed, copyId) => {
        let copyBtn = copyId ? `
            <button class="copy-btn" data-copy-target="${copyId}" title="Copy" onclick="event.stopPropagation();">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy
            </button>` : '';
        return `
            <div class="req-section-header" onclick="
                this.parentElement.classList.toggle('collapsed');
                const svg = this.querySelector('svg.acc-icon polyline');
                if (this.parentElement.classList.contains('collapsed')) {
                    svg.setAttribute('points', '6 9 12 15 18 9');
                } else {
                    svg.setAttribute('points', '18 15 12 9 6 15');
                }
            " style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center;">
                    ${collapsed ? toggleIconSvgCollapsed : toggleIconSvg}
                    <span style="margin-left: 8px;">${title}</span>
                </div>
                ${copyBtn}
            </div>
        `;
    };

    let detailsHtml = `
        <div class="req-section">
            ${createSectionHeader('Details', false, false)}
            <div class="req-section-body">
                <table class="req-details-table">
                    <tr><td>URL</td><td>${parsedUrl}</td></tr>
                    <tr><td>Loaded By</td><td>${val(request._initiator_detail || request._initiator)}</td></tr>
                    <tr><td>Document</td><td>${val(request._documentURL)}</td></tr>
                    <tr><td colspan="2" class="req-group-header">Request</td></tr>
                    <tr class="req-group-item"><td>Host</td><td>${val(request._host || host)}</td></tr>
                    <tr class="req-group-item"><td>IP</td><td>${val(request.serverIPAddress || request.serverIp || request._ip_addr)}</td></tr>
                    <tr class="req-group-item"><td>Error/Status Code</td><td>${val(request.status)} ${val(request.statusText) || val(request._error)}</td></tr>
                    <tr class="req-group-item"><td>Priority</td><td>${val(request._priority || request._initialPriority)}</td></tr>
                    <tr class="req-group-item"><td>Protocol</td><td>${val(request.httpVersion || request._protocol)}</td></tr>
                    <tr class="req-group-item"><td>Request ID</td><td>${val(request._request_id || request._id || request.id)}</td></tr>
                    <tr class="req-group-item"><td>Render Blocking Status</td><td>${val(request._renderBlocking)}</td></tr>
                    <tr><td colspan="2" class="req-group-header">Timing</td></tr>
                    <tr class="req-group-item"><td>Time to First Byte</td><td>${request._ttfb_ms !== undefined ? request._ttfb_ms + ' ms' : ''}</td></tr>
                    <tr class="req-group-item"><td>Content Download</td><td>${(request._download_end && request._download_start) ? Math.round(request._download_end - request._download_start) + ' ms' : ''}</td></tr>
                    <tr><td colspan="2" class="req-group-header">Size</td></tr>
                    <tr class="req-group-item"><td>Bytes In (downloaded)</td><td>${humanizeBytes(val(request._bytesIn || request.bytes_in)) || ''}</td></tr>
                    <tr class="req-group-item"><td>Uncompressed Size</td><td>${humanizeBytes(val(request._objectSizeUncompressed || request.objectSizeUncompressed)) || ''}</td></tr>
                    <tr class="req-group-item"><td>Bytes Out (uploaded)</td><td>${humanizeBytes(val(request._bytesOut || request.bytes_out)) || ''}</td></tr>
                </table>
            </div>
        </div>
    `;
    
    // Store stringified targets safely outside for clipboard
    const clipboardPayloads = {};
    
    const formatHeaders = (headersArr, copyId) => {
        if (!headersArr || !headersArr.length) return 'None';
        let rawStr = '';
        let hHtml = '<table class="req-details-table">';
        for (const h of headersArr) {
            hHtml += `<tr><td>${h.name}</td><td>${h.value}</td></tr>`;
            rawStr += `${h.name}: ${h.value}\n`;
        }
        hHtml += '</table>';
        if (copyId) clipboardPayloads[copyId] = rawStr;
        return hHtml;
    };

    let reqHeadersHtml = `
        <div class="req-section">
            ${createSectionHeader('Request Headers', false, 'reqHeaders')}
            <div class="req-section-body">
                ${formatHeaders(request.headers || [], 'reqHeaders')}
            </div>
        </div>
    `;

    let resHeadersHtml = `
        <div class="req-section">
            ${createSectionHeader('Response Headers', false, 'resHeaders')}
            <div class="req-section-body">
                ${formatHeaders(request.responseHeaders || [], 'resHeaders')}
            </div>
        </div>
    `;

    let rawJson = '';
    try {
        const rawReq = {};
        for(let key in request) {
            if(key !== 'body') rawReq[key] = request[key];
        }
        
        const cache = new Set();
        const safeString = JSON.stringify(rawReq, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) return '[Circular]';
                cache.add(value);
            }
            return value;
        }, 2);
        
        rawJson = highlightSyntax(safeString, 'json');
    } catch (e) {
        rawJson = highlightSyntax('{\n  "error": "Could not serialize raw details"\n}', 'json');
    }

    let rawDetailsHtml = `
        <div class="req-section collapsed">
            ${createSectionHeader('Raw Details', true, false)}
            <div class="req-section-body">
                <pre class="req-code-block">${rawJson}</pre>
            </div>
        </div>
    `;

    let bodyHtml = '';
    let previewHtml = '';
    const mimeLower = mime.toLowerCase();
    const isImg = mimeLower.includes('image');
    const isTextual = mimeLower.includes('text/') || mimeLower.includes('json') ||
                      mimeLower.includes('javascript') || mimeLower.includes('xml') ||
                      mimeLower.includes('css') || mimeLower.includes('svg');

    if (request.body !== undefined && request.body !== null) {
        const isBase64 = request.bodyEncoding === 'base64';

        if (isImg && isBase64) {
            // Render image bodies as actual images from base64 data using a data URI
            const imgMime = mimeLower.includes('/') ? mimeLower : 'image/png';
            previewHtml = `
                <div class="req-section">
                    ${createSectionHeader('Preview', false, false)}
                    <div class="req-section-body req-preview-container" style="display:flex; justify-content:center; background:#f0f0f0;">
                        <img src="data:${imgMime};base64,${request.body}" style="max-width:100%; max-height:400px; background:url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAGElEQVQYV2NkYGAwYkADjDA+A0Q5aJICAMCkAho2q2q/AAAAAElFTkSuQmCC');">
                    </div>
                </div>
            `;
        } else if (isTextual) {
            // For text content: decode base64 to string if needed, then syntax-highlight
            let bodyText;
            if (isBase64) {
                try {
                    bodyText = new TextDecoder().decode(Uint8Array.from(atob(request.body), c => c.charCodeAt(0)));
                } catch (e) {
                    bodyText = '[Could not decode response body]';
                }
            } else {
                bodyText = String(request.body);
            }
            // Pick syntax highlighting language from MIME type
            let lang = 'text';
            if (mimeLower.includes('json')) lang = 'json';
            else if (mimeLower.includes('html') || mimeLower.includes('svg') || mimeLower.includes('xml')) lang = 'html';
            else if (mimeLower.includes('css')) lang = 'css';
            else if (mimeLower.includes('javascript')) lang = 'js';

            // For HTML responses with chunk timing data, render a per-chunk
            // table so the reader can see what arrived in each delivery slot
            // alongside its waterfall-relative timestamp. Falls back to the
            // standard single-block view if chunks aren't present/parseable.
            let chunkedHtml = null;
            if (mimeLower.includes('html')) {
                // Resolve the canvas's "zero point" exactly the way
                // layout.js does (see src/renderer/layout.js#L159-L176):
                // prefer the active page's `startedDateTime`, otherwise
                // fall back to the earliest `time_start` across the page's
                // entries. This guarantees chunk timestamps line up with
                // what's actually drawn in the waterfall.
                let waterfallZero = 0;
                const pageId = (rendererCanvas && rendererCanvas.options) ? rendererCanvas.options.pageId : null;
                if (pageId && waterfallTool) {
                    const pData = waterfallTool.getPage(pageId, { includeRequests: true });
                    if (pData && pData.startedDateTime) {
                        waterfallZero = new Date(pData.startedDateTime).getTime();
                    } else if (pData && pData.requests) {
                        let earliest = Number.MAX_SAFE_INTEGER;
                        const reqs = Array.isArray(pData.requests) ? pData.requests : Object.values(pData.requests);
                        for (const r of reqs) {
                            if (typeof r.time_start === 'number' && r.time_start < earliest) {
                                earliest = r.time_start;
                            }
                        }
                        if (earliest !== Number.MAX_SAFE_INTEGER) waterfallZero = earliest;
                    }
                }
                chunkedHtml = buildChunkedHtmlBody(request, waterfallZero);
            }

            if (chunkedHtml) {
                bodyHtml = `
                    <div class="req-section collapsed">
                        ${createSectionHeader('Response Body (by chunk)', true, 'resBody')}
                        <div class="req-section-body req-section-body-chunks">
                            ${chunkedHtml}
                        </div>
                    </div>
                `;
            } else {
                bodyHtml = `
                    <div class="req-section collapsed">
                        ${createSectionHeader('Response Body', true, 'resBody')}
                        <div class="req-section-body">
                            <pre class="req-code-block">${highlightSyntax(bodyText, lang)}</pre>
                        </div>
                    </div>
                `;
            }
            clipboardPayloads['resBody'] = bodyText;
        } else {
            // Binary content that isn't an image — show size info
            const bodyLen = typeof request.body === 'string' ? request.body.length : 0;
            const approxBytes = isBase64 ? Math.floor(bodyLen * 3 / 4) : bodyLen;
            bodyHtml = `
                <div class="req-section collapsed">
                    ${createSectionHeader('Response Body', true, false)}
                    <div class="req-section-body">
                        <pre class="req-code-block">Binary content (${humanizeBytes(approxBytes)})</pre>
                    </div>
                </div>
            `;
        }
    } else if (isImg && parsedUrl) {
        // Fallback: no embedded body but we have a URL for the image
        previewHtml = `
            <div class="req-section">
                ${createSectionHeader('Preview', false, false)}
                <div class="req-section-body req-preview-container" style="display:flex; justify-content:center; background:#f0f0f0;">
                    <img src="${parsedUrl}" style="max-width:100%; max-height:400px; background:url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAGElEQVQYV2NkYGAwYkADjDA+A0Q5aJICAMCkAho2q2q/AAAAAElFTkSuQmCC');">
                </div>
            </div>
        `;
    }

    contentPane.innerHTML = `
        <div class="req-top-grid">
            ${detailsHtml}
            ${reqHeadersHtml}
            ${resHeadersHtml}
        </div>
        ${bodyHtml}
        ${previewHtml}
        ${rawDetailsHtml}
    `;

    // Bind copy events natively immediately after injection!
    contentPane.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetId = btn.dataset.copyTarget;
            const textToCopy = clipboardPayloads[targetId];
            if (textToCopy) {
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const originalTitle = btn.title;
                    const originalHtml = btn.innerHTML;
                    btn.title = "Copied!";
                    btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied`;
                    setTimeout(() => {
                        btn.title = originalTitle;
                        btn.innerHTML = originalHtml;
                    }, 2000);
                });
            }
        });
    });

    document.querySelector('.tabs-body').appendChild(contentPane);
    
    // Simulate click to focus newly minted tab natively
    tab.click();
}

async function renderWaterfall(pageId, overridingOptions = {}, pushHistory = true) {
    if (pushHistory) history.pushState({ view: 'waterfall', pageId }, '');
    if (ui.historyView) ui.historyView.classList.add('hidden');
    ui.tileView.classList.add('hidden');
    ui.canvasContainer.classList.remove('hidden');
    
    const pageKeys = Object.keys(waterfallTool.data.pages);
    if (pageKeys.length > 1) {
        ui.btnBackTiles.classList.remove('hidden');
    } else {
        ui.btnBackTiles.classList.add('hidden');
    }

    if (rendererCanvas) {
        rendererCanvas.destroy();
        rendererCanvas = null;
    }

    const urlOptions = getOptionsFromUrl();
    const renderOptions = Object.assign(urlOptions, overridingOptions);
    renderOptions.pageId = pageId;
    
    if (typeof window !== 'undefined') {
        const wantsSplit = window.innerWidth <= 1200;
        if (wantsSplit || overridingOptions.overlapLabels) {
            renderOptions.overlapLabels = true;
            let gc = document.getElementById('labels-canvas-element');
            if (!gc) {
                gc = document.createElement('canvas');
                gc.id = 'labels-canvas-element';
                if (ui.labelsSliderContent) ui.labelsSliderContent.appendChild(gc);
            }
            renderOptions.labelsCanvas = gc;
        } else {
            renderOptions.overlapLabels = false;
            renderOptions.labelsCanvas = null;
        }
    }

    const pageData = waterfallTool.getPage(pageId);
    if (pageData) {
        const pageUrl = pageData.title || pageData._URL || pageData.id;
        if (pageUrl) {
            try {
                const urlObj = new URL(pageUrl);
                document.title = `Waterfall Viewer - ${urlObj.hostname}`;
                ui.viewerTitle.textContent = `Waterfall`;
            } catch (err) {
                document.title = `Waterfall Viewer - ${pageUrl}`;
                ui.viewerTitle.textContent = `Waterfall`;
            }
        }
    }

    // Reset tabs
    document.querySelectorAll('.viewer-tab').forEach(t => t.classList.remove('active'));
    
    // Select waterfall by default explicitly instead of summary matching new visual focus points
    const wfTab = document.querySelector('.viewer-tab[data-tab-id="waterfall"]');
    if (wfTab) wfTab.classList.add('active');
    
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    if (ui.waterfallView) ui.waterfallView.classList.add('active');
    if (ui.labelsSlider) ui.labelsSlider.classList.add('active');
    ui.btnSettings.style.display = 'block';
    
    if (rendererCanvas) window.dispatchEvent(new Event('resize'));

    // Render the summary internally
    if (typeof renderSummary === 'function' && pageData) {
        renderSummary(pageData);
    }

    pendingTabLoads = {};
    if (ui.tabLighthouse) ui.tabLighthouse.classList.add('hidden');
    if (ui.lighthouseFrame) ui.lighthouseFrame.src = 'about:blank';
    if (ui.tabTrace) ui.tabTrace.classList.add('hidden');
    if (ui.traceFrame) ui.traceFrame.src = 'about:blank';
    if (ui.tabDevtools) ui.tabDevtools.classList.add('hidden');
    if (ui.devtoolsFrame) ui.devtoolsFrame.src = 'about:blank';
    if (ui.tabNetlog) ui.tabNetlog.classList.add('hidden');
    if (ui.netlogFrame) ui.netlogFrame.src = 'about:blank';

    try {
        const lhResource = await waterfallTool.getPageResource(pageId, 'lighthouse');
        if (lhResource && lhResource.url && ui.tabLighthouse) {
            ui.tabLighthouse.classList.remove('hidden');
            activeBlobUrls.push(lhResource.url);
            pendingTabLoads.lighthouse = () => {
                ui.lighthouseFrame.src = lhResource.url;
            };
        }
    } catch (e) {
        console.warn(`[viewer.js] Failed to fetch lighthouse HTML for ${pageId}:`, e);
    }
    
    try {
        const traceResource = await waterfallTool.getPageResource(pageId, 'trace');
        if (traceResource && traceResource.buffer && ui.tabTrace) {
            ui.tabTrace.classList.remove('hidden');
            pendingTabLoads.trace = () => {
                loadTracePerfetto(traceResource.buffer);
            };

            // DevTools tab is gated on the same resource availability — we reuse the trace
            // buffer in a later phase when load-into-DevTools is implemented.
            if (ui.tabDevtools && getDevtoolsPath()) {
                ui.tabDevtools.classList.remove('hidden');
                pendingTabLoads.devtools = () => {
                    loadDevtools();
                };
            }
        }
    } catch (e) {
        console.warn(`[viewer.js] Failed to fetch trace data for ${pageId}:`, e);
    }

    try {
        const netlogResource = await waterfallTool.getPageResource(pageId, 'netlog');
        if (netlogResource && netlogResource.buffer && ui.tabNetlog) {
            ui.tabNetlog.classList.remove('hidden');
            pendingTabLoads.netlog = () => {
                loadNetlog(netlogResource.buffer);
            };
        }
    } catch (e) {
        console.warn(`[viewer.js] Failed to fetch netlog data for ${pageId}:`, e);
    }

    renderOptions.onHover = (data) => {
        const tooltip = document.getElementById('waterfall-tooltip');
        if (!tooltip) return;
        
        if (!data) {
            tooltip.style.display = 'none';
            return;
        }
        tooltip.style.display = 'block';
        
        let url = data.request.url || data.request._URL || '';
        
        // Handle truncation in middle if > 100 chars
        if (url.length > 100) {
            url = url.substring(0, 50) + ' ... ' + url.substring(url.length - 45);
        }
        
        tooltip.textContent = url;
        
        if (data.event) {
            let x = data.event.clientX + 15;
            let y = data.event.clientY + 15;
            
            // Re-calculate bounds
            if (x + tooltip.offsetWidth > window.innerWidth) {
                x = window.innerWidth - tooltip.offsetWidth - 10;
            }
            if (y + tooltip.offsetHeight > window.innerHeight) {
                y = window.innerHeight - tooltip.offsetHeight - 10;
            }
            tooltip.style.left = x + 'px';
            tooltip.style.top = y + 'px';
        }
    };

    renderOptions.onClick = (data) => {
        if (!data || !data.request) return;
        renderRequestTab(data.request, data.index + 1);
    };

    rendererCanvas = await waterfallTool.renderTo(ui.waterfallView, renderOptions);
    
    // Sync Settings form securely
    const viewTypeRadios = document.querySelectorAll('input[name="ui-view-type"]');
    for (const r of viewTypeRadios) {
        r.checked = (r.value === (renderOptions.connectionView ? 'connection' : 'waterfall'));
    }
    document.getElementById('ui-show-page-metrics').checked = renderOptions.showPageMetrics;
    document.getElementById('ui-show-marks').checked = renderOptions.showMarks;
    document.getElementById('ui-show-cpu').checked = renderOptions.showCpu;
    document.getElementById('ui-show-bw').checked = renderOptions.showBw;
    document.getElementById('ui-show-mainthread').checked = renderOptions.showMainthread;
    document.getElementById('ui-show-longtasks').checked = renderOptions.showLongtasks;
    document.getElementById('ui-show-missing').checked = renderOptions.showMissing;
    document.getElementById('ui-show-labels').checked = renderOptions.showLabels;
    document.getElementById('ui-show-chunks').checked = renderOptions.showChunks;
    document.getElementById('ui-show-js').checked = renderOptions.showJsTiming;
    document.getElementById('ui-show-wait').checked = renderOptions.showWait;
    document.getElementById('ui-show-legend').checked = renderOptions.showLegend;
    
    const stEl = document.getElementById('ui-start-time');
    if (stEl) stEl.value = (renderOptions.startTime !== undefined) ? renderOptions.startTime : '';
    const etEl = document.getElementById('ui-end-time');
    if (etEl) etEl.value = (renderOptions.endTime !== undefined) ? renderOptions.endTime : '';
    const rfEl = document.getElementById('ui-req-filter');
    if (rfEl) rfEl.value = (renderOptions.reqFilter !== undefined) ? renderOptions.reqFilter : '';
    
    // Check for explicit tab auto-loading without flashing
    const params = new URLSearchParams(window.location.search);
    if (!rendererCanvas._tabHandled && params.has('tab')) {
        let requestedTab = params.get('tab');
        rendererCanvas._tabHandled = true; // only do this once
        
        let tabToClick = null;
        if (requestedTab.startsWith('Request')) {
            const matchId = requestedTab.substring(7);
            const pData = waterfallTool.getPage(pageId, { includeRequests: true });
            let reqs = [];
            if (pData && pData.requests) {
                reqs = Array.isArray(pData.requests) ? pData.requests : Object.values(pData.requests);
            }
            const reqIdx = reqs.findIndex((r, i) => {
                return (r && (r._request_id == matchId || r._id == matchId || r.id == matchId)) || ((i + 1).toString() === matchId);
            });
            
            if (reqIdx !== -1) {
                renderRequestTab(reqs[reqIdx], reqIdx + 1);
                tabToClick = document.querySelector(`.viewer-tab[data-tab-id="req-${reqIdx + 1}"]`);
            }
        } else {
            tabToClick = document.querySelector(`.viewer-tab[data-tab-id="${requestedTab}"]`);
        }
        
        if (tabToClick) {
            tabToClick.click();
        }
    }
    
    const activeTab = document.querySelector('.viewer-tab.active');
    if (activeTab && activeTab.dataset.tabId === 'waterfall' && ui.btnSettings) {
        ui.btnSettings.style.display = 'block';
    }
    
    updateUrlWithCurrentState();
}

function resetWaterfallUI() {
    if (typeof pendingTabLoads !== 'undefined') {
        pendingTabLoads = {};
    }

    if (rendererCanvas) {
        rendererCanvas.destroy();
        rendererCanvas = null;
    }

    document.querySelectorAll('.viewer-tab.req-tab, .req-tab-content').forEach(el => el.remove());

    if (typeof activeBlobUrls !== 'undefined' && Array.isArray(activeBlobUrls)) {
        activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
        activeBlobUrls.length = 0;
    }

    if (typeof ui !== 'undefined') {
        if (ui.lighthouseFrame) ui.lighthouseFrame.src = 'about:blank';
        if (ui.traceFrame) ui.traceFrame.src = 'about:blank';
        if (ui.devtoolsFrame) ui.devtoolsFrame.src = 'about:blank';
        if (ui.netlogFrame) ui.netlogFrame.src = 'about:blank';
    }
    
    const tooltip = document.getElementById('waterfall-tooltip');
    if (tooltip) tooltip.style.display = 'none';
}

/**
 * Fetch a user-supplied URL with escalating fallbacks for CORS-blocked origins.
 *
 * Attempt order:
 *   1. Direct fetch with credentials (so sites behind a cookie-based paywall work).
 *   2. Anonymous direct fetch (no credentials).
 *   3. Relative `/fetch?url=<target>` — the waterfall-tools CORS proxy worker
 *      co-deployed on this origin, if any.
 *   4. If (3) returned 403 or 404 (signalling no proxy is deployed here) AND
 *      this viewer isn't already on https://waterfall-tools.com, fall back to
 *      the public proxy at https://waterfall-tools.com/fetch.
 *
 * The 403/404 gate on step 4 is deliberate: it lets privately-hosted viewers
 * run their own proxy (potentially inside a firewall) without silently leaking
 * URLs to the public instance. Any other status from the local proxy is
 * treated as a real failure and not retried.
 *
 * Returns a Response on the first successful attempt. Throws if every
 * strategy fails, with an error message describing the last failure.
 */
const PUBLIC_PROXY_ORIGIN = 'https://waterfall-tools.com';

async function fetchRemote(targetUrl) {
    // 1. Anonymous direct fetch.
    try {
        const r = await fetch(targetUrl, { mode: 'cors', credentials: 'omit' });
        if (r.ok) return r;
    } catch (_e) { /* CORS or network error — try credentialed next */ }

    // 2. Direct fetch, crossorigin with credentials.
    try {
        const r = await fetch(targetUrl, { mode: 'cors', credentials: 'include' });
        if (r.ok) return r;
    } catch (_e) { /* fall through to the proxy path */ }

    // 3. Relative /fetch on the current origin.
    const proxyPath = `/fetch?url=${encodeURIComponent(targetUrl)}`;
    let relativeStatus = null;
    let relativeError = null;
    try {
        const r = await fetch(proxyPath, { mode: 'cors', credentials: 'omit' });
        if (r.ok) return r;
        relativeStatus = r.status;
    } catch (e) {
        relativeError = e;
    }

    // 4. Public-instance proxy, only when the local /fetch explicitly signals
    //    "no proxy here" (403/404) and we aren't already on the public origin.
    const onPublicInstance = (typeof window !== 'undefined') &&
        window.location && window.location.origin === PUBLIC_PROXY_ORIGIN;
    if (!onPublicInstance && (relativeStatus === 403 || relativeStatus === 404)) {
        const publicProxyUrl = `${PUBLIC_PROXY_ORIGIN}/fetch?url=${encodeURIComponent(targetUrl)}`;
        const r = await fetch(publicProxyUrl, { mode: 'cors', credentials: 'omit' });
        if (r.ok) return r;
        throw new Error(`Public proxy returned HTTP ${r.status}`);
    }

    if (relativeStatus !== null) throw new Error(`Proxy returned HTTP ${relativeStatus}`);
    if (relativeError) throw relativeError;
    throw new Error(`Unable to fetch ${targetUrl}`);
}

async function resetViewerState() {
    resetWaterfallUI();
    
    if (typeof waterfallTool !== 'undefined' && waterfallTool) {
        if (typeof waterfallTool.destroy === 'function') {
            await waterfallTool.destroy();
        }
        waterfallTool = null;
    }

    if (typeof ui !== 'undefined' && ui.tileGrid) {
        ui.tileGrid.innerHTML = '';
    }
}

async function processData(arrayBuffer, options = {}, keylogArrayBuffer = null) {
    try {
        await resetViewerState();

        waterfallTool = new WaterfallTools();

        const loadOptions = {
            debug: false,
            onProgress: (phase, percent) => updateProgress(phase, percent)
        };
        if (keylogArrayBuffer) {
             const blob = new Blob([keylogArrayBuffer]);
             loadOptions.keyLogInput = await fileToReadable(blob);
        }

        await waterfallTool.loadBuffer(arrayBuffer, loadOptions);

        // Determine active view before hiding loader so UI doesn't visually jump
        const loadPageOverride = Object.keys(waterfallTool.data.pages).length > 1 ? options.pageId : null;

        const pageKeys = Object.keys(waterfallTool.data.pages);
        if (pageKeys.length > 1 && !loadPageOverride) {
            if (options.historyMode === 'replace') {
                if (typeof history !== 'undefined') history.replaceState({ view: 'tiles' }, '');
                await renderTiles(false);
            } else {
                await renderTiles();
            }
            hideLoading();
            ui.dropZone.classList.add('hidden');
        } else {
            const pageToRender = loadPageOverride || pageKeys[0];
            if (options.historyMode === 'replace') {
                if (typeof history !== 'undefined') history.replaceState({ view: 'waterfall', pageId: pageToRender }, '');
                await renderWaterfall(pageToRender, options, false);
            } else {
                await renderWaterfall(pageToRender, options);
            }
            hideLoading();
            ui.dropZone.classList.add('hidden');
        }

    } catch (e) {
        console.error(e);
        showError(e.message || 'Error processing network data');
    }
}

async function processFiles(files) {
    if (files.length === 0) return;
    
    // Purge old viewer components dynamically BEFORE huge file allocations trigger OOM
    await resetViewerState();
    
    showLoading('Parsing files...');

    try {
        let mainFile = files[0];
        let keylogFile = null;

        if (files.length === 2) {
            const arr0 = await files[0].slice(0, 65536).arrayBuffer();
            const format0 = (await identifyFormatFromBuffer(new Uint8Array(arr0))).format;

            const arr1 = await files[1].slice(0, 65536).arrayBuffer();
            const format1 = (await identifyFormatFromBuffer(new Uint8Array(arr1))).format;

            if (format0 === 'tcpdump' && format1 === 'keylog') {
                mainFile = files[0];
                keylogFile = files[1];
            } else if (format1 === 'tcpdump' && format0 === 'keylog') {
                mainFile = files[1];
                keylogFile = files[0];
            }
        }

        const arrayBuffer = await mainFile.arrayBuffer();
        let keylogBuffer = null;
        if (keylogFile) {
            keylogBuffer = await keylogFile.arrayBuffer();
        }

        await processData(arrayBuffer, {}, keylogBuffer);

    } catch(e) {
        console.error(e);
        showError('Invalid file format or corruption. Check console.');
    }
}

function updateUrlWithCurrentState() {
    if (typeof history === 'undefined' || !window.location) return;
    
    try {
        const urlObj = new URL(window.location.href);
        const params = urlObj.searchParams;
        
        // 1. Resolve Global View explicit bounds
        if (ui.historyView && !ui.historyView.classList.contains('hidden')) {
            params.set('view', 'history');
            params.delete('page');
            params.delete('tab');
            params.delete('options');
        } else if (!ui.tileView.classList.contains('hidden')) {
            params.delete('view');
            params.delete('page');
            params.delete('tab');
            params.delete('options');
        } else if (!ui.canvasContainer.classList.contains('hidden')) {
            params.delete('view');
            
            // Map Canvas-specific configuration cleanly
            if (waterfallTool && rendererCanvas && rendererCanvas.options) {
                const currentOpts = rendererCanvas.options;
                
                if (waterfallTool.data && waterfallTool.data.pages && Object.keys(waterfallTool.data.pages).length <= 1) {
                    params.delete('page');
                } else {
                    params.set('page', currentOpts.pageId);
                }
                
                // Generate non-default options list
                const defaultOpts = WaterfallTools.getDefaultOptions();
                let optionOverrides = [];
                for (const key of Object.keys(defaultOpts)) {
                    if (key === 'pageId') continue;
                    if (currentOpts[key] !== undefined && currentOpts[key] !== defaultOpts[key]) {
                        optionOverrides.push(`${key}:${encodeURIComponent(currentOpts[key])}`);
                    }
                }
                if (optionOverrides.length > 0) {
                    params.set('options', optionOverrides.join(','));
                } else {
                    params.delete('options');
                }
            } else {
                params.delete('page');
                params.delete('options');
            }
            
            // Tab Extraction natively isolated to canvas visibility
            const activeTab = document.querySelector('.viewer-tab.active');
            if (activeTab) {
                const tabId = activeTab.dataset.tabId;
                if (tabId === 'waterfall') {
                    params.delete('tab');
                } else if (tabId && tabId.startsWith('req-')) {
                    params.set('tab', 'Request' + tabId.substring(4));
                } else if (tabId) {
                    params.set('tab', tabId);
                }
            } else {
                params.delete('tab');
            }
        } else {
            // Base state (dropzone)
            params.delete('view');
            params.delete('page');
            params.delete('tab');
            params.delete('options');
        }
        
        // Push strictly as a replace state to prevent muddying navigation linearly
        history.replaceState(history.state, '', urlObj.toString());
    } catch (e) {
        console.warn('Failed formatting sync URL parameters:', e);
    }
}

window.WaterfallViewer = {
    loadData: async (bufferOrFile, options = {}) => {
        await resetViewerState();
        showLoading('Loading Programmatically...');
        if (bufferOrFile instanceof File || bufferOrFile instanceof Blob) {
            const buf = await bufferOrFile.arrayBuffer();
            return processData(buf, Object.assign({}, options, { historyMode: 'replace' }));
        } else if (bufferOrFile instanceof ArrayBuffer) {
            return processData(bufferOrFile, Object.assign({}, options, { historyMode: 'replace' }));
        }
        showError("Invalid data format mapping correctly. Requires Blob or ArrayBuffer.");
    },

    updateOptions: (newOptions = {}) => {
        if (!rendererCanvas || !waterfallTool) return;
        rendererCanvas.options = Object.assign(rendererCanvas.options, newOptions);
        
        let pageId = rendererCanvas.options.pageId;
        if (!pageId && waterfallTool.data && waterfallTool.data.pages) {
            pageId = Object.keys(waterfallTool.data.pages)[0];
        }
        
        const pageData = waterfallTool.getPage(pageId, { includeRequests: true });
        rendererCanvas.render(pageData);
    }
};

function transformWptUrl(url) {
    if (!url) return url;
    const originRe = /^https?:\/\/[^\/]+/;
    const resultRe = /\/result\/(\d{6}_[^/]+)/;
    const phpRe = /\/results\.php\?.*test=(\d{6}_[^&]+)/;

    let testId = null;
    let match = url.match(resultRe);
    if (match) {
        testId = match[1];
    } else {
        match = url.match(phpRe);
        if (match) {
            testId = match[1];
        }
    }

    if (testId) {
        const originMatch = url.match(originRe);
        if (originMatch) {
            return `${originMatch[0]}/export.php?bodies=1&test=${testId}`;
        }
    }
    return url;
}

async function initViewer() {
    const urlOptions = getOptionsFromUrl();
    const params = new URLSearchParams(window.location.search);
    const srcUrl = params.get('src');

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.body.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
    });

    let dragCounter = 0;
    document.body.addEventListener('dragenter', () => {
        dragCounter++;
        if (dragCounter === 1 && !rendererCanvas && !ui.loading.classList.contains('hidden') === false) {
            ui.dropZone.classList.remove('hidden');
            ui.dropZone.classList.add('drag-active');
        }
    });

    document.body.addEventListener('dragleave', () => {
        dragCounter--;
        if (dragCounter === 0) {
            ui.dropZone.classList.remove('drag-active');
            if (rendererCanvas) ui.dropZone.classList.add('hidden');
        }
    });

    document.body.addEventListener('drop', (e) => {
        dragCounter = 0;
        ui.dropZone.classList.remove('drag-active');
        if (e.dataTransfer.files) {
            processFiles(e.dataTransfer.files);
        }
    });

    ui.uploadBtn.addEventListener('click', () => ui.fileInput.click());
    ui.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) processFiles(e.target.files);
    });

    const urlInput = document.getElementById('url-input');
    const urlLoadBtn = document.getElementById('url-load-btn');
    if (urlInput && urlLoadBtn) {
        const handleUrlLoad = async () => {
            const urlVal = urlInput.value.trim();
            if (urlVal) {
                const transformedVal = transformWptUrl(urlVal);
                console.log("Attempting to load URL payload natively:", transformedVal);
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.set('src', urlVal);
                if (typeof history !== 'undefined') history.pushState(history.state, '', newUrl.toString());
                
                try {
                    await resetViewerState();
                    showLoading(`Downloading: ${transformedVal}`);
                    const response = await fetchRemote(transformedVal);
                    
                    showLoading("Processing Network Data...");
                    const buffer = await response.arrayBuffer();
                    
                    const processOpts = Object.assign({}, getOptionsFromUrl(), { historyMode: 'replace' });
                    await processData(buffer, processOpts);
                    
                    try {
                        let type = waterfallTool ? waterfallTool._sourceFormat : 'unknown';
                        let testUrl = '';
                        let numPages = 0;
                        if (waterfallTool && waterfallTool.data && waterfallTool.data.pages) {
                            const pageKeys = Object.keys(waterfallTool.data.pages);
                            numPages = pageKeys.length;
                            if (numPages > 0) {
                                const firstPage = waterfallTool.data.pages[pageKeys[0]];
                                testUrl = firstPage._URL || '';
                                if (!testUrl && firstPage.requests) {
                                    const reqKeys = Object.keys(firstPage.requests);
                                    if (reqKeys.length > 0) {
                                        testUrl = firstPage.requests[reqKeys[0]].url;
                                    }
                                }
                                if (!testUrl) testUrl = firstPage.url || firstPage.id || '';
                            }
                        }
                        saveToHistory({ url: urlVal, type, title: '', testUrl, numPages }).catch(e => console.warn('Failed to save to history:', e));
                    } catch(e) {}
                } catch(e) {
                    console.error("URL Load Error:", e);
                    showError(`Failed fetching remote file: ${e.message}`);
                }
            }
        };
        urlLoadBtn.addEventListener('click', handleUrlLoad);
        urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleUrlLoad();
        });
    }

    // Nav Bindings
    ui.btnBackTiles.addEventListener('click', () => {
         if (typeof history !== 'undefined' && history.state) {
             history.back();
         } else {
             renderTiles();
         }
    });

    ui.btnSettings.addEventListener('click', () => {
         ui.settingsOverlay.classList.remove('hidden');
    });

    ui.btnSettingsClose.addEventListener('click', () => {
         ui.settingsOverlay.classList.add('hidden');
    });

    ui.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === ui.settingsOverlay) {
             ui.settingsOverlay.classList.add('hidden');
        }
    });

    if (ui.hamburgerBtn) {
        ui.hamburgerBtn.addEventListener('click', () => {
            if (ui.tabsScrollWrapper) ui.tabsScrollWrapper.classList.toggle('menu-open');
        });
        
        // Dismiss tap outside bounds
        document.addEventListener('click', (e) => {
            if (ui.tabsScrollWrapper && ui.tabsScrollWrapper.classList.contains('menu-open')) {
                if (!ui.tabsScrollWrapper.contains(e.target) && (!ui.hamburgerBtn || !ui.hamburgerBtn.contains(e.target))) {
                    ui.tabsScrollWrapper.classList.remove('menu-open');
                }
            }
        });
    }

    if (ui.btnCloseTab) {
        ui.btnCloseTab.addEventListener('click', () => {
            const activeTab = document.querySelector('.viewer-tab.active');
            if (activeTab && activeTab.querySelector('.tab-close')) {
                activeTab.querySelector('.tab-close').click();
            }
        });
    }

    if (ui.labelsSliderToggle) {
        ui.labelsSliderToggle.addEventListener('click', () => {
            if (ui.labelsSlider) {
                ui.labelsSlider.classList.toggle('open');
                ui.labelsSliderToggle.textContent = ui.labelsSlider.classList.contains('open') ? '◀' : '▶';
            }
        });
    }
    
    // Responsive Canvas Resize Observer
    let lastLabelsOverlap = typeof window !== 'undefined' ? window.innerWidth <= 1200 : false;
    window.addEventListener('resize', () => {
        if (!rendererCanvas || !rendererCanvas.options) return;
        const wantsSplit = window.innerWidth <= 1200;
        if (wantsSplit !== lastLabelsOverlap) {
            lastLabelsOverlap = wantsSplit;
            const options = Object.assign({}, rendererCanvas.options);
            options.overlapLabels = wantsSplit;
            
            if (wantsSplit) {
                let gc = document.getElementById('labels-canvas-element');
                if (!gc) {
                    gc = document.createElement('canvas');
                    gc.id = 'labels-canvas-element';
                    if (ui.labelsSliderContent) ui.labelsSliderContent.appendChild(gc);
                }
                options.labelsCanvas = gc;
            } else {
                options.labelsCanvas = null;
            }
            rendererCanvas.updateOptions(options);
        }
    });


    // Initially hide settings
    if (ui.btnSettings) ui.btnSettings.style.display = 'none';
    
    // Evaluate Data happens at the very bottom

    // Settings Bindings
    const overlayInputMapping = {
        'ui-show-page-metrics': 'showPageMetrics',
        'ui-show-marks': 'showMarks',
        'ui-show-cpu': 'showCpu',
        'ui-show-bw': 'showBw',
        'ui-show-mainthread': 'showMainthread',
        'ui-show-longtasks': 'showLongtasks',
        'ui-show-missing': 'showMissing',
        'ui-show-labels': 'showLabels',
        'ui-show-chunks': 'showChunks',
        'ui-show-js': 'showJsTiming',
        'ui-show-wait': 'showWait',
        'ui-show-legend': 'showLegend'
    };

    document.querySelectorAll('input[name="ui-view-type"]').forEach(el => {
        el.addEventListener('change', (e) => {
            window.WaterfallViewer.updateOptions({ connectionView: e.target.value === 'connection' });
            updateUrlWithCurrentState();
        });
    });

    ['ui-start-time', 'ui-end-time', 'ui-req-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', (e) => {
                let optKey;
                let optVal = e.target.value;
                if (id === 'ui-start-time') {
                    optKey = 'startTime';
                    optVal = optVal !== '' ? parseFloat(optVal) : undefined;
                } else if (id === 'ui-end-time') {
                    optKey = 'endTime';
                    optVal = optVal !== '' ? parseFloat(optVal) : undefined;
                } else if (id === 'ui-req-filter') {
                    optKey = 'reqFilter';
                    optVal = optVal !== '' ? optVal : undefined;
                }
                window.WaterfallViewer.updateOptions({ [optKey]: optVal });
                updateUrlWithCurrentState();
            });
        }
    });

    Object.keys(overlayInputMapping).forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', (e) => {
                const optKey = overlayInputMapping[id];
                const optVal = e.target.checked;
                window.WaterfallViewer.updateOptions({ [optKey]: optVal });
                updateUrlWithCurrentState();
            });
        }
    });

    // Tab switching bindings
    if (ui.viewerTabs) {
        ui.viewerTabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.viewer-tab');
            if (!tab || tab.classList.contains('hidden')) return;

            document.querySelectorAll('.viewer-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const tabId = tab.dataset.tabId;
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

            if (ui.tabsScrollWrapper) ui.tabsScrollWrapper.classList.remove('menu-open');

            if (tabId === 'waterfall') {
                ui.btnSettings.style.display = 'block';
                ui.waterfallView.classList.add('active');
                if (ui.labelsSlider) ui.labelsSlider.classList.add('active');
                // Ensure canvas resizes properly if needed
                if (rendererCanvas) window.dispatchEvent(new Event('resize'));
            } else {
                ui.btnSettings.style.display = 'none';
                if (ui.labelsSlider) ui.labelsSlider.classList.remove('active');
            }
            
            if (tab.querySelector('.tab-close') && ui.btnCloseTab) {
                ui.btnCloseTab.classList.remove('hidden');
            } else if (ui.btnCloseTab) {
                ui.btnCloseTab.classList.add('hidden');
            }
            
            if (tabId === 'summary') {
                if (ui.summaryView) ui.summaryView.classList.add('active');
            } else if (tabId === 'lighthouse') {
                if (ui.lighthouseView) ui.lighthouseView.classList.add('active');
                if (pendingTabLoads.lighthouse) {
                    pendingTabLoads.lighthouse();
                    delete pendingTabLoads.lighthouse;
                }
            } else if (tabId === 'trace') {
                if (ui.traceView) ui.traceView.classList.add('active');
                if (pendingTabLoads.trace) {
                    pendingTabLoads.trace();
                    delete pendingTabLoads.trace;
                }
            } else if (tabId === 'devtools') {
                if (ui.devtoolsView) ui.devtoolsView.classList.add('active');
                if (pendingTabLoads.devtools) {
                    pendingTabLoads.devtools();
                    delete pendingTabLoads.devtools;
                }
            } else if (tabId === 'netlog') {
                if (ui.netlogView) ui.netlogView.classList.add('active');
                if (pendingTabLoads.netlog) {
                    pendingTabLoads.netlog();
                    delete pendingTabLoads.netlog;
                }
            } else {
                // Handle dynamic tabs like req-1, req-2
                const content = document.getElementById(`view-${tabId}`);
                if (content) content.classList.add('active');
            }
            
            // Replace history naturally when the user manually switches tabs (prevent bloated history stacks)
            if (e.isTrusted && rendererCanvas && rendererCanvas.options && rendererCanvas.options.pageId) {
                history.replaceState({ view: 'waterfall', pageId: rendererCanvas.options.pageId, tabId: tabId }, '');
            }
            
            updateUrlWithCurrentState();
        });
    }

    // History API bindings
    window.addEventListener('popstate', (e) => {
        const state = e.state;
        if (state && state.view === 'history') {
            if (typeof loadAndRenderHistory === 'function') loadAndRenderHistory();
            return;
        }
        
        if (!waterfallTool || !waterfallTool.data || !waterfallTool.data.pages) {
            ui.canvasContainer.classList.add('hidden');
            ui.tileView.classList.add('hidden');
            if (ui.historyView) ui.historyView.classList.add('hidden');
            ui.dropZone.classList.remove('hidden');
            return;
        }
        if (state) {
            if (state.view === 'tiles') {
                renderTiles(false);
            } else if (state.view === 'waterfall' && state.pageId) {
                if (!ui.canvasContainer.classList.contains('hidden') && rendererCanvas && rendererCanvas.options.pageId === state.pageId) {
                    // Intelligently jump seamlessly visually if already residing tightly inside the same page architecture natively
                    const tabId = state.tabId || 'waterfall';
                    const tab = document.querySelector(`.viewer-tab[data-tab-id="${tabId}"]`);
                    if (tab) tab.click();
                } else {
                    renderWaterfall(state.pageId, {}, false).then(() => {
                        if (state.tabId) {
                            const tab = document.querySelector(`.viewer-tab[data-tab-id="${state.tabId}"]`);
                            if (tab) tab.click();
                        }
                    });
                }
            }
        } else {
            resetViewerState();
            ui.canvasContainer.classList.add('hidden');
            ui.tileView.classList.add('hidden');
            if (ui.historyView) ui.historyView.classList.add('hidden');
            ui.dropZone.classList.remove('hidden');
        }
    });

    // Tab drag and drop
    let draggedTab = null;

    if (ui.viewerTabs) {
        ui.viewerTabs.addEventListener('dragstart', (e) => {
            const tab = e.target.closest('.viewer-tab');
            if (!tab) return;
            draggedTab = tab;
            setTimeout(() => tab.classList.add('dragging'), 0);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tab.dataset.tabId);
        });

        ui.viewerTabs.addEventListener('dragend', (e) => {
            const tab = e.target.closest('.viewer-tab');
            if (tab) tab.classList.remove('dragging');
            draggedTab = null;
            ui.viewerTabs.querySelectorAll('.viewer-tab').forEach(t => {
                t.classList.remove('drag-over-left', 'drag-over-right');
            });
        });

        ui.viewerTabs.addEventListener('dragover', (e) => {
            e.preventDefault();
            const targetTab = e.target.closest('.viewer-tab');
            if (!targetTab || targetTab === draggedTab) return;
            
            const rect = targetTab.getBoundingClientRect();
            const midpoint = rect.x + rect.width / 2;
            
            ui.viewerTabs.querySelectorAll('.viewer-tab').forEach(t => {
                t.classList.remove('drag-over-left', 'drag-over-right');
            });
            
            if (e.clientX < midpoint) {
                targetTab.classList.add('drag-over-left');
            } else {
                targetTab.classList.add('drag-over-right');
            }
        });

        ui.viewerTabs.addEventListener('drop', (e) => {
            e.preventDefault();
            const targetTab = e.target.closest('.viewer-tab');
            if (!targetTab || targetTab === draggedTab || !draggedTab) return;

            const rect = targetTab.getBoundingClientRect();
            const midpoint = rect.x + rect.width / 2;
            
            if (e.clientX < midpoint) {
                ui.viewerTabs.insertBefore(draggedTab, targetTab);
            } else {
                ui.viewerTabs.insertBefore(draggedTab, targetTab.nextSibling);
            }
            
            ui.viewerTabs.querySelectorAll('.viewer-tab').forEach(t => {
                t.classList.remove('drag-over-left', 'drag-over-right');
            });
            
            if (typeof checkTabScroll === 'function') checkTabScroll();
        });
    }

    // Tab Scrolling
    const tabsContainer = document.getElementById('viewer-tabs');
    const scrollLeftBtn = document.getElementById('tab-scroll-left');
    const scrollRightBtn = document.getElementById('tab-scroll-right');
    
    function checkTabScroll() {
        if (!tabsContainer || !scrollLeftBtn || !scrollRightBtn) return;
        
        if (tabsContainer.scrollWidth > tabsContainer.clientWidth) {
            if (tabsContainer.scrollLeft > 0) {
                scrollLeftBtn.classList.remove('hidden');
            } else {
                scrollLeftBtn.classList.add('hidden');
            }
            
            if (tabsContainer.scrollLeft + tabsContainer.clientWidth < tabsContainer.scrollWidth - 1) {
                scrollRightBtn.classList.remove('hidden');
            } else {
                scrollRightBtn.classList.add('hidden');
            }
        } else {
            scrollLeftBtn.classList.add('hidden');
            scrollRightBtn.classList.add('hidden');
        }
    }
    
    if (tabsContainer) {
        tabsContainer.addEventListener('scroll', checkTabScroll);
        window.addEventListener('resize', checkTabScroll);
        
        const observer = new MutationObserver(checkTabScroll);
        observer.observe(tabsContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        
        if (scrollLeftBtn) {
            scrollLeftBtn.addEventListener('click', () => {
                tabsContainer.scrollBy({ left: -150, behavior: 'smooth' });
            });
        }
        
        if (scrollRightBtn) {
            scrollRightBtn.addEventListener('click', () => {
                tabsContainer.scrollBy({ left: 150, behavior: 'smooth' });
            });
        }
        
        // Initial check
        setTimeout(checkTabScroll, 100);
    }
    
    // Evaluate Data natively now that all event bindings are configured
    const keylogUrl = params.get('keylog');

    if (srcUrl) {
        const transformedSrcUrl = transformWptUrl(srcUrl);
        try {
            await resetViewerState();
            showLoading(`Downloading: ${transformedSrcUrl}`);
            const response = await fetchRemote(transformedSrcUrl);

            let keylogBuffer = null;
            if (keylogUrl) {
                showLoading(`Downloading keylog: ${keylogUrl}`);
                try {
                    const keylogResponse = await fetchRemote(keylogUrl);
                    keylogBuffer = await keylogResponse.arrayBuffer();
                } catch (e) {
                    console.warn(`Failed to fetch keylog: ${e.message}`);
                }
            }
            
            showLoading("Processing Network Data...");
            const buffer = await response.arrayBuffer();
            
            const processOpts = Object.assign({}, urlOptions, { historyMode: 'replace' });
            await processData(buffer, processOpts, keylogBuffer);

            try {
                let type = waterfallTool ? waterfallTool._sourceFormat : 'unknown';
                let testUrl = '';
                let numPages = 0;
                if (waterfallTool && waterfallTool.data && waterfallTool.data.pages) {
                    const pageKeys = Object.keys(waterfallTool.data.pages);
                    numPages = pageKeys.length;
                    if (numPages > 0) {
                        const firstPage = waterfallTool.data.pages[pageKeys[0]];
                        testUrl = firstPage._URL || '';
                        if (!testUrl && firstPage.requests) {
                            const reqKeys = Object.keys(firstPage.requests);
                            if (reqKeys.length > 0) {
                                testUrl = firstPage.requests[reqKeys[0]].url;
                            }
                        }
                        if (!testUrl) testUrl = firstPage.url || firstPage.id || '';
                    }
                }
                saveToHistory({ url: srcUrl, type, title: '', testUrl, numPages }).catch(e => console.warn('Failed to save to history:', e));
            } catch(e) {}
        } catch(e) {
            console.error(e);
            showError(`Failed fetching remote file: ${e.message}`);
        }
    } else {
        ui.dropZone.classList.remove('hidden');
    }
}

// --- History Tab UI Logic ---
let historyData = [];
let historySortField = 'firstLoaded';
let historySortDesc = true;
let historyPage = 1;

async function loadAndRenderHistory() {
    ui.canvasContainer.classList.add('hidden');
    ui.tileView.classList.add('hidden');
    ui.dropZone.classList.add('hidden');
    ui.historyView.classList.remove('hidden');

    historyData = await getAllHistory();
    renderHistoryTable();
}

function renderHistoryTable() {
    // 1. Filter
    const query = (ui.historyFilter.value || '').toLowerCase();
    let filtered = historyData;
    if (query) {
        filtered = historyData.filter(r => 
            (r.testUrl && r.testUrl.toLowerCase().includes(query)) ||
            (r.url && r.url.toLowerCase().includes(query)) ||
            (r.title && r.title.toLowerCase().includes(query)) ||
            (r.comment && r.comment.toLowerCase().includes(query)) ||
            (r.type && r.type.toLowerCase().includes(query))
        );
    }
    
    // 2. Sort
    filtered.sort((a, b) => {
        let valA = a[historySortField] || '';
        let valB = b[historySortField] || '';
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (valA < valB) return historySortDesc ? 1 : -1;
        if (valA > valB) return historySortDesc ? -1 : 1;
        return 0;
    });
    
    // 3. Paginate
    const pageSize = parseInt(ui.historyPageSize.value, 10);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (historyPage > totalPages) historyPage = totalPages;
    if (historyPage < 1) historyPage = 1;
    
    ui.historyPageInfo.textContent = `Page ${historyPage} of ${totalPages} (${filtered.length} total)`;
    
    const startIdx = (historyPage - 1) * pageSize;
    const items = filtered.slice(startIdx, startIdx + pageSize);
    
    // 4. Render Headers icons
    const ths = ui.historyTable.querySelectorAll('th');
    ths.forEach(th => {
        const icon = th.querySelector('.sort-icon');
        if (icon) icon.textContent = '';
        if (th.dataset.sort === historySortField) {
            icon.textContent = historySortDesc ? '▼' : '▲';
        }
    });

    // 5. Render rows
    ui.historyTbody.innerHTML = '';
    items.forEach(row => {
        const tr = document.createElement('tr');
        
        const tdTestUrl = document.createElement('td');
        tdTestUrl.title = row.testUrl || '';
        tdTestUrl.textContent = row.testUrl || '';
        
        const tdSource = document.createElement('td');
        tdSource.title = row.url;
        tdSource.textContent = row.url;

        const tdType = document.createElement('td');
        tdType.textContent = row.type || '';
        
        const tdPages = document.createElement('td');
        tdPages.textContent = row.numPages || 0;

        const tdTitle = document.createElement('td');
        renderEditableCell(tdTitle, row.url, 'title', row.title || '');

        const tdComment = document.createElement('td');
        renderEditableCell(tdComment, row.url, 'comment', row.comment || '');
        
        const tdDate = document.createElement('td');
        const dt = row.firstLoaded ? new Date(row.firstLoaded) : new Date();
        tdDate.textContent = dt.toLocaleString();
        
        tr.append(tdTestUrl, tdSource, tdType, tdPages, tdTitle, tdComment, tdDate);
        
        tr.addEventListener('click', (e) => {
            if (e.target.closest('.history-inline-edit')) return;
            // Load it seamlessly securely bypassing browser full-reloads natively
            const urlInput = document.getElementById('url-input');
            if (urlInput) urlInput.value = row.url;
            document.getElementById('url-load-btn').click();
        });
        
        ui.historyTbody.appendChild(tr);
    });
}

function renderEditableCell(td, url, field, currentVal) {
    const wrap = document.createElement('div');
    wrap.className = 'history-inline-edit';
    
    const span = document.createElement('span');
    span.style.flex = '1';
    span.style.overflow = 'hidden';
    span.style.textOverflow = 'ellipsis';
    span.textContent = currentVal;
    
    const editBtn = document.createElement('span');
    editBtn.className = 'edit-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit';
    
    wrap.append(span, editBtn);
    td.appendChild(wrap);
    
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        wrap.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentVal;
        
        const save = async () => {
            const newVal = input.value;
            if (newVal !== currentVal) {
                await updateHistoryInfo(url, { [field]: newVal }).catch(e => console.warn(e));
                const rec = historyData.find(r => r.url === url);
                if (rec) rec[field] = newVal;
            }
            td.innerHTML = '';
            renderEditableCell(td, url, field, newVal);
        };
        
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') {
                input.blur();
            }
        });
        
        // Prevent click events natively inside input securely preventing row trigger
        input.addEventListener('click', ev => ev.stopPropagation());
        
        wrap.appendChild(input);
        input.focus();
    });
}

// Bind History Control Listeners securely natively
if (ui.historyFilter) {
    ui.historyFilter.addEventListener('input', () => { historyPage = 1; renderHistoryTable(); });
    ui.historyPageSize.addEventListener('change', () => { historyPage = 1; renderHistoryTable(); });
    ui.historyPrevBtn.addEventListener('click', () => { if (historyPage > 1) { historyPage--; renderHistoryTable(); }});
    ui.historyNextBtn.addEventListener('click', () => { 
        const pageSize = parseInt(ui.historyPageSize.value, 10);
        const totalElems = (ui.historyFilter.value) ? 
           historyData.filter(r => (r.testUrl||'').includes(ui.historyFilter.value) || (r.url||'').includes(ui.historyFilter.value)).length :
           historyData.length;
        if (historyPage < Math.ceil(totalElems / pageSize)) { historyPage++; renderHistoryTable(); };
    });
    
    ui.historyTable.querySelectorAll('th').forEach(th => {
        th.addEventListener('click', (e) => {
            if (e.target.classList.contains('resizer')) return;
            const sortId = th.dataset.sort;
            if (!sortId) return;
            if (historySortField === sortId) {
                historySortDesc = !historySortDesc;
            } else {
                historySortField = sortId;
                historySortDesc = false;
            }
            renderHistoryTable();
        });
    });
    
    // Column Resizer bindings cleanly extracting mouse deltas securely natively
    let resizerInfo = null;
    ui.historyTable.querySelectorAll('.resizer').forEach(resizer => {
        resizer.addEventListener('mousedown', (e) => {
            const th = resizer.parentElement;
            resizerInfo = {
                th,
                startX: e.pageX,
                startWidth: th.offsetWidth
            };
            resizer.classList.add('resizing');
            e.stopPropagation();
            e.preventDefault();
        });
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!resizerInfo) return;
        const dx = e.pageX - resizerInfo.startX;
        const newWidth = Math.max(50, resizerInfo.startWidth + dx);
        resizerInfo.th.style.width = `${newWidth}px`;
    });
    
    document.addEventListener('mouseup', () => {
        if (resizerInfo) {
            ui.historyTable.querySelectorAll('.resizer').forEach(r => r.classList.remove('resizing'));
            resizerInfo = null;
        }
    });
    
    if (ui.historyClearBtn) {
        ui.historyClearBtn.addEventListener('click', async () => {
            if (confirm("Are you sure you want to delete all history of viewed waterfalls?")) {
                await clearAllHistory().catch(e => console.error("Failed to clear history", e));
                historyData = [];
                historyPage = 1;
                renderHistoryTable();
            }
        });
    }
}

if (ui.historyBtn) {
    ui.historyBtn.addEventListener('click', () => {
        if (typeof history !== 'undefined') history.pushState({ view: 'history' }, '', '?view=history');
        loadAndRenderHistory();
    });
}

initViewer();
