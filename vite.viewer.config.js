import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/viewer',
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
    outDir: '../../dist/viewer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/viewer/index.html')
      }
    }
  }
});
