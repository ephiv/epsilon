import { defineConfig } from 'vite';

export default defineConfig({
  // Deploy to https://ephiv.github.io/epsilon/
  base: '/epsilon/',
  build: {
    target: 'es2022',
    // Optimise chunk splitting for faster initial load
    rollupOptions: {
      output: {
        manualChunks: {
          'render-core': ['./src/core/index.ts'],
          'render-engine': ['./src/render/renderer.ts', './src/render/noteskin.ts'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
