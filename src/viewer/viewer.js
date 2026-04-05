import { WaterfallTools } from '../core/waterfall-tools.js';
import { identifyFormatFromBuffer } from '../inputs/orchestrator.js';

const ui = {
    loading: document.getElementById('loading'),
    loadingText: document.getElementById('loading-text'),
    dropZone: document.getElementById('drop-zone'),
    canvasContainer: document.getElementById('canvas-container'),
    waterfallView: document.getElementById('waterfall-view'),
    fileInput: document.getElementById('file-input'),
    uploadBtn: document.getElementById('upload-btn'),
    tileView: document.getElementById('tile-view'),
    tileGrid: document.getElementById('tile-grid'),
    btnBackTiles: document.getElementById('btn-back-tiles'),
    btnSettings: document.getElementById('btn-settings'),
    settingsOverlay: document.getElementById('settings-overlay'),
    btnSettingsClose: document.getElementById('btn-settings-close'),
    viewerTitle: document.getElementById('viewer-title')
};

let waterfallTool = null;
let rendererCanvas = null;
let activeBlobUrls = [];

function showLoading(text = 'Loading...') {
    ui.loadingText.textContent = text;
    ui.loading.classList.remove('hidden');
    ui.dropZone.classList.add('hidden');
    ui.canvasContainer.classList.add('hidden');
    ui.tileView.classList.add('hidden');
}

function hideLoading() {
    ui.loading.classList.add('hidden');
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

function getMetricItemHtml(label, value) {
    if (!value || value === 'N/A') return '';
    return `
        <div class="metric-item">
            <span class="metric-label">${label}</span>
            <span class="metric-value">${value}</span>
        </div>
    `;
}

async function renderTiles(pushHistory = true) {
    if (pushHistory) history.pushState({ view: 'tiles' }, '');
    ui.canvasContainer.classList.add('hidden');
    ui.tileView.classList.remove('hidden');
    ui.tileGrid.innerHTML = '';
    const pageKeys = Object.keys(waterfallTool.data.pages);

    activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
    activeBlobUrls = [];

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
            console.log(`[viewer.js] Requesting screenshot for ${pageId}...`);
            const resource = await waterfallTool.getPageResource(pageId, 'screenshot');
            console.log(`[viewer.js] Resource resolved for ${pageId}:`, resource ? resource.mimeType : 'null');
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
}

async function renderWaterfall(pageId, overridingOptions = {}, pushHistory = true) {
    if (pushHistory) history.pushState({ view: 'waterfall', pageId }, '');
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
}

async function processData(arrayBuffer, options = {}, keylogArrayBuffer = null) {
    try {
        if (rendererCanvas) {
            rendererCanvas.destroy();
            rendererCanvas = null;
        }

        waterfallTool = new WaterfallTools();
        
        const loadOptions = { debug: false };
        if (keylogArrayBuffer) {
             const blob = new Blob([keylogArrayBuffer]);
             loadOptions.keyLogInput = await fileToReadable(blob);
        }

        await waterfallTool.loadBuffer(arrayBuffer, loadOptions);

        hideLoading();
        ui.dropZone.classList.add('hidden');

        const pageKeys = Object.keys(waterfallTool.data.pages);
        if (pageKeys.length > 1) {
            await renderTiles();
        } else if (pageKeys.length === 1) {
            await renderWaterfall(pageKeys[0], options);
        }

    } catch (e) {
        console.error(e);
        showError(e.message || 'Error processing network data');
    }
}

async function processFiles(files) {
    if (files.length === 0) return;
    showLoading('Parsing files...');

    try {
        let mainFile = files[0];
        let keylogFile = null;

        if (files.length === 2) {
            const arr0 = await files[0].arrayBuffer();
            const format0 = (await identifyFormatFromBuffer(arr0)).format;

            const arr1 = await files[1].arrayBuffer();
            const format1 = (await identifyFormatFromBuffer(arr1)).format;

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

window.WaterfallViewer = {
    loadData: async (bufferOrFile, options = {}) => {
        showLoading('Loading Programmatically...');
        if (bufferOrFile instanceof File || bufferOrFile instanceof Blob) {
            const buf = await bufferOrFile.arrayBuffer();
            return processData(buf, options);
        } else if (bufferOrFile instanceof ArrayBuffer) {
            return processData(bufferOrFile, options);
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

async function initViewer() {
    const params = new URLSearchParams(window.location.search);
    const srcUrl = params.get('src');

    if (srcUrl) {
        try {
            showLoading(`Downloading: ${srcUrl}`);
            const response = await fetch(srcUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            showLoading("Processing Network Data...");
            const buffer = await response.arrayBuffer();
            await processData(buffer);
        } catch(e) {
            console.error(e);
            showError(`Failed fetching remote file: ${e.message}`);
        }
    } else {
        ui.dropZone.classList.remove('hidden');
    }
    
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

    // Nav Bindings
    ui.btnBackTiles.addEventListener('click', () => {
         renderTiles();
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
        });
    });

    Object.keys(overlayInputMapping).forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', (e) => {
                const optKey = overlayInputMapping[id];
                const optVal = e.target.checked;
                window.WaterfallViewer.updateOptions({ [optKey]: optVal });
            });
        }
    });

    // History API bindings
    window.addEventListener('popstate', (e) => {
        if (!waterfallTool || !waterfallTool.data || !waterfallTool.data.pages) return;
        const state = e.state;
        if (state) {
            if (state.view === 'tiles') {
                renderTiles(false);
            } else if (state.view === 'waterfall' && state.pageId) {
                renderWaterfall(state.pageId, {}, false);
            }
        } else {
            const keys = Object.keys(waterfallTool.data.pages);
            if (keys.length > 1) renderTiles(false);
            else if (keys.length === 1) renderWaterfall(keys[0], {}, false);
            else {
                ui.canvasContainer.classList.add('hidden');
                ui.tileView.classList.add('hidden');
                ui.dropZone.classList.remove('hidden');
            }
        }
    });
}

initViewer();
