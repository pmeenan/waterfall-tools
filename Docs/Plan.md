# Waterfall Tools Implementation Plan

This document breaks down the development of the Waterfall Tools library into independent, bite-sized tasks suitable for an AI agent to tackle sequentially. We are adopting a **Bottom-Up, CLI-First** approach. By building standalone input processors first, we establish robust, known-good data fixtures that downstream UI and rendering systems can rely on immediately.

## Phase 1: Core Setup & Schema Definition
**Goal:** Establish the project structure and strictly define the Extended HAR schema.
- [x] Initialize the Node project configuration with Rollup/Vite.
- [x] Create the directory structure outlined in `Docs/Architecture.md`.
- [x] Establish `Sample/Data/` with format sub-folders and `Sample/Implementations/` for reference Python scripts.
- [x] Define the Extended HAR schema core typing in `src/core/har-types.js`. **Crucially**, base this extended schema on the specific HAR file format structure utilized by WebPageTest, referencing the examples located in `Sample/Data/HARs/WebPageTest/`.

## Phase 2: Standalone Input Processors (CLI First)
**Goal:** Build independent, highly-testable parsers for each input type that generate the standardized HAR payload.
- [x] Implement `src/inputs/har.js` to accept raw standard HAR files and normalize them into the strictly structured Extended HAR format.
- [x] Build a stand-alone CLI mode wrapper for the HAR parser that takes an input file and generates the intermediary HAR file output.
- [x] Create automated tests validating the HAR parser against known-good sample outputs, explicitly testing HAR files from WebPageTest, Chrome, and Firefox.
  *Note: Validation uses `node:test` against static pre-rendered `tests/fixtures/` snapshots generated natively by the CLI to enforce immutable verification of streaming decoders.*
- [x] Add decoding, processing, and validation for WebPageTest JSON formats (`src/inputs/wpt-json.js`).
- [x] Add decoding, processing, and validation for Netlog formats (`src/inputs/netlog.js`).
- [x] Add decoding, processing, and validation for Chrome Dev Tools Protocol (CDP) formats (`src/inputs/cdp.js`).
- [x] Add decoding, processing, and validation for Chromium trace formats (`src/inputs/chrome-trace.js`).
- [x] Add decoding, processing, and validation for tcpdump formats (`src/inputs/tcpdump.js`), executed in the following sub-steps:
  *(Note: The underlying binary streamer `PcapParser` processes `Uint8Array` chunks natively. PCAPNG support is implemented based on the spec but contains TODOs marking missing IDB timestamp mappings pending `pcapng` file-based tests. The parser itself handles initial structural decoding out to `Ethernet, IPv4/6, TCP, UDP` fields.)*
  - [x] **Capture Parsing:** Parse the capture file into packets.
  - [x] **TLS Key Log Loading:** Load the TLS key log that matches the given tcpdump capture file (or extract embedded key logs from cap file bundles).
    *(Note: Sample key logs are located in `Sample/Data/tcpdump/` alongside the PCAPs. The key log files have the exact same base file name as their corresponding `.cap.gz` captures, but end in `.key_log.txt.gz`.)*
  - [x] **TCP Stream Reconstruction:** Build raw data streams for TCP (with timestamps for each segment) based on src/dest IP/port and SYN/FIN packets. Handle retransmits, overlapping windows, and out-of-order packets.
  - [x] **UDP Stream Reconstruction:** Build virtual connection "streams" for UDP based on packet numbers and src/dest IP/ports.
  - [x] **TCP TLS Decryption:** Decrypt TLS-encrypted TCP streams using the key log, keeping per-chunk timestamps that match packet timings. (Reference RFC specs or utilize/build stand-alone utility libraries for TLS decoding).
  - [x] **TCP Protocol Decoding:** Detect and decode HTTP/1.x, HTTP/2, and DNS over HTTP from unencrypted TCP streams into extractable individual requests (including connection setup and affinity info).
  - [x] **UDP Protocol Detection & QUIC Decryption:** Detect DNS and QUIC formats on UDP. For TLS-encrypted QUIC, decrypt the stream using the keylog.
  - [x] **DNS Decoding:** Decode DNS traffic (from both UDP and TCP/DoH) and store the lookups to add to request timings.
  - [x] **QUIC Decoding:** Decode unencrypted QUIC traffic to extract streams and parse the relevant requests.
  - [x] **Page Entry Creation:** Create a virtual "page" entry. Use the first HTTP request with `Sec-Fetch-Dest: document` as the page URL, defaulting to the first HTTP request if none is found.
  - [x] **HAR Generation & Validation:** Turn the decoded protocols from the tcpdump processing into requests and page data that can be used for generating the HAR format and then the creation and validation of the resulting HAR from the tcpdump input.
- [x] Restructure the `src/inputs` directory so that the core libraries are separated from the cli interfaces and utility functions (in a logical grouping in separate folders) so it's not a flat, giant collection of files. If it makes sense, the core libraries can be at the root.

## Phase 3: The Orchestrator & API
**Goal:** Build the central `conductor` that intelligently manages inputs and acts as the developer API.
- [x] Implement `src/inputs/orchestrator.js` to manage registered source parsers.
- [x] Implement auto-detection logic to identify if a raw input payload is a HAR, Chrome Trace, WPT, or other supported format based on the payload, not the file name (and automatically handle gzipped versions of each).
- [x] Create the `src/core/conductor.js` main class export that coordinates between the auto-detected parser and the intermediary output format. It should support streaming input, raw data and files as input. It should also support the caller providing a key log for TLS decryption and should support a cli for passing in any of the supported file formats and outputting the HAR file (with a `--keylog` option for TLS decryption and a simple, descriptive, short file name).

## Phase 4: Headless Outputs
**Goal:** Generate raw data exports directly from the proven Orchestrator state.
- [x] Implement `src/outputs/simple-json.js` to boil down HAR data to an array of strictly simplified request objects suitable for generic JS usage.
- [x] Create basic unit tests for the HAR input -> Simple JSON output pipeline.

## Phase 5: Core Canvas Renderer (Browser Platform)
**Goal:** Render a static waterfall chart to a canvas element utilizing the verified data fixtures from Phase 2.
- [x] Implement `src/renderer/layout.js` to calculate row heights, X-axis timestamps, scale distributions and standard WebPageTest color coding.
- [x] Implement `src/renderer/canvas.js` to draw requests as cascading blocks on a provided `<canvas>`.
- [x] Implement logic to leverage `requestAnimationFrame` ensuring efficient updates and redraws. 

## Phase 6: Client Interactions
**Goal:** Make the canvas waterfall interactive without using individual DOM elements.
- [ ] Implement `src/renderer/interaction.js` to track mouse movements and click events over the active canvas.
- [ ] Map active spatial indexes on screen to corresponding data representations behind the scenes to identify hovering dynamically.
- [ ] Build customizable Hooks ("Hover", "Click") for host application overrides and tooltips.
- [ ] Implement X-axis zooming (scaling time bounding) and conditional visibility filtering (e.g. selectively hiding 404s, domains).

## Phase 7: Website Embed Interfaces
**Goal:** Easy drop-in architecture components into fully functioning generic webpages.
- [ ] Implement `src/embed/div-embed.js` to accept a `<div id="target">` element and an Extended HAR object (or automated fetch URL proxy), automatically bootstrapping the canvas and binding relative interactions without external involvement.
- [ ] Implement `src/embed/iframe-embed.js` parsing `window.location.search` for configuration data, query params representing data points, to subsequently render fully encapsulated visualizations inherently.

## Phase 8: Environment Adapters & Image Generation
**Goal:** Allow creating static images and ensure robust server-side context scaling.
- [ ] Add explicit platform abstraction definitions within `src/platforms/`.
- [ ] Prepare Node integrations targeting offscreen canvas or node-canvas counterparts.
- [ ] Implement `src/outputs/image.js` to digest render data straight into raw image buffer sets / Base64 serialization outputs snapshotting views.
- [ ] Implement `src/outputs/thumbnail.js` for scaled-down structural representations equivalent to complete image generation maps.

## Phase 9: Headless External Viewers Extension
**Goal:** Expose compatibility channels sending intermediate payloads accurately directly into alternative rendering viewers.
- [ ] Engineer wrapper bridging in `src/embed/external/perfetto.js` pushing Extended HAR representations uniformly into Perfetto UI layers.
- [ ] Connect structured HAR objects appropriately into hosted versions matching embedded Chrome DevTools network tab ingestion format guidelines.

## Phase 10: Filmstrip View Integration (Future Roadmap)
**Goal:** Construct visual timestamp representations displaying exact render screenshots above waterfall requests over time.
- [ ] Add explicit intermediary references coupling standard timeline moments to image frames natively into standard HAR output objects.
- [ ] Bootstrap `src/filmstrip/` interfaces configured to inject array bundles composing individual images or trace screenshots efficiently.
- [ ] Build renderer sub-layers synchronizing active progression cursor overlays mapping trace screenshots alongside specific timeframe elements live.
