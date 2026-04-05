import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/viewer',
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
