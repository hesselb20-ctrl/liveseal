import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// A static multi-page site: no server code, deployable to any static host.
// `base: './'` keeps every link relative so the site works under a sub-path
// such as https://<user>.github.io/liveseal/.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        lab: resolve(import.meta.dirname, 'lab/index.html'),
        sender: resolve(import.meta.dirname, 'sender/index.html'),
        verifier: resolve(import.meta.dirname, 'verifier/index.html'),
        checker: resolve(import.meta.dirname, 'verifier/checker.html'),
        abtest: resolve(import.meta.dirname, 'abtest/index.html'),
        bank: resolve(import.meta.dirname, 'demo-bank/index.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  worker: { format: 'es' },
});
