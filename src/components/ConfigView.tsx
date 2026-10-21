import React, { useState, useEffect, useMemo } from 'react';
import {
  Settings,
  Shield,
  Terminal,
  FileCode,
  Check,
  Copy,
  Globe,
  RefreshCw,
  Zap,
  Cpu,
  AlertTriangle,
  Layers,
  BookOpen,
  Search,
  CheckCircle2,
  Sliders
} from 'lucide-react';
import { ClusterConfig } from '../types';

interface ConfigViewProps {
  config: ClusterConfig;
  onUpdateConfig: (newConfig: Partial<ClusterConfig>) => void;
}

interface EnvVarDefinition {
  key: string;
  defaultVal: string;
  category: 'RAG & Retrieval' | 'Models & Hardware' | 'Networking' | 'Storage & NAS' | 'External Services';
  desc: string;
}

const KNOWN_ENV_VARIABLES: EnvVarDefinition[] = [
  {
    key: 'RAG_CONTEXT_TOKEN_BUDGET',
    defaultVal: '20000',
    category: 'RAG & Retrieval',
    desc: 'Max token budget for retrieved Qdrant excerpts to assemble the LLM context prompt.'
  },
  {
    key: 'TOP_K_MAX',
    defaultVal: '150',
    category: 'RAG & Retrieval',
    desc: 'Upper ceiling limit for the Top K excerpts retrieval slider in the search interface.'
  },
  {
    key: 'MAX_NEW_TOKENS',
    defaultVal: '2048',
    category: 'Models & Hardware',
    desc: 'Generation limit for tokens generated per prompt query by openvino_genai.LLMPipeline.'
  },
  {
    key: 'DEFAULT_MODEL',
    defaultVal: 'OpenVINO/Phi-3.5-mini-instruct-int4-ov',
    category: 'Models & Hardware',
    desc: 'Default INT4 chat LLM loaded onto the Intel GPU at startup.'
  },
  {
    key: 'EMBED_MODEL',
    defaultVal: 'BAAI/bge-base-en-v1.5',
    category: 'Models & Hardware',
    desc: 'Default 768-dim embeddings model loaded onto the Intel NPU (/dev/accel/accel0).'
  },
  {
    key: 'LLM_DEVICE',
    defaultVal: 'GPU',
    category: 'Models & Hardware',
    desc: 'Hardware target for LLM inference (Intel Lunar Lake Arc GPU).'
  },
  {
    key: 'EMBED_DEVICE',
    defaultVal: 'NPU',
    category: 'Models & Hardware',
    desc: 'Hardware target for vector embeddings (Intel NPU with CPU fallback).'
  },
  {
    key: 'SWITCH_ALLOW_CPU',
    defaultVal: 'off',
    category: 'Models & Hardware',
    desc: 'If off, switches to models exceeding the ~6.8GB GPU VRAM ceiling are rolled back.'
  },
  {
    key: 'LLM_THINKING',
    defaultVal: 'off',
    category: 'Models & Hardware',
    desc: 'Toggles reasoning models hidden thinking process tokens.'
  },
  {
    key: 'OV_HOST',
    defaultVal: '127.0.0.1',
    category: 'Networking',
    desc: 'Bind address for the native OpenVINO FastAPI server.'
  },
  {
    key: 'OV_PORT',
    defaultVal: '11434',
    category: 'Networking',
    desc: 'Ollama- and OpenAI-compatible inference port.'
  },
  {
    key: 'QDRANT_BIND',
    defaultVal: '0.0.0.0',
    category: 'Networking',
    desc: 'Bind address for native Qdrant service (0.0.0.0 binds all interfaces for LAN access).'
  },
  {
    key: 'QDRANT_PORT',
    defaultVal: '6333',
    category: 'Networking',
    desc: 'Qdrant HTTP REST API port.'
  },
  {
    key: 'QDRANT_COLLECTION',
    defaultVal: 'rss_articles',
    category: 'Storage & NAS',
    desc: 'Primary vector collection for news articles and RSS items.'
  },
  {
    key: 'K13_DATA_DIR',
    defaultVal: '/opt/k13/data',
    category: 'Storage & NAS',
    desc: 'Base data directory for Qdrant storage, models, and snapshots.'
  },
  {
    key: 'FRESHRSS_BASE_URL',
    defaultVal: 'http://nas.local:8080/api/greader.php',
    category: 'External Services',
    desc: 'NAS FreshRSS API endpoint for the 5-minute k13-rss-sync timer.'
  },
  {
    key: 'PG_HOST',
    defaultVal: 'nas.local',
    category: 'Storage & NAS',
    desc: 'NAS PostgreSQL host holding article metadata (fetch42, freshrss).'
  },
  {
    key: 'WEB_PORT',
    defaultVal: '3000',
    category: 'Networking',
    desc: 'Web portal port (vite dev/production port).'
  }
];

export const ConfigView: React.FC<ConfigViewProps> = ({ config, onUpdateConfig }) => {
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [isRefreshingEnv, setIsRefreshingEnv] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [envFetchStatus, setEnvFetchStatus] = useState<{ source?: string; count?: number; ok?: boolean }>({});

  const [testResult, setTestResult] = useState<{
    testing: boolean;
    tested?: boolean;
    qdrantStatus?: { ok: boolean; msg: string; count?: number };
    ovStatus?: { ok: boolean; msg: string };
  }>({ testing: false });

  // Load and refresh live .env from Vite middleware
  const reloadEnvFromDisk = async () => {
    setIsRefreshingEnv(true);
    try {
      const res = await fetch('/api/env');
      if (res.ok) {
        const data = await res.json();
        const live = data?.env || {};
        const source = data?.source || '.env';

        const updates: Partial<ClusterConfig> = {
          liveEnv: live,
          envSource: source
        };

        if (live.RAG_CONTEXT_TOKEN_BUDGET) {
          const b = parseInt(live.RAG_CONTEXT_TOKEN_BUDGET, 10);
          if (!isNaN(b) && b > 0) updates.ragContextTokenBudget = b;
        }

        if (live.TOP_K_MAX) {
          const k = parseInt(live.TOP_K_MAX, 10);
          if (!isNaN(k) && k > 0) updates.topKMax = k;
        }

        if (live.MAX_NEW_TOKENS) {
          const m = parseInt(live.MAX_NEW_TOKENS, 10);
          if (!isNaN(m) && m > 0) updates.maxNewTokens = m;
        }

        if (live.DEFAULT_MODEL) updates.currentLlmModel = live.DEFAULT_MODEL;
        if (live.EMBED_MODEL) updates.currentEmbedModel = live.EMBED_MODEL;
        if (live.SWITCH_ALLOW_CPU !== undefined) {
          updates.switchAllowCpu = live.SWITCH_ALLOW_CPU.toLowerCase() === 'on';
        }
        if (live.LLM_THINKING !== undefined) {
          updates.llmThinking = live.LLM_THINKING.toLowerCase() === 'on';
        }

        onUpdateConfig(updates);
        setEnvFetchStatus({
          source,
          count: Object.keys(live).length,
          ok: true
        });
        setLastSyncTime(new Date().toLocaleTimeString());
      } else {
        setEnvFetchStatus({ ok: false, source: 'offline' });
      }
    } catch {
      setEnvFetchStatus({ ok: false, source: 'unreachable' });
    } finally {
      setIsRefreshingEnv(false);
    }
  };

  useEffect(() => {
    reloadEnvFromDisk();
  }, []);

  // Compute live mapped variables
  const resolvedVariables = useMemo(() => {
    const live = config.liveEnv || {};
    const viteMeta = (import.meta as any).env || {};

    // 1. Process known variables
    const knownKeys = new Set<string>();
    const list = KNOWN_ENV_VARIABLES.map(def => {
      knownKeys.add(def.key);

      // Value resolution precedence:
      // 1. Live .env from backend /api/env
      // 2. Vite import.meta.env
      // 3. Active config runtime state
      // 4. Default fallback
      let liveVal = live[def.key];
      let source: 'env' | 'runtime' | 'default' = 'default';

      if (liveVal !== undefined && liveVal !== '') {
        source = 'env';
      } else if (viteMeta[def.key] !== undefined && viteMeta[def.key] !== '') {
        liveVal = String(viteMeta[def.key]);
        source = 'env';
      } else if (viteMeta[`VITE_${def.key}`] !== undefined && viteMeta[`VITE_${def.key}`] !== '') {
        liveVal = String(viteMeta[`VITE_${def.key}`]);
        source = 'env';
      } else if (def.key === 'RAG_CONTEXT_TOKEN_BUDGET' && config.ragContextTokenBudget) {
        liveVal = String(config.ragContextTokenBudget);
        source = 'runtime';
      } else if (def.key === 'TOP_K_MAX' && config.topKMax) {
        liveVal = String(config.topKMax);
        source = 'runtime';
      } else if (def.key === 'MAX_NEW_TOKENS' && config.maxNewTokens) {
        liveVal = String(config.maxNewTokens);
        source = 'runtime';
      } else if (def.key === 'DEFAULT_MODEL' && config.currentLlmModel) {
        liveVal = config.currentLlmModel;
        source = 'runtime';
      } else if (def.key === 'EMBED_MODEL' && config.currentEmbedModel) {
        liveVal = config.currentEmbedModel;
        source = 'runtime';
      } else if (def.key === 'SWITCH_ALLOW_CPU') {
        liveVal = config.switchAllowCpu ? 'on' : 'off';
        source = 'runtime';
      } else if (def.key === 'LLM_THINKING') {
        liveVal = config.llmThinking ? 'on' : 'off';
        source = 'runtime';
      } else {
        liveVal = def.defaultVal;
        source = 'default';
      }

      return {
        key: def.key,
        val: liveVal,
        defaultVal: def.defaultVal,
        category: def.category,
        desc: def.desc,
        source
      };
    });

    // 2. Add any additional variables detected in .env that were not in KNOWN_ENV_VARIABLES
    Object.entries(live).forEach(([k, v]) => {
      if (!knownKeys.has(k)) {
        list.push({
          key: k,
          val: v,
          defaultVal: '—',
          category: 'Storage & NAS',
          desc: 'Custom parameter parsed from host .env',
          source: 'env'
        });
      }
    });

    return list;
  }, [config.liveEnv, config.ragContextTokenBudget, config.topKMax, config.maxNewTokens, config.currentLlmModel, config.currentEmbedModel, config.switchAllowCpu, config.llmThinking]);

  // Filtered variables based on search and category
  const filteredVariables = useMemo(() => {
    return resolvedVariables.filter(v => {
      const matchesSearch =
        v.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
        v.val.toLowerCase().includes(searchQuery.toLowerCase()) ||
        v.desc.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesCategory =
        selectedCategory === 'All' || v.category === selectedCategory;

      return matchesSearch && matchesCategory;
    });
  }, [resolvedVariables, searchQuery, selectedCategory]);

  const categories = ['All', 'RAG & Retrieval', 'Models & Hardware', 'Networking', 'Storage & NAS', 'External Services'];

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
        ovMsg = `Online (${data.llm_hardware || 'GPU'} / ${data.embed_hardware || 'NPU'}) • max_new_tokens: ${data.max_new_tokens || 2048}`;
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

  const rawEnvText = resolvedVariables.map(e => `${e.key}=${e.val}`).join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(rawEnvText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-8 bg-[#030712] max-w-5xl mx-auto">
      {/* Title & Live Status */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent flex items-center gap-2">
            <Settings className="w-6 h-6 text-sky-400" />
            <span>Configuration & Environment (.env)</span>
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Parameters parsed dynamically as key-value pairs by <code>scripts/_lib.sh</code> and reflected live in the UI.
          </p>
        </div>

        {/* Live sync action */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reloadEnvFromDisk}
            disabled={isRefreshingEnv}
            className="px-3.5 py-1.5 rounded-xl bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/50 text-indigo-200 text-xs font-semibold flex items-center gap-2 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingEnv ? 'animate-spin' : ''}`} />
            <span>{isRefreshingEnv ? 'Reading .env...' : 'Reload .env from Disk'}</span>
          </button>
        </div>
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
          The hub runs natively on this Ubuntu Server. Direct connections reach ports :11434 (OpenVINO) and :6333 (Qdrant).
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
          </div>
        )}
      </div>

      {/* Token Allowance & GPU VRAM Engineering Card */}
      <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 shadow-xl space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <span className="font-bold text-slate-100 text-sm">Excerpt Token Allowance & VRAM Engineering</span>
          </div>
          <span className="px-3 py-1 rounded-full text-xs font-mono font-semibold bg-sky-950 border border-sky-700/60 text-sky-300">
            Active Budget: {config.ragContextTokenBudget.toLocaleString()} tokens (~{((config.ragContextTokenBudget * 3.5) / 1000).toFixed(0)}KB text)
          </span>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          The excerpt token allowance controls the maximum context size allocated to retrieved Qdrant articles when assembling the prompt for the OpenVINO LLM. Setting this allowance to <strong>20,000 tokens</strong> provides deep multi-document synthesis across dozens of full-length news reports.
        </p>

        {/* Quick UI Preset Switcher */}
        <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-300 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-sky-400" />
              <span>Interactive Excerpt Budget Selector</span>
            </span>
            <span className="font-mono text-indigo-300 font-semibold">{config.ragContextTokenBudget.toLocaleString()} tokens</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[4000, 8000, 16000, 20000, 32000].map(budget => (
              <button
                key={budget}
                type="button"
                onClick={() => onUpdateConfig({ ragContextTokenBudget: budget })}
                className={`py-2 px-3 rounded-lg text-xs font-mono transition text-center ${
                  config.ragContextTokenBudget === budget
                    ? 'bg-sky-600 text-white font-bold ring-2 ring-sky-400/50 shadow-lg'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-850 hover:text-white border border-slate-800'
                }`}
              >
                <div className="text-sm font-bold">{budget / 1000}K</div>
                <div className="text-[10px] opacity-75">{budget.toLocaleString()} tok</div>
              </button>
            ))}
          </div>
        </div>

        {/* How to configure 20K in .env */}
        <div className="p-4 rounded-xl bg-slate-950 border border-sky-900/40 text-xs space-y-2">
          <div className="font-semibold text-sky-300 flex items-center gap-1.5">
            <BookOpen className="w-4 h-4 text-sky-400" />
            <span>How to set Excerpt Allowance to 20K permanently in .env</span>
          </div>
          <p className="text-slate-300 text-xs">
            Edit your root <code>.env</code> file (following the single-line comment rule, no inline comments):
          </p>
          <pre className="p-3 rounded-lg bg-slate-900 border border-slate-800 font-mono text-[11px] text-sky-200 overflow-x-auto">
{`# Max token budget for retrieved Qdrant excerpts
RAG_CONTEXT_TOKEN_BUDGET=20000

# Recommended: allow up to 150 excerpts retrieval in the UI
TOP_K_MAX=150

# Maximum generated output tokens
MAX_NEW_TOKENS=2048`}
          </pre>
          <p className="text-slate-400 text-[11px]">
            Then restart the web portal service (or click &ldquo;Reload .env from Disk&rdquo; above) to pick up changes:
            <code className="ml-1 px-1.5 py-0.5 rounded bg-slate-900 text-indigo-300 font-mono">sudo systemctl restart k13-web</code>
          </p>
        </div>

        {/* Hardware & GPU VRAM KV Cache Table */}
        <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs space-y-3">
          <div className="font-semibold text-slate-200 flex items-center gap-1.5">
            <Cpu className="w-4 h-4 text-emerald-400" />
            <span>Hardware Topology & KV Cache Memory Impact (6.8 GB Intel GPU VRAM Ceiling)</span>
          </div>
          <p className="text-slate-400 text-xs">
            On the native Ubuntu Server host, the Intel Lunar Lake / Arc GPU runtime caps at <strong>~6.8 GB VRAM</strong>. Context tokens consume GPU memory via Key-Value (KV) Cache:
          </p>
          <div className="overflow-x-auto border border-slate-800 rounded-lg">
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="bg-slate-900 text-slate-400 border-b border-slate-800 font-sans">
                <tr>
                  <th className="p-2">Model (INT4)</th>
                  <th className="p-2">Model Weights</th>
                  <th className="p-2">KV Cache (8K Context)</th>
                  <th className="p-2">KV Cache (20K Context)</th>
                  <th className="p-2">20K GPU Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-300">
                <tr>
                  <td className="p-2 text-sky-300 font-bold">Phi-3.5-mini (3.8B)</td>
                  <td className="p-2">~2.3 GB</td>
                  <td className="p-2">~0.55 GB</td>
                  <td className="p-2 text-emerald-400 font-semibold">~1.38 GB</td>
                  <td className="p-2 text-emerald-400 font-bold">✓ ~3.7 GB (Plenty of headroom)</td>
                </tr>
                <tr>
                  <td className="p-2 text-sky-300 font-bold">Qwen3-8B-int4</td>
                  <td className="p-2">~4.8 GB</td>
                  <td className="p-2">~1.05 GB</td>
                  <td className="p-2 text-amber-400 font-semibold">~2.65 GB</td>
                  <td className="p-2 text-amber-300 font-bold">⚠️ ~7.45 GB (Requires SWITCH_ALLOW_CPU=on)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="flex items-start gap-2 text-amber-300/90 text-[11px] bg-amber-950/30 p-2.5 rounded-lg border border-amber-800/40">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              <strong>Architecture Note:</strong> If running 20K context with the 8B model, set <code className="text-amber-200">SWITCH_ALLOW_CPU=on</code> in <code className="text-amber-200">.env</code> so OpenVINO safely spills to system RAM, OR select <strong>Phi-3.5-mini-instruct</strong> for fast 20K context directly on the Intel GPU.
            </span>
          </div>
        </div>

        {/* GMKtec K13 Lunar Lake Core Ultra 7 256V Hardware Evaluation */}
        <div className="p-4 rounded-xl bg-slate-950 border border-indigo-900/40 text-xs space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="font-semibold text-indigo-300 flex items-center gap-1.5 text-sm">
              <Cpu className="w-4 h-4 text-indigo-400" />
              <span>GMKtec K13 (Core Ultra 7 256V) Architecture: Can We Swap LLM to NPU?</span>
            </div>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-rose-950 border border-rose-700/60 text-rose-300">
              Verdict: Not Recommended
            </span>
          </div>

          <p className="text-slate-300 text-xs leading-relaxed">
            The GMKtec K13 is powered by Intel&apos;s <strong>Lunar Lake</strong> platform (Core Ultra 7 256V) with <strong>16 GB LPDDR5X-8533 Memory-on-Package (MoP)</strong> integrated directly on die:
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
              <div className="font-semibold text-sky-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-sky-400" />
                <span>1. Unified Memory Reality</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                The NPU does not have private dedicated memory. The <strong>CPU, Arc 140V GPU, and NPU 4 all share the same 16 GB physical pool</strong>. The ~6.8 GB limit on the GPU is an OS driver allocation policy, not separate VRAM. Both draw from the same system RAM.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <span>2. Dynamic Shapes & 20K Context</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                The Intel NPU compiler requires static shapes (e.g. <code>bge-base</code> at <code>(1, 512)</code>). Compiling a generative LLM for 20K dynamic tokens on the NPU produces multi-gigabyte static graph blobs and long prefill delays.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
              <div className="font-semibold text-purple-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-purple-400" />
                <span>3. Memory Bandwidth & TTFT</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                The Arc 140V GPU features 8 Xe2 cores and 8MB Sideband Cache optimized for high-bandwidth matrix multiplication. Time-To-First-Token (TTFT) on 20,000 tokens takes ~2–4s on GPU, but is significantly slower on NPU.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
              <div className="font-semibold text-emerald-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span>4. Resource Contention with BGE</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                In this cluster, the NPU is dedicated to <code>BAAI/bge-base-en-v1.5</code> (768d) for continuous search & the 5-minute <code>k13-rss-sync</code> timer. Moving the LLM to the NPU causes device contention and eviction on <code>/dev/accel/accel0</code>.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Dynamic Parsed Environment Variables Table */}
      <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-sky-400" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-100 text-sm">Parsed .env Parameters</span>
                {lastSyncTime && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 border border-emerald-700/60 text-emerald-300 font-mono flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Live Synced ({lastSyncTime})</span>
                  </span>
                )}
              </div>
              <span className="text-[11px] text-slate-400">
                Source: <span className="text-slate-200 font-mono">{config.envSource || '.env (filesystem)'}</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied .env!' : 'Copy Active .env'}</span>
            </button>
          </div>
        </div>

        {/* Filter controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search variables (e.g. TOKEN, TOP_K, MAX_NEW_TOKENS)..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 font-mono"
            />
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 text-xs">
            {categories.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition ${
                  selectedCategory === cat
                    ? 'bg-sky-600/30 border border-sky-500 text-sky-200'
                    : 'bg-slate-950 border border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Dynamic Table */}
        <div className="border border-slate-800 rounded-xl overflow-hidden font-mono text-xs">
          <table className="w-full text-left">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
              <tr>
                <th className="p-2.5">Variable</th>
                <th className="p-2.5">Active Value (Live)</th>
                <th className="p-2.5 hidden sm:table-cell">Origin</th>
                <th className="p-2.5 hidden lg:table-cell">Default Fallback</th>
                <th className="p-2.5 hidden md:table-cell">Role & Architecture</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-slate-300">
              {filteredVariables.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-slate-500 font-sans text-xs">
                    No variables match the query &ldquo;{searchQuery}&rdquo;.
                  </td>
                </tr>
              ) : (
                filteredVariables.map(env => {
                  const isHighlighted =
                    env.key === 'RAG_CONTEXT_TOKEN_BUDGET' ||
                    env.key === 'TOP_K_MAX' ||
                    env.key === 'MAX_NEW_TOKENS';

                  return (
                    <tr
                      key={env.key}
                      className={`hover:bg-slate-850/50 transition-colors ${
                        isHighlighted ? 'bg-sky-950/20' : ''
                      }`}
                    >
                      <td className="p-2.5 font-bold">
                        <span className={isHighlighted ? 'text-amber-300 font-extrabold' : 'text-sky-300'}>
                          {env.key}
                        </span>
                      </td>

                      <td className="p-2.5 font-bold font-mono">
                        <span className={`px-2 py-0.5 rounded ${
                          isHighlighted
                            ? 'bg-indigo-950/90 text-indigo-200 border border-indigo-700/80 shadow-sm'
                            : 'text-indigo-300'
                        }`}>
                          {env.val}
                        </span>
                      </td>

                      <td className="p-2.5 hidden sm:table-cell">
                        {env.source === 'env' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-sans font-semibold bg-emerald-950/90 border border-emerald-600/60 text-emerald-300">
                            ✓ .env file
                          </span>
                        ) : env.source === 'runtime' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-sans font-semibold bg-sky-950/90 border border-sky-600/60 text-sky-300">
                            Active Runtime
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-sans text-slate-500 bg-slate-900 border border-slate-800">
                            Default
                          </span>
                        )}
                      </td>

                      <td className="p-2.5 text-slate-500 hidden lg:table-cell">
                        {env.defaultVal}
                      </td>

                      <td className="p-2.5 text-slate-400 font-sans text-xs hidden md:table-cell">
                        {env.desc}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="text-[11px] text-slate-500 flex items-center justify-between">
          <span>Showing {filteredVariables.length} of {resolvedVariables.length} configuration variables.</span>
          <span className="italic">Values updated dynamically from host environment.</span>
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
