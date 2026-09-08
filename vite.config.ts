import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built bundle can be served from any static-host subpath.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
