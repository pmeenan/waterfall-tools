import { defineConfig } from 'vite';
export default defineConfig([
  { build: { outDir: 'temp/1', emptyOutDir: true } },
  { build: { outDir: 'temp/2', emptyOutDir: true } }
]);
