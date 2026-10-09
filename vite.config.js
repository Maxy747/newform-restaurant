import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  base: './',
  // `vite --mode mock` swaps in a local fake backend for visual checks; production builds never use it.
  resolve: mode === 'mock' ? {
    alias: [{ find: /^\.\/supabaseClient\.js$/, replacement: resolve(import.meta.dirname, 'tests/mock-supabase.js') }],
  } : {},
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        invoice: resolve(import.meta.dirname, 'invoice.html'),
      },
    },
  }
}));
