import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api/qdrant': {
        target: 'http://127.0.0.1:6333',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/qdrant/, ''),
      },
      '/api/ov': {
        target: 'http://127.0.0.1:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ov/, ''),
      },
    },
  },
  envPrefix: ['VITE_', 'RAG_', 'MAX_', 'TOP_', 'DEFAULT_', 'LLM_', 'EMBED_', 'OV_', 'QDRANT_'],
});
