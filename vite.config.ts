import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

function envReaderPlugin(): Plugin {
  const parseEnvFile = () => {
    const envPath = path.resolve(process.cwd(), '.env');
    const parsed: Record<string, string> = {};
    const maskedSecrets = new Set(['PG_PASS', 'FRESHRSS_API_PASS', 'HF_TOKEN', 'POSTGRES_PASSWORD', 'PASSWORD']);

    if (!fs.existsSync(envPath)) {
      return { exists: false, env: parsed, source: 'none' };
    }

    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n');

      for (const rawLine of lines) {
        const line = rawLine.trim();
        // Skip comments and empty lines
        if (!line || line.startsWith('#')) continue;

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;

        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();

        // Strip quotes matching _lib.sh behavior
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        val = val.replace(/\r$/, '');

        // Mask secrets
        if (maskedSecrets.has(key) && val) {
          parsed[key] = '•••••••• (configured)';
        } else {
          parsed[key] = val;
        }
      }

      return { exists: true, env: parsed, source: '.env' };
    } catch (e: any) {
      return { exists: false, env: parsed, error: e?.message, source: 'error' };
    }
  };

  const handleEnvRequest = (_req: any, res: any) => {
    const result = parseEnvFile();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.end(JSON.stringify(result));
  };

  return {
    name: 'k13-env-reader',
    configureServer(server) {
      server.middlewares.use('/api/env', handleEnvRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/env', handleEnvRequest);
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    envReaderPlugin(),
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
  envPrefix: [
    'VITE_',
    'RAG_',
    'MAX_',
    'TOP_',
    'DEFAULT_',
    'LLM_',
    'EMBED_',
    'OV_',
    'QDRANT_',
    'SWITCH_',
    'FRESHRSS_',
    'PG_',
    'K13_',
    'WEB_',
    'DROPIT_'
  ],
});
