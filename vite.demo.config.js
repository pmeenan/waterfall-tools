import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

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
        main: './index.html',
        canvas: './canvas/index.html'
      }
    }
  }
});
