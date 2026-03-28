# Waterfall Tools

Waterfall Tools is a robust, performant library for parsing, analyzing, and visualizing complex network waterfalls dynamically in the browser or via Node.js. It standardizes vastly differing network trace formats (like PCAP, Netlog, Chrome Trace, CDP, WebPageTest) into a unified Extended HAR (HTTP Archive) payload, then leverages native `<canvas>` APIs to naturally draw fast, accurate, WebPageTest-style interactive waterfall charts without causing sluggish DOM layout recalculations.

## Features

- **Format Agnostic**: Easily parses `HAR`, `Netlog`, `Chrome Trace`, `CDP`, `WebPageTest JSON`, and raw `TCPDUMP` captures (with automatic TLS/QUIC payload decryption support).
- **Core Orchestrator (`Conductor`)**: Unified API that identifies format types automatically, parsing them uniformly into strict structurally-sound Extended HAR outputs.
- **Isomorphic Architecture**: The core generative pipelines naturally run natively inside Node.js, and directly alongside Vite projects inside modern Browsers (assuming `stream` / `crypto` bundle polyfills).
- **Zero DOM-Bloat Canvas Renderer**: Scales cleanly visually scaling to render 50 or 50,000 requests smoothly, mitigating severe `O(N)` UI thrashing typical in trace viewer projects.

For a deeper dive into the system's design architecture, logic conventions, and folder hierarchy, see [Docs/Architecture.md](Docs/Architecture.md).

## Installation (coming soon)

```bash
npm install waterfall-tools
```

## API Usage

Ensure your build system supports generic ESModules (`"type": "module"` natively out-of-the-box). The unified interface for the tools is the core `Conductor` artifact.

### Processing a Local File (Node.js)

```javascript
import { Conductor } from 'waterfall-tools/core/conductor.js';

// Automatically identifies the file format natively (No options required!)
const waterfallHar = await Conductor.processFile('./trace.cap.gz');

console.log(`Successfully generated HAR with ${waterfallHar.log.entries.length} requests`);
```

### Processing a Stream (Browser or Node.js)

```javascript
import { Conductor } from 'waterfall-tools/core/conductor.js';
import { Readable } from 'stream'; // Handled globally via NodeJS, polyfilled natively targeting browsers

// Note: You must explicitly specify `options.format` when piping a streaming target.
const fileStream = Readable.from(Buffer.from(await uploadedFile.arrayBuffer()));

const waterfallHar = await Conductor.processStream(fileStream, { 
    format: 'tcpdump', 
    isGz: true, 
    keyLogInput: keyLogStream // You can concurrently explicitly provide TLS keylog hooks!
});
```

### Processing a Non-Streaming Buffer (Browser or Node.js)

```javascript
import { Conductor } from 'waterfall-tools/core/conductor.js';

// When you already have the file totally loaded in memory (Buffer, ArrayBuffer, Uint8Array):
const bufferData = await uploadedFile.arrayBuffer();

// The core engine will automatically sniff the array bytes identifying formats naturally!
const waterfallHar = await Conductor.processBuffer(bufferData);
```

### Loading from an External URL (Browser or Node.js)

```javascript
import { Conductor } from 'waterfall-tools/core/conductor.js';

// The library automatically fetches, extracts, sniffs, and processes remote trace payloads.
const waterfallHar = await Conductor.processURL('https://example.com/trace.json.gz');
```

### Visualizing using the View Engine (Browser Context)

```javascript
import { Layout } from 'waterfall-tools/renderer/layout.js';
import { WaterfallCanvas } from 'waterfall-tools/renderer/canvas.js';

// Convert HAR requests strictly into calculated spatial bounding box structures
const { rows, dimensions } = Layout.calculateRows(waterfallHar.log.entries);

// Render directly into an existing literal <canvas> element securely mapping DOM dimensions
const boundingDimensionsCanvas = document.getElementById('waterfall-canvas');
const renderEngine = new WaterfallCanvas(boundingDimensionsCanvas);

renderEngine.render(rows, dimensions, waterfallHar.log.entries);
```

## CLI Interface

The package ships securely with a fully operational terminal interface automating the processing payloads down into their unified HAR outputs directly from your shell configurations.

```bash
npx waterfall-tools dump.cap.gz --keylog dump_keys.txt.gz > compiled-output.har
```

## Developer Contribution Guide

If you are cloning this repository to build, modify, or run native integrations:

### Initial Setup
```bash
npm install
```

### Validate against Fixtures
Testing strictly relies on validating standard stream processors against native `.json` reference golden fixtures securely tracking structural mutations.
```bash
# Leverages Vitest sequentially locally
npm run test
```

### Compile Library Assets
```bash
# Builds standardized Universal Module Definitions (UMD) & pure ESModules natively into `/dist`
npm run build
```

### Utilizing Local Demos (Canvas Viewers)
An interactive Drag-and-Drop frontend showcase wrapper directly maps `src/demo` pipelines naturally testing your active core adjustments graphically.
```bash
# Launch Dev Server locally to quickly validate interface updates
npm run dev:demo

# Hard compile frontend standalone viewers fully targeting `bin/demo/` distributions
npm run build:demo
```
