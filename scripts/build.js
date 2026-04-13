import { build as viteBuild } from 'vite';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import alias from '@rollup/plugin-alias';
import fs from 'fs/promises';
import { brotliCompress } from 'zlib';
import { promisify } from 'util';
const compressAsync = promisify(brotliCompress);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const nodeAlias = {
    'platform-canvas-impl': resolve(__dirname, '../src/platforms/node/canvas-node.js'),
    'platform-storage-impl': resolve(__dirname, '../src/platforms/node/storage-node.js')
};

const browserAlias = {
    'platform-canvas-impl': resolve(__dirname, '../src/platforms/browser/canvas-browser.js'),
    'platform-storage-impl': resolve(__dirname, '../src/platforms/browser/storage-browser.js')
};

const externalDepsCore = [
  'fs', 'path', 'os', 'child_process', 'crypto', 'stream', 'zlib', 'util', 'url', 'https', 'http',
  'node:fs', 'node:path', 'node:stream', 'node:os', 'node:child_process', 'node:crypto', 'node:fs/promises',
  '@napi-rs/canvas'
];

const externalDepsTcp = [
  'fs', 'path', 'os', 'child_process', 'crypto', 'stream', 'zlib', 'util', 'url', 'https', 'http',
  'node:fs', 'node:path', 'node:stream', 'node:os', 'node:child_process', 'node:crypto', 'node:fs/promises'
];

async function runRollup(entryName, aliasMap, outDir, externalDeps, stubName, isBrowser) {
    const bundle = await rollup({
        input: resolve(__dirname, `../src/${entryName}`),
        external: externalDeps,
        plugins: [
            alias({ entries: aliasMap }),
            nodeResolve({ preferBuiltins: true, browser: isBrowser }),
            commonjs(),
            terser({ compress: false, format: { comments: false } })
        ]
    });

    const output = await bundle.write({
        dir: resolve(__dirname, `../${outDir}`),
        format: 'es',
        entryFileNames: 'waterfall-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        hoistTransitiveImports: false
    });

    const mainEntry = output.output.find(o => o.isEntry && o.type === 'chunk');
    if (mainEntry && stubName) {
        const stubContent = `export * from './${mainEntry.fileName}';\n`;
        await fs.writeFile(resolve(__dirname, `../${outDir}/${stubName}`), stubContent);
    }
    
    return mainEntry ? mainEntry.fileName : null;
}

async function runBuilds() {
    await fs.rm(resolve(__dirname, '../dist'), { recursive: true, force: true });
    
    console.log('[1/3] Building Core API (Node Target)...');
    await runRollup('core/waterfall-tools.js', nodeAlias, 'dist/node', externalDepsCore, 'waterfall-tools.es.js', false);

    console.log('\n[2/3] Building Viewer (Browser Target)...');
    await viteBuild({
        configFile: false,
        root: 'src/viewer',
        base: './',
        resolve: { alias: browserAlias },
        build: {
            outDir: '../../dist/browser',
            emptyOutDir: true,
            rollupOptions: {
                external: ['fs', 'path', 'os', 'crypto', 'stream', 'zlib', 'waterfall-tools'],
                input: { main: resolve(__dirname, '../src/viewer/index.html') }
            }
        }
    });

    console.log('\n[3/3] Building Core API (Browser Target)...');
    const browserFileName = await runRollup('core/waterfall-tools.js', browserAlias, 'dist/browser/waterfall-tools', externalDepsCore, 'waterfall-tools.es.js', true);

    if (browserFileName) {
        const indexPath = resolve(__dirname, '../dist/browser/index.html');
        let indexHtml = await fs.readFile(indexPath, 'utf-8');
        
        // Rewrite importmap to direct hash
        indexHtml = indexHtml.replace('./waterfall-tools/waterfall-tools.es.js', `./waterfall-tools/${browserFileName}`);
        
        // Inject modulepreload after the main JS payload
        indexHtml = indexHtml.replace(
            /(<script type="module".*?src="[^"]+"><\/script>)/,
            `$1\n  <link rel="modulepreload" href="./waterfall-tools/${browserFileName}">`
        );
        
        await fs.writeFile(indexPath, indexHtml);
    }

    console.log('\nAll builds completed successfully! Compressing browser assets...');

    async function compressDirectory(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                await compressDirectory(fullPath);
            } else if (entry.isFile() && /\.(js|css|html|svg)$/.test(entry.name)) {
                const data = await fs.readFile(fullPath);
                // Dynamically use Brotli Level 11
                const compressed = await compressAsync(data, {
                    params: {
                        [1]: 11 // zlib.constants.BROTLI_PARAM_QUALITY
                    }
                });
                await fs.writeFile(`${fullPath}.br`, compressed);
            }
        }
    }

    async function optimizeImages(dir) {
        let sharp;
        try {
            sharp = (await import('sharp')).default;
        } catch (e) {
            console.log('Skipping image optimization install Sharp with npm install -D sharp if needed');
            return;
        }

        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = resolve(dir, entry.name);
            if (entry.isFile() && fullPath.endsWith('logo.jpg')) {
                const buffer = await fs.readFile(fullPath);
                
                const resized = await sharp(buffer)
                    .resize({ width: 100 })
                    .jpeg({ quality: 85 })
                    .toBuffer();
                await fs.writeFile(fullPath, resized);
                console.log(`Optimized ${entry.name}`);
            } else if (entry.isDirectory()) {
                await optimizeImages(fullPath);
            }
        }
    }
    
    await compressDirectory(resolve(__dirname, '../dist/browser'));
    await optimizeImages(resolve(__dirname, '../dist/browser'));
    console.log('Static asset compression complete!');
}

runBuilds().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
});
