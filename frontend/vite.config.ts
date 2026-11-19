import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The production build goes straight into the backend's static folder, so one
// Node process serves the app and the API from the same origin (no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.LUMINA_API_TARGET || 'http://127.0.0.1:8787';
  return {
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL('../backend/public', import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            query: ['@tanstack/react-query'],
            charts: ['lightweight-charts'],
          },
        },
      },
    },
    server: {
      port: 5173,
      // changeOrigin stays false: the backend's CSRF guard compares Origin with
      // Host, and the browser's Origin is the dev server's.
      proxy: {
        '/api': { target, changeOrigin: false },
        '/f/': { target, changeOrigin: false },
        '/dl': { target, changeOrigin: false },
        '/console': { target, changeOrigin: false },
      },
    },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
