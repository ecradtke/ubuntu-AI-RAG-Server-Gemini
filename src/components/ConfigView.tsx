import React, { useState } from 'react';
import { Settings, Shield, HardDrive, Terminal, FileCode, Check, Copy, Globe, RefreshCw } from 'lucide-react';
import { ClusterConfig } from '../types';

interface ConfigViewProps {
  config: ClusterConfig;
  onUpdateConfig: (newConfig: Partial<ClusterConfig>) => void;
}

const ENV_VARIABLES = [
  { key: 'DEFAULT_MODEL', val: 'OpenVINO/Phi-3.5-mini-instruct-int4-ov', desc: 'Default INT4 chat LLM loaded on Intel GPU at start' },
  { key: 'EMBED_MODEL', val: 'BAAI/bge-base-en-v1.5', desc: 'Default 768-dim embeddings model loaded on Intel NPU' },
  { key: 'LLM_DEVICE', val: 'GPU', desc: 'Hardware target for LLM inference (Intel Lunar Lake / Arc GPU)' },
  { key: 'EMBED_DEVICE', val: 'NPU', desc: 'Hardware target for vector embeddings (Intel NPU /dev/accel/accel0)' },
  { key: 'OV_HOST', val: '127.0.0.1', desc: 'Bind address for OpenVINO FastAPI server' },
  { key: 'OV_PORT', val: '11434', desc: 'Ollama- and OpenAI-compatible inference port' },
  { key: 'QDRANT_BIND', val: '0.0.0.0', desc: 'Bind address for native Qdrant service (0.0.0.0 binds all interfaces for LAN access)' },
  { key: 'QDRANT_PORT', val: '6333', desc: 'Qdrant HTTP REST API port' },
  { key: 'QDRANT_COLLECTION', val: 'rss_articles', desc: 'Primary news & RSS article collection' },
  { key: 'RAG_CONTEXT_TOKEN_BUDGET', val: '8000', desc: 'Max token budget for retrieved excerpts to protect GPU KV cache' },
  { key: 'TOP_K_MAX', val: '100', desc: 'Upper limit for vector search retrieval slider' },
  { key: 'SWITCH_ALLOW_CPU', val: 'off', desc: 'If off, switches to models exceeding 6.8GB GPU VRAM are rolled back' },
  { key: 'LLM_THINKING', val: 'off', desc: 'Reasoning model hidden thinking tokens toggle' },
  { key: 'MAX_NEW_TOKENS', val: '2048', desc: 'Ceiling generation token limit per query' },
  { key: 'FRESHRSS_BASE_URL', val: 'http://nas.local:8080/api/greader.php', desc: 'NAS FreshRSS API endpoint for sync timer' },
  { key: 'PG_HOST', val: 'nas.local', desc: 'NAS PostgreSQL host holding article metadata' },
  { key: 'K13_DATA_DIR', val: '/opt/k13/data', desc: 'Data directory for Qdrant storage & snapshots' },
  { key: 'WEB_PORT', val: '3000', desc: 'Web portal port (vite dev/production port)' }
];

export const ConfigView: React.FC<ConfigViewProps> = ({ config, onUpdateConfig }) => {
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<{
    testing: boolean;
    tested?: boolean;
    qdrantStatus?: { ok: boolean; msg: string; count?: number };
    ovStatus?: { ok: boolean; msg: string };
  }>({ testing: false });

  const runConnectionTest = async () => {
    setTestResult({ testing: true, tested: true });
    // Test Qdrant
    let qOk = false;
    let qMsg = '';
    let count = 0;
    try {
      let res = await fetch(`${config.qdrantUrl.replace(/\/+$/, '')}/collections/${config.activeCollection}`, {
        signal: AbortSignal.timeout(3000)
      }).catch(() => null);

      if (!res || !res.ok) {
        res = await fetch(`/api/qdrant/collections/${config.activeCollection}`, {
          signal: AbortSignal.timeout(3000)
        }).catch(() => null);
      }

      if (res && res.ok) {
        const data = await res.json();
        qOk = true;
        count = data?.result?.points_count ?? data?.result?.vectors_count ?? 0;
        qMsg = `Reachable (${count.toLocaleString()} points in '${config.activeCollection}')`;
      } else if (res) {
        qMsg = `HTTP ${res.status}: ${res.statusText}`;
      } else {
        qMsg = 'Port 6333 unreachable or blocked';
      }
    } catch (e: any) {
      qMsg = e?.message || 'Connection failed';
    }

    // Test OpenVINO
    let ovOk = false;
    let ovMsg = '';
    try {
      let res = await fetch(`${config.inferenceUrl.replace(/\/+$/, '')}/healthz`, {
        signal: AbortSignal.timeout(3000)
      }).catch(() => null);

      if (!res || !res.ok) {
        res = await fetch('/api/ov/healthz', {
          signal: AbortSignal.timeout(3000)
        }).catch(() => null);
      }

      if (res && res.ok) {
        const data = await res.json();
        ovOk = true;
        ovMsg = `Online (${data.llm_hardware || 'GPU'} / ${data.embed_hardware || 'NPU'})`;
      } else if (res) {
        ovMsg = `HTTP ${res.status}`;
      } else {
        ovMsg = 'Port 11434 unreachable';
      }
    } catch (e: any) {
      ovMsg = e?.message || 'Connection failed';
    }

    setTestResult({
      testing: false,
      tested: true,
      qdrantStatus: { ok: qOk, msg: qMsg, count },
      ovStatus: { ok: ovOk, msg: ovMsg }
    });
  };

  const rawEnvText = ENV_VARIABLES.map(e => `${e.key}=${e.val}`).join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(rawEnvText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-8 bg-[#030712] max-w-5xl mx-auto">
      {/* Title */}
      <div>
        <h2 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent flex items-center gap-2">
          <Settings className="w-6 h-6 text-sky-400" />
          <span>Configuration & Environment (.env)</span>
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Settings are parsed as key-value pairs (never sourced) by <code>scripts/_lib.sh</code>. Services pick up edits on restart.
        </p>
      </div>

      {/* Connection Mode Toggle */}
      <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-indigo-400" />
            <span className="font-bold text-slate-100 text-sm">Cluster Runtime Mode</span>
          </div>
          <span className="text-xs px-2.5 py-1 rounded-full bg-indigo-950 border border-indigo-700/60 text-indigo-300 font-mono">
            Mode: {config.connectionMode}
          </span>
        </div>
        <p className="text-xs text-slate-400">
          The hub runs locally on this Ubuntu Server. You can toggle between the live endpoints (:11434, :6333) or the simulated Intel OpenVINO hardware runtime for sandbox testing.
        </p>
        <div className="grid grid-cols-2 gap-2 pt-2">
          <button
            onClick={() => onUpdateConfig({ connectionMode: 'simulated' })}
            className={`p-3 rounded-xl border text-left transition ${
              config.connectionMode === 'simulated'
                ? 'bg-indigo-600/30 border-indigo-500 text-indigo-100'
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className="font-bold text-xs">Simulated Intel Cluster</div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              High-fidelity local simulation with curated articles, streaming, and GPU telemetry
            </div>
          </button>

          <button
            onClick={() => onUpdateConfig({ connectionMode: 'live' })}
            className={`p-3 rounded-xl border text-left transition ${
              config.connectionMode === 'live'
                ? 'bg-indigo-600/30 border-indigo-500 text-indigo-100'
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className="font-bold text-xs">Live Local Endpoints</div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Direct connection to :11434 (OpenVINO) and :6333 (Qdrant)
            </div>
          </button>
        </div>

        {/* Live Service URLs Configuration */}
        {config.connectionMode === 'live' && (
          <div className="mt-4 pt-4 border-t border-slate-800/80 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                <span>Client Endpoint URLs (for browser access)</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  const h = window.location.hostname || '127.0.0.1';
                  onUpdateConfig({
                    inferenceUrl: `http://${h}:11434`,
                    qdrantUrl: `http://${h}:6333`
                  });
                }}
                className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 transition"
                title="Reset to current browser hostname"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Reset to {window.location.hostname || '127.0.0.1'}</span>
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">OpenVINO Inference Server URL</label>
                <input
                  type="text"
                  value={config.inferenceUrl}
                  onChange={e => onUpdateConfig({ inferenceUrl: e.target.value })}
                  placeholder="http://127.0.0.1:11434"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Qdrant Vector Database URL</label>
                <input
                  type="text"
                  value={config.qdrantUrl}
                  onChange={e => onUpdateConfig({ qdrantUrl: e.target.value })}
                  placeholder="http://127.0.0.1:6333"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            {/* Test Connection Button & Status */}
            <div className="pt-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-t border-slate-800/60">
              <button
                type="button"
                onClick={runConnectionTest}
                disabled={testResult.testing}
                className="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/50 text-indigo-200 text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testResult.testing ? 'animate-spin' : ''}`} />
                <span>{testResult.testing ? 'Testing Endpoints...' : 'Test Cluster Endpoints'}</span>
              </button>

              {testResult.tested && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`px-2.5 py-1 rounded-full font-mono flex items-center gap-1.5 ${
                    testResult.qdrantStatus?.ok
                      ? 'bg-emerald-950/80 border border-emerald-600/60 text-emerald-300'
                      : 'bg-rose-950/80 border border-rose-600/60 text-rose-300'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${testResult.qdrantStatus?.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                    <span>Qdrant: {testResult.qdrantStatus?.msg}</span>
                  </span>

                  <span className={`px-2.5 py-1 rounded-full font-mono flex items-center gap-1.5 ${
                    testResult.ovStatus?.ok
                      ? 'bg-sky-950/80 border border-sky-600/60 text-sky-300'
                      : 'bg-rose-950/80 border border-rose-600/60 text-rose-300'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${testResult.ovStatus?.ok ? 'bg-sky-400' : 'bg-rose-400'}`} />
                    <span>OpenVINO: {testResult.ovStatus?.msg}</span>
                  </span>
                </div>
              )}
            </div>

            {/* Architecture guidance */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/90 text-[11px] text-slate-400 space-y-1.5">
              <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-indigo-400" />
                <span>Host IP & .env Guidelines</span>
              </div>
              <p>
                <strong>Do you need to set the host IP in <code>.env</code>?</strong> No. In <code>.env</code>, <code>QDRANT_BIND=0.0.0.0</code> automatically listens on all network interfaces, and backend scripts (like <code>sync_freshrss.py</code>) reach Qdrant locally at <code>127.0.0.1:6333</code>.
              </p>
              <p>
                <strong>Web Portal LAN Access:</strong> The portal now includes built-in reverse-proxying via Vite (<code>/api/qdrant</code> and <code>/api/ov</code>). Even if accessed from another device on your network without setting an IP, requests seamlessly reach your K13 server. If you prefer direct connections, simply click &ldquo;Reset to hostname&rdquo; above.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Environment Variables Table */}
      <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-sky-400" />
            <span className="font-bold text-slate-100 text-sm">Parsed .env Parameters</span>
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied .env!' : 'Copy .env Template'}</span>
          </button>
        </div>

        <div className="border border-slate-800 rounded-xl overflow-hidden font-mono text-xs">
          <table className="w-full text-left">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
              <tr>
                <th className="p-2.5">Variable</th>
                <th className="p-2.5">Default Value</th>
                <th className="p-2.5 hidden md:table-cell">Role & Architecture</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-slate-300">
              {ENV_VARIABLES.map(env => (
                <tr key={env.key} className="hover:bg-slate-850/50">
                  <td className="p-2.5 text-sky-300 font-bold">{env.key}</td>
                  <td className="p-2.5 text-indigo-300">{env.val}</td>
                  <td className="p-2.5 text-slate-400 font-sans text-xs hidden md:table-cell">
                    {env.desc}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* System Platform Architecture Notes */}
      <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 text-xs text-slate-400 space-y-2">
        <div className="font-bold text-slate-200 font-sans text-sm flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <span>Platform Guidelines & Systemd Rules</span>
        </div>
        <p>
          1. <strong>OpenVINO does all inference:</strong> pure Intel OpenVINO, no containers, no Ollama, no llama.cpp.
        </p>
        <p>
          2. <strong>Embedding dimension must match the Qdrant collection:</strong> 768 for the default <code>bge-base-en-v1.5</code>, 384 for <code>bge-small-en-v1.5</code>.
        </p>
        <p>
          3. <strong>Hardware topology:</strong> LLM runs on the Intel GPU (up to ~6.8GB VRAM cap on Lunar Lake); embeddings run on Intel NPU.
        </p>
      </div>
    </div>
  );
};
