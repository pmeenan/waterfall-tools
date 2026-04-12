import { build } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testVite() {
    await build({
        configFile: false,
        build: {
            outDir: 'dist/test',
            emptyOutDir: true,
            lib: {
                entry: resolve(__dirname, './src/core/waterfall-tools.js'),
                name: 'WaterfallTools',
                formats: ['es'],
                fileName: (format) => `waterfall-tools.es.js`
            },
            rollupOptions: {
                external: ['fs', 'path', 'os', 'child_process', 'crypto', 'stream', 'zlib', 'util', 'url', 'https', 'http', 'node:fs', 'node:path', 'node:stream', 'node:os', 'node:child_process', 'node:crypto', 'node:fs/promises', '@napi-rs/canvas'],
                output: { 
                    globals: {},
                    manualChunks: (id) => {
                        if (id.includes('brotli')) return 'brotli';
                        if (id.includes('/tcpdump/') || id.endsWith('tcpdump.js')) return 'tcpdump';
                    }
                }
            }
        }
    });
}
testVite();
