import { Conductor } from '../../core/conductor.js';
import { Layout } from '../../renderer/layout.js';
import { WaterfallCanvas } from '../../renderer/canvas.js';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const canvasContainer = document.getElementById('canvas-container');
const canvas = document.getElementById('waterfall-canvas');
let rendererCanvas = null;

// Use native Web Stream directly
async function fileToReadable(file) {
    return file.stream();
}



async function processFiles(files) {
    if (files.length === 0) return;
    
    dropZone.innerHTML = `<h2>Loading...</h2><p>Parsing files, this could take a few seconds.</p>`;

    try {
        let mainFile = files[0];
        let keylogFile = null;

        // Try to identify a keylog file if 2 files are uploaded
        if (files.length === 2) {
            const f1Ext = files[0].name.toLowerCase();
            const f2Ext = files[1].name.toLowerCase();
            if (f1Ext.includes('key') || f1Ext.includes('.txt')) {
                keylogFile = files[0];
                mainFile = files[1];
            } else if (f2Ext.includes('key') || f2Ext.includes('.txt')) {
                keylogFile = files[1];
                mainFile = files[0];
            }
        }

        const arrayBuffer = await mainFile.arrayBuffer();
        const options = { debug: true };
        
        if (keylogFile) {
            options.keyLogInput = await fileToReadable(keylogFile);
        }

        console.log(`Processing file internally: ${mainFile.name}`);
        const resultHar = await Conductor.processBuffer(arrayBuffer, options);
        console.log('Processed HAR', resultHar);

        // Hide drop zone & show canvas container
        dropZone.classList.add('hidden');
        canvasContainer.style.display = 'block';

        const canvasWidth = canvasContainer.clientWidth || window.innerWidth - 40;
        
        // Prepare layout rows
        const { rows, dimensions, pageEvents } = Layout.calculateRows(resultHar.log.entries, canvasWidth, {
            showLegend: true,
            page: resultHar.log.pages && resultHar.log.pages.length > 0 ? resultHar.log.pages[0] : null
        });
        
        // Render rows on Canvas
        if (!rendererCanvas) {
            rendererCanvas = new WaterfallCanvas(canvas);
        }
        rendererCanvas.render(rows, dimensions, resultHar.log.entries, pageEvents);

    } catch (e) {
        dropZone.innerHTML = `<h2>Error</h2><p>${e.message}</p><button id="retry-btn">Try Again</button>`;
        document.getElementById('retry-btn').addEventListener('click', () => location.reload());
        console.error(e);
    }
}

// Event Listeners

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-active'), false);
});
['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-active'), false);
});

dropZone.addEventListener('drop', (e) => processFiles(e.dataTransfer.files));
