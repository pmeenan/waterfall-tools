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
    return Readable.from(Buffer.from(arrayBuffer));
}

// Sniff file contents to determine format
async function guessFormat(file) {
    const arrayBuffer = await file.slice(0, 4096).arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    
    // Check for gzip
    const isGz = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    
    let textBuf = buf;
    if (isGz) {
        try {
            // Unzip the first chunk synchronously just to sniff
            textBuf = zlib.gunzipSync(buf);
        } catch (e) {
            // ignore partial unzip error
        }
    }
    
    if (textBuf.length >= 4) {
        const magic = textBuf.readUInt32BE(0);
        const magicLE = textBuf.readUInt32LE(0);
        if ([0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a].includes(magic) || [0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a].includes(magicLE)) {
            return { format: 'tcpdump', isGz };
        }
    }

    const minText = textBuf.toString('utf-8').replace(/\s/g, '');
    
    if (minText.includes('{"constants":') && minText.includes('"logEventTypes":')) return { format: 'netlog', isGz };
    if ((minText.startsWith('{"data":{') || minText.includes('"data":{')) && (minText.includes('"median":') || minText.includes('"runs":'))) return { format: 'wpt', isGz };
    if (minText.startsWith('{"traceEvents":') || minText.includes('{"pid":') || minText.startsWith('[{"pid":') || minText.startsWith('[{"cat":')) return { format: 'chrome-trace', isGz };
    if (minText.startsWith('[{"method":"') || minText.includes('{"method":"Network.')) return { format: 'cdp', isGz };
    if (minText.includes('{"log":{"version":') || minText.includes('{"log":{"creator":')) return { format: 'har', isGz };

    throw new Error('Could not identify file format automatically.');
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

        const { format, isGz } = await guessFormat(mainFile);
        const stream = await fileToReadable(mainFile);
        
        const options = { format, isGz };
        if (keylogFile) {
            options.keyLogInput = await fileToReadable(keylogFile);
        }

        console.log(`Processing file: ${mainFile.name} as ${format} (GZIP: ${isGz})`);
        const resultHar = await Conductor.processStream(stream, options);
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
