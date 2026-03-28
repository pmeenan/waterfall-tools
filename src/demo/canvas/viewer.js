import { Conductor } from '../../core/conductor.js';
import { Readable } from 'stream';
import { Layout } from '../../renderer/layout.js';
import { WaterfallCanvas } from '../../renderer/canvas.js';
import zlib from 'zlib';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const canvasContainer = document.getElementById('canvas-container');
const canvas = document.getElementById('waterfall-canvas');
let rendererCanvas = null;

// Convert browser File to Node.js Readable stream (polyfill)
async function fileToReadable(file) {
    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    return new Readable({
        read() {
            this.push(buf);
            this.push(null);
        }
    });
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
        const options = {};
        
        if (keylogFile) {
            options.keyLogInput = await fileToReadable(keylogFile);
        }

        console.log(`Processing file internally: ${mainFile.name}`);
        const resultHar = await Conductor.processBuffer(arrayBuffer, options);
        console.log('Processed HAR', resultHar);

        // Hide drop zone & show canvas container
        dropZone.classList.add('hidden');
        canvasContainer.style.display = 'block';

        // Prepare layout rows
        const { rows, dimensions } = Layout.calculateRows(resultHar.log.entries);
        
        // Render rows on Canvas
        if (!rendererCanvas) {
            rendererCanvas = new WaterfallCanvas(canvas);
        }
        rendererCanvas.render(rows, dimensions, resultHar.log.entries);

    } catch (e) {
        dropZone.innerHTML = `<h2>Error</h2><p>${e.message}</p><button id="retry-btn">Try Again</button>`;
        document.getElementById('retry-btn').addEventListener('click', () => location.reload());
        console.error(e);
    }
}

// Event Listeners
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => processFiles(e.target.files));

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
