#!/usr/bin/env node
/*
 * Copyright 2026 Patrick Meenan
 * Licensed under the Apache License, Version 2.0.
 * See the LICENSE file for details.
 */

/**
 * Materialize the Waterfall Tools viewer into a target directory.
 *
 * Usage:
 *   waterfall-tools install-viewer <target-dir>
 *
 * Copies the viewer static assets shipped in this package into `<target-dir>`,
 * then copies the embedder's own `@chrome-devtools/index` install into
 * `<target-dir>/devtools-<version>/`, patches the DevTools bundle for browser
 * hosting, and rewrites the viewer's `<meta name="waterfall-devtools-path">`
 * to point at the versioned directory. Serve `<target-dir>` as static files.
 *
 * The DevTools bundle is ~80 MB of third-party code and is deliberately NOT
 * shipped inside the published waterfall-tools tarball — embedders install
 * `@chrome-devtools/index` alongside waterfall-tools as a peer dependency,
 * and this command materializes it on demand.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchDevtoolsBundle } from '../scripts/patch-devtools.js';

async function patchDevtoolsJs(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.resolve(dir, entry.name);
        if (entry.isDirectory()) {
            await patchDevtoolsJs(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            const raw = await fs.readFile(fullPath, 'utf-8');
            const patched = patchDevtoolsBundle(raw);
            if (patched !== raw) await fs.writeFile(fullPath, patched);
        }
    }
}

export async function runInstallViewer(argv) {
    const target = argv[0];
    if (!target || target === '--help' || target === '-h') {
        console.error('Usage: waterfall-tools install-viewer <target-dir>');
        process.exit(1);
    }

    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    const selfDistBrowser = path.resolve(selfDir, '..', 'dist', 'browser');

    if (!existsSync(selfDistBrowser)) {
        console.error(
            `Cannot locate viewer assets at ${selfDistBrowser}. ` +
            'This usually means waterfall-tools was installed from source without a completed build. ' +
            'Run `npm run build` in the waterfall-tools checkout first.'
        );
        process.exit(1);
    }

    // Resolve the embedder's @chrome-devtools/index peer dependency. We need
    // the exact directory and version installed in their project, not any
    // version we may have had at publish time.
    let devtoolsPkgPath;
    try {
        devtoolsPkgPath = fileURLToPath(import.meta.resolve('@chrome-devtools/index/package.json'));
    } catch {
        console.error(
            'Cannot find @chrome-devtools/index in the surrounding project.\n' +
            '\n' +
            'The viewer embeds the Chrome DevTools frontend, which is a ~80 MB\n' +
            'bundle kept out of the waterfall-tools tarball. Install it as a\n' +
            'peer dependency in your project:\n' +
            '\n' +
            '    npm install @chrome-devtools/index\n' +
            '\n' +
            'Then rerun: waterfall-tools install-viewer ' + target
        );
        process.exit(1);
    }

    const devtoolsPkg = JSON.parse(await fs.readFile(devtoolsPkgPath, 'utf-8'));
    const devtoolsVersion = devtoolsPkg.version;
    const devtoolsSrc = path.dirname(devtoolsPkgPath);
    const devtoolsDirName = `devtools-${devtoolsVersion}`;

    const outDir = path.resolve(process.cwd(), target);
    await fs.mkdir(outDir, { recursive: true });

    // Sweep previous devtools-* directories left over from older installs.
    // Anything else in the target directory is left untouched — this command
    // is designed to be rerun into an existing web root.
    const existingEntries = await fs.readdir(outDir, { withFileTypes: true });
    for (const entry of existingEntries) {
        if (entry.isDirectory() && entry.name.startsWith('devtools-') && entry.name !== devtoolsDirName) {
            await fs.rm(path.join(outDir, entry.name), { recursive: true, force: true });
            console.log(`Removed stale ${entry.name}/`);
        }
    }

    console.log(`Copying viewer assets -> ${outDir}`);
    await fs.cp(selfDistBrowser, outDir, {
        recursive: true,
        filter: (src) => {
            const rel = path.relative(selfDistBrowser, src);
            if (rel === '') return true;
            const top = rel.split(path.sep, 1)[0];
            // Published tarball doesn't include a devtools-* directory, but
            // guard against source checkouts where `npm run build` produced one.
            return !top.startsWith('devtools-');
        }
    });

    const devtoolsDest = path.join(outDir, devtoolsDirName);
    console.log(`Copying @chrome-devtools/index@${devtoolsVersion} -> ${devtoolsDirName}/`);
    await fs.cp(devtoolsSrc, devtoolsDest, { recursive: true });
    // Strip the devtools package.json so the tree is a pure static bundle.
    await fs.rm(path.join(devtoolsDest, 'package.json'), { force: true });

    console.log('Patching DevTools bundle for browser hosting');
    await patchDevtoolsJs(devtoolsDest);

    const indexPath = path.join(outDir, 'index.html');
    if (existsSync(indexPath)) {
        let indexHtml = await fs.readFile(indexPath, 'utf-8');
        const devtoolsMeta = `<meta name="waterfall-devtools-path" content="./${devtoolsDirName}/">`;
        if (indexHtml.includes('name="waterfall-devtools-path"')) {
            indexHtml = indexHtml.replace(
                /<meta name="waterfall-devtools-path"[^>]*>/,
                devtoolsMeta
            );
        } else {
            indexHtml = indexHtml.replace('</head>', `  ${devtoolsMeta}\n</head>`);
        }
        await fs.writeFile(indexPath, indexHtml);
    }

    console.log(`\nViewer installed. Serve ${outDir} as static files.`);
}

// Direct invocation: `node bin/install-viewer.js <target>`.
// Also invoked as a subcommand from bin/waterfall-tools.js (import form).
if (import.meta.url === `file://${process.argv[1]}`) {
    runInstallViewer(process.argv.slice(2)).catch(err => {
        console.error('install-viewer failed:', err);
        process.exit(1);
    });
}
