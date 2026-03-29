import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/demo',
  plugins: [
    nodePolyfills({
      include: ['buffer', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true
      }
    })
  ],
  build: {
    outDir: '../../bin/demo',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/demo/index.html'),
        canvas: resolve(__dirname, 'src/demo/canvas/index.html')
      }
    }
  }
});
