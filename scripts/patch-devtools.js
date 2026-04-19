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
