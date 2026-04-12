/*
 * Copyright 2006 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */
import { WaterfallTools } from '../../core/waterfall-tools.js';
import { identifyFormatFromBuffer } from '../../inputs/orchestrator.js';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const canvasContainer = document.getElementById('canvas-container');
const uiSidebar = document.getElementById('sidebar');
const statusBar = document.getElementById('interaction-status-bar');

function updateStatus(type, payload) {
    if (!payload) {
        statusBar.textContent = `Latest Interaction: ${type} (None)`;
        return;
    }
    const idx = payload.index !== undefined ? payload.index : '?';
    const reqId = payload.request.id !== undefined ? payload.request.id : '?';
    const url = payload.request.url ? payload.request.url.substring(0, 60) + (payload.request.url.length > 60 ? '...' : '') : 'unknown';
    statusBar.textContent = `Latest Interaction: ${type} | Index: ${idx} | ID: ${reqId} | URL: ${url}`;
}

const uiPageSelect = document.getElementById('ui-page-select');
const uiViewType = document.getElementById('ui-view-type');
const uiThumbView = document.getElementById('ui-thumb-view');
const uiStartTime = document.getElementById('ui-start-time');
const uiEndTime = document.getElementById('ui-end-time');
const uiReqFilter = document.getElementById('ui-req-filter');
const uiShowPageMetrics = document.getElementById('ui-show-page-metrics');

const uiShowMarks = document.getElementById('ui-show-marks');
const uiShowCpu = document.getElementById('ui-show-cpu');
const uiShowBw = document.getElementById('ui-show-bw');
const uiShowMainthread = document.getElementById('ui-show-mainthread');
const uiShowLongtasks = document.getElementById('ui-show-longtasks');
const uiShowMissing = document.getElementById('ui-show-missing');
const uiShowLabels = document.getElementById('ui-show-labels');
const uiShowChunks = document.getElementById('ui-show-chunks');
const uiShowJs = document.getElementById('ui-show-js');
const uiShowWait = document.getElementById('ui-show-wait');

let rendererCanvas = null;

// Initialize UI with defaults
const defaultOptions = WaterfallTools.getDefaultOptions();
uiShowPageMetrics.checked = defaultOptions.showPageMetrics;
uiShowMarks.checked = defaultOptions.showMarks;
uiShowCpu.checked = defaultOptions.showCpu;
uiShowBw.checked = defaultOptions.showBw;
uiShowMainthread.checked = defaultOptions.showMainthread;
uiShowLongtasks.checked = defaultOptions.showLongtasks;
uiShowMissing.checked = defaultOptions.showMissing;
uiShowLabels.checked = defaultOptions.showLabels;
uiShowChunks.checked = defaultOptions.showChunks;
uiShowJs.checked = defaultOptions.showJsTiming;
uiShowWait.checked = defaultOptions.showWait;
// Use native Web Stream directly
async function fileToReadable(file) {
    return file.stream();
}



async function processFiles(files) {
    if (files.length === 0) return;
    
    dropZone.classList.remove('hidden');
    dropZone.innerHTML = `<h2>Loading...</h2><p>Parsing files, this could take a few seconds.</p>`;

    try {
        let mainFile = files[0];
        let keylogFile = null;

        // Try to identify a keylog file if 2 files are uploaded
        if (files.length === 2) {
            const arr0 = await files[0].arrayBuffer();
            const format0 = (await identifyFormatFromBuffer(arr0)).format;
            console.log(`[viewer.js] Successfully identified ${files[0].name} as format: ${format0}`);

            const arr1 = await files[1].arrayBuffer();
            const format1 = (await identifyFormatFromBuffer(arr1)).format;
            console.log(`[viewer.js] Successfully identified ${files[1].name} as format: ${format1}`);

            if (format0 === 'tcpdump' && format1 === 'keylog') {
                mainFile = files[0];
                keylogFile = files[1];
                console.log(`[viewer.js] Automatically pairing ${files[0].name} (PCAP) with ${files[1].name} (Keylog)`);
            } else if (format1 === 'tcpdump' && format0 === 'keylog') {
                mainFile = files[1];
                keylogFile = files[0];
                console.log(`[viewer.js] Automatically pairing ${files[1].name} (PCAP) with ${files[0].name} (Keylog)`);
            } else {
                console.log(`[viewer.js] Defaulting processing to the first dropped file ${files[0].name} (${format0})`);
            }
        } else if (files.length === 1) {
            const arr0 = await files[0].arrayBuffer();
            const format0 = (await identifyFormatFromBuffer(arr0)).format;
            console.log(`[viewer.js] Successfully identified ${files[0].name} as format: ${format0}`);
        }

        const arrayBuffer = await mainFile.arrayBuffer();
        const options = { debug: true };
        
        if (keylogFile) {
            options.keyLogInput = await fileToReadable(keylogFile);
        }

        console.log(`Processing file internally: ${mainFile.name}`);
        const tool = new WaterfallTools();
        await tool.loadBuffer(arrayBuffer, options);
        console.log('Processed Tool Mapping Successfully');

        // Hide drop zone & show canvas container
        dropZone.classList.add('hidden');
        canvasContainer.style.display = 'block';
        uiSidebar.classList.remove('hidden');

        // Populate page select
        uiPageSelect.innerHTML = '';
        Object.keys(tool.data.pages).forEach(pageId => {
            const page = tool.data.pages[pageId];
            const opt = document.createElement('option');
            opt.value = pageId;
            opt.textContent = page.title || pageId;
            uiPageSelect.appendChild(opt);
        });

        // Set WPT External Link explicitly mapping WPT test IDs naturally
        const wptLinkContainer = document.getElementById('wpt-link-container');
        const wptLink = document.getElementById('wpt-external-link');
        if (tool.data._id) {
            wptLinkContainer.classList.remove('hidden');
            wptLink.href = `https://webpagetest.httparchive.org/result/${tool.data._id}/`;
        } else {
            wptLinkContainer.classList.add('hidden');
        }

        const getOptions = () => {
            return {
                pageId: uiPageSelect.value,
                connectionView: uiViewType.value === 'connection',
                thumbnailView: uiThumbView.checked,
                minWidth: 0,
                startTime: uiStartTime.value ? Math.max(0, parseFloat(uiStartTime.value)) : null,
                endTime: uiEndTime.value ? parseFloat(uiEndTime.value) : null,
                reqFilter: uiReqFilter.value,
                showPageMetrics: uiShowPageMetrics.checked,
                showMarks: uiShowMarks.checked,
                showCpu: uiShowCpu.checked,
                showBw: uiShowBw.checked,
                showMainthread: uiShowMainthread.checked,
                showLongtasks: uiShowLongtasks.checked,
                showMissing: uiShowMissing.checked,
                showLabels: uiShowLabels.checked,
                showChunks: uiShowChunks.checked,
                showJsTiming: uiShowJs.checked,
                showWait: uiShowWait.checked,
                showLegend: !uiThumbView.checked,
                onHover: (payload) => updateStatus('Hover', payload),
                onClick: (payload) => updateStatus('Click', payload),
                onDoubleClick: (payload) => updateStatus('DoubleClick', payload)
            };
        };

        const reRender = async () => {
            if (rendererCanvas) {
                const updatedOptions = getOptions();
                
                canvasContainer.style.flex = '';
                canvasContainer.style.width = '';
                canvasContainer.style.maxWidth = updatedOptions.thumbnailView ? '500px' : 'none';

                const pageData = tool.getPage(updatedOptions.pageId, { includeRequests: true });
                rendererCanvas.options = Object.assign(rendererCanvas.options, updatedOptions);
                rendererCanvas.render(pageData);
            }
        };

        // Attach event listeners for dynamic redraws
        const controls = [uiPageSelect, uiViewType, uiThumbView, uiStartTime, uiEndTime, uiReqFilter, uiShowPageMetrics,
            uiShowMarks, uiShowCpu, uiShowBw, uiShowMainthread, uiShowLongtasks,
            uiShowMissing, uiShowLabels, uiShowChunks, uiShowJs, uiShowWait];
        controls.forEach(c => {
            // Keep it simple and clear existing bounds if processFiles is re-run (or just overwrite)
            c.onchange = reRender;
            if (c.type === 'text' || c.type === 'number') {
                c.oninput = reRender;
            }
        });

        if (rendererCanvas) {
            rendererCanvas.destroy(); // Safely clean up previous rendering bounds natively
        }
        
        const initialOptions = getOptions();
        canvasContainer.style.flex = '';
        canvasContainer.style.width = '';
        canvasContainer.style.maxWidth = initialOptions.thumbnailView ? '500px' : 'none';
        
        // Pass parent container binding explicitly utilizing standard architectural map cleanly
        rendererCanvas = await tool.renderTo(canvasContainer, initialOptions);

    } catch (e) {
        dropZone.innerHTML = `<h2>Error</h2><p>${e.message}</p><button id="retry-btn">Try Again</button>`;
        document.getElementById('retry-btn').addEventListener('click', () => location.reload());
        console.error(e);
    }
}

// Event Listeners

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    document.body.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

let dragCounter = 0;

document.body.addEventListener('dragenter', (e) => {
    dragCounter++;
    if (dragCounter === 1) {
        dropZone.classList.remove('hidden');
        dropZone.classList.add('drag-active');
    }
});

document.body.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter === 0) {
        dropZone.classList.remove('drag-active');
        if (rendererCanvas) dropZone.classList.add('hidden');
    }
});

document.body.addEventListener('drop', (e) => {
    dragCounter = 0;
    dropZone.classList.remove('drag-active');
    processFiles(e.dataTransfer.files);
});

uploadBtn.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        processFiles(e.target.files);
    }
});
