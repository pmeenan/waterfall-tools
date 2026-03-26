# Waterfall Tools: AI Agent Guidance & Context

Welcome. You are working on the **Waterfall Tools** library, a powerful, robust, and client-side solution for displaying detailed network request waterfalls akin to WebPageTest.

## 🎯 Directives for AI Agents

When working on this codebase, you must adhere to the following strict architectural principles:

1. **Zero Bloat & Peak Performance:**
   - **No Heavy Frameworks:** This library must remain exceptionally fast, lightweight, and entirely distributable. Rely explicitly upon **Vanilla JavaScript**. Do not introduce React, Vue, Svelte, or Angular under any circumstances within the core lib space.
   - **DOM Performance:** Avoid generating thousands of DOM elements (e.g., specific divs for every network request). Network waterfalls frequently exceed 1,000+ requests globally. Rendering must leverage raw native `<canvas>` operations optimizing for seamless 60fps scrolling latency buffers.

2. **The Intermediary Format (Extended HAR):**
   - Feature rendering cannot tightly couple against raw unique inputs (eg. directly rendering an external WebPageTest object without conversions).
   - Every input format **MUST** map entirely to the standard **Extended HAR format** payload pipeline immediately prior to engaging renderer states or internal processor hooks.
   - The generated HAR **MUST** include a `creator` object within `log` identifying `waterfall-tools` as the generating tool.
   - When broadening properties beyond the standard HAR `1.2` specification schema logic, always strictly prefix keys with an underscore `_` (e.g., `_priority`, `_renderBlockingConstraints`, `_initiator`). 

3. **Pluggable & Declarative Architecture:**
   - Component classes defining input modules (`src/inputs/`), output modules (`src/outputs/`), embed viewers (`src/embed/`), and drawing renderers (`src/renderer/`) are decoupled entities deliberately separated inherently.
   - The primary orchestrator object operates uniquely by transporting verified Extended HAR data uniformly across specific decoupled systems cleanly without implicit mutation states.
   - Modules must export structurally permitting granular bundler operations like Webpack, Vite or Rollup safely tree-shaking specific elements entirely out of arbitrary compilation phases natively. (A consumer integrating browser-only HAR generation shouldn't package unused Node libraries).

4. **Environment Nuances:**
   - Code residing fundamentally inside `src/core/`, `src/inputs/`, and `src/outputs/` strictly stays conditionally isomorphic. Ensure runtime viability targeting concurrently Node.js and Browser JS endpoints safely.
   - Interaction demanding Web APIs like (`fetch()`, `HTMLCanvasElement`, browser `window`) isolate explicitly into segmented folders encompassing respectively `src/platforms/browser/`, `src/renderer/`, or `src/embed/`. Node native tools (`fs` integration pipelines) deploy cleanly only into `src/platforms/node/`.

5. **Future-Proofing Hardware Considerations:**
   - Ensure the structure accommodates adopting powerful native WASM instances gracefully isolated internally exclusively for computationally heavy future requirements, for example massive Chrome Trace unzipping / reduction iterations or binary frame unpacking processes. Image compilation explicitly respects standardized Canvas APIs first natively across operations naturally.

6. **CLI Modes & Testing Validation:**
   - Each input format MUST feature a stand-alone CLI mode wrapper capable of ingesting an input file and exporting the normalized intermediary Extended HAR serialization. 
   - Write comprehensive tests asserting that parsing sample logic matches established "known-good" HAR output targets (generated during initial implementations) perfectly.

7. **Sample Assets Organization:**
   - Store all sample files for respective data formats cleanly partitioned within the `Sample/Data/` root (e.g., `Sample/Data/HAR/sourceA`, `Sample/Data/ChromeTrace/site1`).
   - If writing or utilizing reference parsing implementations (like exploratory Python scripts decoding specific unmapped formats), place them explicitly in `Sample/Implementations/` mapped by format folders inherently.
