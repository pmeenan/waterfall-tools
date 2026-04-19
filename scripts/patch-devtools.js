// Shared patches applied to the prebuilt Chrome DevTools bundle before it is served
// from the viewer (both production build and dev middleware use these).
//
// The @chrome-devtools/index npm package is a direct export of the in-Chromium DevTools
// frontend; a handful of code paths reference Node.js built-ins that the bundler didn't
// strip because they're guarded at runtime. Statically-imported ones still need the
// module specifier to resolve in a browser or the whole chunk fails to load.

// Replace `import*as X from"node:worker_threads"` with an inert stub. The bundle references
// node:worker_threads through a server-only worker-host wrapper class whose constructor is
// never invoked in the browser code path — so a stub that satisfies the static import is
// enough. Leaving it in place triggers a CSP violation (node: not in script-src) and then
// a module-resolution failure.
export function patchNodeWorkerThreadsImport(src) {
    return src.replace(
        /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']node:worker_threads["']/g,
        'var $1={parentPort:null,Worker:class{}}'
    );
}

// The prebuilt @chrome-devtools/index flattens every asset (SVG, PNG, AVIF, JS chunk) into
// the package root, but several image URLs in the JS chunks still carry the parent-relative
// paths from the original source-tree layout (e.g. `new URL("../../../Images/foo.svg",
// import.meta.url)`). `new URL` resolves these against the chunk's import.meta.url, escaping
// the `devtools-<version>/` directory and landing on `/Images/foo.svg` at the document root.
// Since the images are actually co-located with the chunk, collapsing `../../Images/` and
// `../../../Images/` prefixes to `./` fixes the resolution.
export function patchFlattenedImagePaths(src) {
    return src.replace(
        /"(\.\.\/)+Images\/([^"\\]+)"/g,
        '"./$2"'
    );
}

// Hide the top-level DevTools tab strip (Elements / Console / Sources / … / Performance).
// We only ever expose the Performance panel to the user and none of the other panels can
// consume the trace we load, so the strip is dead weight. The rule targets the specific
// `aria-label="Main toolbar"` attribute so that nested tabbed panes (Performance panel's
// own sub-tabs) are unaffected. The rule is prepended to the tabbedPane.css template
// literal in the bundle — that CSS is registered into every TabbedPane shadow root, so
// document-level styles can't reach it; the override has to ride along with the same CSS.
export function patchHideMainToolbar(src) {
    const anchor = '.tabbed-pane-header {\n  display: flex;';
    const override = '.tabbed-pane-header[aria-label="Main toolbar"]{display:none !important}\n';
    if (!src.includes(anchor)) return src;
    return src.replace(anchor, override + anchor);
}

// Apply every patch the bundle needs for browser hosting.
export function patchDevtoolsBundle(src) {
    return patchHideMainToolbar(patchFlattenedImagePaths(patchNodeWorkerThreadsImport(src)));
}
