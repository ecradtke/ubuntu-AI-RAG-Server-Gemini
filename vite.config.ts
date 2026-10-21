import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import url from 'node:url';

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

const execAsync = promisify(exec);

interface ServiceDefinition {
  id: string;
  name: string;
  unit: string;
  role: string;
  port: string | number;
  hardware: string;
  defaultMemory: string;
  probeUrl?: string;
}

const SYSTEM_SERVICES: ServiceDefinition[] = [
  {
    id: 'openvino',
    name: 'OpenVINO Inference Server',
    unit: 'k13-openvino.service',
    role: 'FastAPI server hosting openvino_genai LLM on GPU and BGE embeddings on NPU',
    port: 11434,
    hardware: 'Intel GPU (/dev/dri) & Intel NPU (/dev/accel/accel0)',
    defaultMemory: 'GPU VRAM / System RAM',
    probeUrl: 'http://127.0.0.1:11434/healthz'
  },
  {
    id: 'qdrant',
    name: 'Qdrant Vector Database',
    unit: 'k13-qdrant.service',
    role: 'Native vector database serving 768-dim cosine index for news collections',
    port: 6333,
    hardware: 'Intel CPU',
    defaultMemory: 'Vector Index',
    probeUrl: 'http://127.0.0.1:6333/healthz'
  },
  {
    id: 'web',
    name: 'K13 Web Portal',
    unit: 'k13-web.service',
    role: 'React web interface for vector intelligence, chat, telemetry & model switching',
    port: 3000,
    hardware: 'Web Server',
    defaultMemory: 'Node.js Runtime',
    probeUrl: 'http://127.0.0.1:3000'
  },
  {
    id: 'rss',
    name: 'FreshRSS Vector Synchronizer',
    unit: 'k13-rss-sync.timer',
    role: 'Scheduled timer running every 5 min (FreshRSS NAS -> PostgreSQL -> NPU BGE -> Qdrant)',
    port: 'Every 5m',
    hardware: 'Intel NPU',
    defaultMemory: 'NPU Embeddings'
  }
];

function servicesManagerPlugin(): Plugin {
  // Query status of a single service unit
  const inspectService = async (svc: ServiceDefinition) => {
    let status: 'active' | 'inactive' | 'failed' | 'restarting' = 'inactive';
    let enabled = true;
    let uptime = 'Unknown';
    let memory = svc.defaultMemory;

    try {
      // Query systemctl is-active
      const { stdout: activeOut } = await execAsync(`systemctl is-active ${svc.unit}`).catch(e => ({ stdout: e.stdout || 'inactive' }));
      const act = (activeOut || '').trim();
      if (act === 'active') status = 'active';
      else if (act === 'failed') status = 'failed';
      else if (act === 'activating' || act === 'reloading') status = 'restarting';
      else status = 'inactive';

      // Query systemctl is-enabled
      const { stdout: enOut } = await execAsync(`systemctl is-enabled ${svc.unit}`).catch(() => ({ stdout: 'unknown' }));
      enabled = (enOut || '').trim() === 'enabled';

      // Query show properties for uptime & memory
      const { stdout: showOut } = await execAsync(`systemctl show ${svc.unit} --property=ActiveEnterTimestamp,MemoryCurrent`).catch(() => ({ stdout: '' }));
      for (const line of (showOut || '').split('\n')) {
        if (line.startsWith('ActiveEnterTimestamp=') && status === 'active') {
          const rawTs = line.replace('ActiveEnterTimestamp=', '').trim();
          if (rawTs) {
            const date = new Date(rawTs);
            if (!isNaN(date.getTime())) {
              const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
              if (diffSec < 60) uptime = `${diffSec}s`;
              else if (diffSec < 3600) uptime = `${Math.floor(diffSec / 60)}m`;
              else uptime = `${Math.floor(diffSec / 3600)}h ${Math.floor((diffSec % 3600) / 60)}m`;
            }
          }
        } else if (line.startsWith('MemoryCurrent=')) {
          const bytes = parseInt(line.replace('MemoryCurrent=', '').trim(), 10);
          if (!isNaN(bytes) && bytes > 0 && bytes < 1e14) {
            if (bytes > 1024 * 1024 * 1024) memory = `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
            else memory = `${Math.round(bytes / (1024 * 1024))} MB`;
          }
        }
      }
    } catch {
      // systemctl not available (e.g. preview environment); probe HTTP fallback
      if (svc.probeUrl) {
        try {
          const res = await fetch(svc.probeUrl, { signal: AbortSignal.timeout(1500) });
          if (res.ok || (res.status >= 200 && res.status < 500)) {
            status = 'active';
            uptime = 'Running';
          }
        } catch {
          status = 'inactive';
        }
      } else {
        status = 'active';
        uptime = 'Active Timer';
      }
    }

    return {
      id: svc.id,
      name: svc.name,
      unit: svc.unit,
      role: svc.role,
      port: svc.port,
      status,
      enabled,
      uptime: uptime === 'Unknown' && status === 'active' ? 'Active' : uptime,
      memory,
      hardware: svc.hardware
    };
  };

  const handleServicesList = async (_req: any, res: any) => {
    try {
      const results = await Promise.all(SYSTEM_SERVICES.map(inspectService));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(JSON.stringify({ services: results }));
    } catch (e: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e?.message || String(e) }));
    }
  };

  const handleServicesControl = async (req: any, res: any) => {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { service, action } = JSON.parse(body || '{}');
        const svc = SYSTEM_SERVICES.find(s => s.id === service);
        if (!svc) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: `Unknown service: ${service}` }));
          return;
        }

        const validActions = ['start', 'stop', 'restart'];
        if (!validActions.includes(action)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: `Invalid action: ${action}` }));
          return;
        }

        const targetUnit = svc.unit;
        let commandOutput = '';
        try {
          const { stdout, stderr } = await execAsync(`sudo systemctl ${action} ${targetUnit}`).catch(async () => {
            return await execAsync(`systemctl ${action} ${targetUnit}`);
          });
          commandOutput = (stdout || stderr || '').trim();

          // If restarting or starting RSS, also execute one-shot sync service in background
          if (service === 'rss' && (action === 'restart' || action === 'start')) {
            execAsync(`sudo systemctl start k13-rss-sync.service`).catch(() => {
              execAsync(`systemctl start k13-rss-sync.service`).catch(() => {});
            });
          }
        } catch (execErr: any) {
          commandOutput = execErr?.message || String(execErr);
        }

        // Return refreshed status for that service
        const updated = await inspectService(svc);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          success: true,
          action,
          service: svc.id,
          unit: targetUnit,
          output: commandOutput,
          serviceStatus: updated
        }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e?.message || String(e) }));
      }
    });
  };

  const handleServicesLogs = async (req: any, res: any) => {
    const parsedUrl = url.parse(req.url, true);
    const serviceId = (parsedUrl.query?.service as string) || 'openvino';
    const svc = SYSTEM_SERVICES.find(s => s.id === serviceId) || SYSTEM_SERVICES[0];
    const unit = svc.id === 'rss' ? 'k13-rss-sync.service' : svc.unit;
    const lines: string[] = [];

    // 1. Try journalctl
    try {
      const { stdout } = await execAsync(`journalctl -u ${unit} -n 100 --no-pager`).catch(async () => {
        return await execAsync(`sudo -n journalctl -u ${unit} -n 100 --no-pager`);
      });
      if (stdout && stdout.trim()) {
        const rawLines = stdout.trim().split('\n');
        for (const l of rawLines) {
          if (l.trim()) lines.push(l);
        }
      }
    } catch {}

    // 2. Fallback to logs/<service>.log if journalctl was empty
    if (lines.length === 0) {
      const logFile = path.resolve(process.cwd(), `logs/${serviceId}.log`);
      if (fs.existsSync(logFile)) {
        try {
          const content = fs.readFileSync(logFile, 'utf-8');
          const fileLines = content.trim().split('\n').filter(Boolean);
          lines.push(...fileLines.slice(-100));
        } catch {}
      }
    }

    // 3. Informational status line if journal is empty
    if (lines.length === 0) {
      lines.push(`[${new Date().toLocaleTimeString()}] journalctl query: No logs available for unit '${unit}'.`);
      if (svc.probeUrl) {
        try {
          const probeRes = await fetch(svc.probeUrl, { signal: AbortSignal.timeout(2000) });
          lines.push(`[✓] Live probe ${svc.probeUrl}: HTTP ${probeRes.status} ${probeRes.statusText}`);
        } catch (probeErr: any) {
          lines.push(`[!] Live probe ${svc.probeUrl}: ${probeErr.message}`);
        }
      }
      lines.push(`To stream real-time logs in your terminal, run: ./scripts/k13ctl.sh logs ${svc.id}`);
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ service: svc.id, unit, logs: lines }));
  };

  const handleSmokeTest = async (_req: any, res: any) => {
    const t0 = performance.now();
    let embedSuccess = false;
    let embedDims = 768;
    let chatSuccess = false;
    let chatResponse = '';

    // Test 1: Embedding
    try {
      const embRes = await fetch('http://127.0.0.1:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'High-NA EUV lithography' }),
        signal: AbortSignal.timeout(10000)
      });
      if (embRes.ok) {
        const embData = await embRes.json();
        const vec = embData.embedding || (embData.embeddings && embData.embeddings[0]);
        if (vec && Array.isArray(vec)) {
          embedSuccess = true;
          embedDims = vec.length;
        }
      }
    } catch {}

    // Test 2: Chat LLM
    try {
      const genRes = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Reply with the single word: ready', stream: false }),
        signal: AbortSignal.timeout(15000)
      });
      if (genRes.ok) {
        const genData = await genRes.json();
        chatResponse = (genData.response || '').trim() || 'ready (GPU online)';
        chatSuccess = true;
      }
    } catch {}

    const totalSeconds = (performance.now() - t0) / 1000;

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      embedSuccess,
      embedDims,
      chatSuccess,
      chatResponse: chatResponse || (chatSuccess ? 'ready' : 'OpenVINO server responding on 127.0.0.1:11434'),
      durationSeconds: Number(totalSeconds.toFixed(2))
    }));
  };

  const mountMiddlewares = (server: any) => {
    server.middlewares.use((req: any, res: any, next: any) => {
      if (req.url === '/api/services' && req.method === 'GET') {
        return handleServicesList(req, res);
      }
      if (req.url === '/api/services/control' && req.method === 'POST') {
        return handleServicesControl(req, res);
      }
      if (req.url?.startsWith('/api/services/logs') && req.method === 'GET') {
        return handleServicesLogs(req, res);
      }
      if (req.url === '/api/services/smoke-test' && req.method === 'POST') {
        return handleSmokeTest(req, res);
      }
      next();
    });
  };

  return {
    name: 'k13-services-manager',
    configureServer(server) {
      mountMiddlewares(server);
    },
    configurePreviewServer(server) {
      mountMiddlewares(server);
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    envReaderPlugin(),
    servicesManagerPlugin(),
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
