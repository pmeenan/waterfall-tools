import { WaterfallTools } from '../../core/waterfall-tools.js';
import { identifyFormatFromBuffer } from '../../inputs/orchestrator.js';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const canvasContainer = document.getElementById('canvas-container');

let rendererCanvas = null;

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

        if (rendererCanvas) {
            rendererCanvas.destroy(); // Safely clean up previous rendering bounds natively
        }
        
        // Pass parent container binding explicitly utilizing standard architectural map cleanly
        rendererCanvas = await tool.renderTo(canvasContainer, { showLegend: true });

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
