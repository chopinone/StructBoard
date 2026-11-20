import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { writeBuildRecord } from '../tools/check_frontend_build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export default defineConfig({
  root,
  plugins: [vue(), { name: 'record-ui-inputs', closeBundle: () => writeBuildRecord(root) }],
  build: {
    outDir: 'ui', emptyOutDir: true, sourcemap: false, target: 'es2020',
    lib: { entry: 'frontend/main.mjs', name: 'StructBoardUI', formats: ['iife'], fileName: () => 'shell.js' },
  },
  define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: false, __VUE_PROD_DEVTOOLS__: false },
});
