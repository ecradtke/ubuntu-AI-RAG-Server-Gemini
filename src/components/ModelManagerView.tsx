import React, { useState } from 'react';
import {
  Cpu,
  Zap,
  HardDrive,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  Layers,
  ArrowRight,
  Info
} from 'lucide-react';
import { ClusterConfig } from '../types';
import { CURATED_LLM_MODELS, CURATED_EMBED_MODELS } from '../data/mockArticles';

interface ModelManagerViewProps {
  config: ClusterConfig;
  onSwitchLlmModel: (modelId: string) => Promise<void>;
  onSwitchEmbedModel: (modelId: string) => Promise<void>;
  onReloadGpu: () => void;
  onUpdateConfig: (newConfig: Partial<ClusterConfig>) => void;
  switchState: { state: 'idle' | 'loading' | 'error'; model?: string; error?: string };
  embedSwitchState: { state: 'idle' | 'loading' | 'error'; model?: string; error?: string };
}

export const ModelManagerView: React.FC<ModelManagerViewProps> = ({
  config,
  onSwitchLlmModel,
  onSwitchEmbedModel,
  onReloadGpu,
  onUpdateConfig,
  switchState,
  embedSwitchState
}) => {
  const [customModelRepo, setCustomModelRepo] = useState('');

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-8 bg-[#030712] max-w-6xl mx-auto">
      {/* Hardware Topology Header */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent flex items-center gap-2">
            <Cpu className="w-6 h-6 text-sky-400" />
            <span>Intel Hardware Accelerators & Model Engine</span>
          </h2>
          {config.llmHardware === 'CPU' && (
            <button
              onClick={onReloadGpu}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shadow-md transition"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Force Reload on GPU</span>
            </button>
          )}
        </div>
        <p className="text-sm text-slate-400">
          Native Intel OpenVINO runtime partition: LLM execution pinned to Intel GPU (/dev/dri) and vector embeddings pinned to Intel NPU (/dev/accel/accel0).
        </p>
      </div>

      {/* Hardware Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Intel GPU Card */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase font-bold tracking-wider text-slate-400">
              Intel GPU (/dev/dri)
            </span>
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
          </div>
          <div className="text-lg font-bold text-slate-100">
            {config.llmHardware === 'GPU' ? 'Active & Hosting LLM' : 'Idle / CPU Active'}
          </div>
          <div className="text-xs text-slate-400 mt-2 space-y-1 font-mono">
            <p>VRAM Cap: ~6.8 GB (Lunar Lake)</p>
            <p>Quantization: INT4 Weight-Only</p>
            <p>Pipeline: openvino_genai</p>
          </div>
        </div>

        {/* Intel NPU Card */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase font-bold tracking-wider text-slate-400">
              Intel NPU (/dev/accel/accel0)
            </span>
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
          </div>
          <div className="text-lg font-bold text-slate-100">
            {config.embedHardware === 'NPU' ? 'Active & Embedding' : 'CPU Fallback'}
          </div>
          <div className="text-xs text-slate-400 mt-2 space-y-1 font-mono">
            <p>Model: BGE Base (768 dims)</p>
            <p>Shape: Static (1, 512)</p>
            <p>Zero CPU/GPU Interference</p>
          </div>
        </div>

        {/* Fallback Rules Card */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase font-bold tracking-wider text-slate-400">
              Platform Directive
            </span>
            <Layers className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-lg font-bold text-slate-100">Pure OpenVINO</div>
          <div className="text-xs text-slate-400 mt-2 space-y-1">
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input
                type="checkbox"
                checked={config.switchAllowCpu}
                onChange={e => onUpdateConfig({ switchAllowCpu: e.target.checked })}
                className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-0"
              />
              <span className="text-slate-300 font-sans text-xs">Allow CPU fallback if model &gt; 6.8 GB</span>
            </label>
            <p className="text-[11px] text-slate-500 font-sans">
              (Rolls back to current model by default if memory fails)
            </p>
          </div>
        </div>
      </div>

      {/* Switch Status Banner */}
      {switchState.state === 'loading' && (
        <div className="p-4 rounded-xl bg-indigo-950/60 border border-indigo-700/60 text-indigo-200 flex items-center gap-3 animate-pulse">
          <RefreshCw className="w-5 h-5 animate-spin text-sky-400" />
          <div>
            <div className="font-semibold text-sm">Switching LLM Model…</div>
            <div className="text-xs text-indigo-300">
              Downloading weights and compiling pipeline for Intel GPU. The server returns 503 until ready.
            </div>
          </div>
        </div>
      )}

      {switchState.state === 'error' && (
        <div className="p-4 rounded-xl bg-red-950/60 border border-red-700/60 text-red-200 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <div>
            <div className="font-semibold text-sm">Model Switch Failed & Rolled Back</div>
            <div className="text-xs text-red-300">{switchState.error}</div>
          </div>
        </div>
      )}

      {/* Curated LLM Models Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
            <Zap className="w-5 h-5 text-indigo-400" />
            <span>Curated OpenVINO INT4 LLM Models</span>
          </h3>
          <span className="text-xs text-slate-400">
            Active: <strong className="text-indigo-300">{config.currentLlmModel.split('/').pop()}</strong>
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {CURATED_LLM_MODELS.map(model => {
            const isActive = config.currentLlmModel === model.id;
            const isSwitching = switchState.state === 'loading' && switchState.model === model.id;

            return (
              <div
                key={model.id}
                className={`p-4 rounded-xl border transition-all ${
                  isActive
                    ? 'bg-indigo-950/40 border-indigo-500/80 shadow-lg shadow-indigo-500/10'
                    : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100 text-sm">{model.name}</span>
                      {model.default && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300">
                          Default
                        </span>
                      )}
                      {model.recommended && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-950 text-sky-300 border border-sky-800/60">
                          Recommended
                        </span>
                      )}
                      {model.heavy && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950 text-amber-300 border border-amber-800/60">
                          Needs &gt;8GB
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 font-mono mt-0.5">{model.id}</div>
                  </div>

                  <div className="text-right">
                    <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-300">
                      {model.size}
                    </span>
                  </div>
                </div>

                <p className="text-xs text-slate-400 mb-3">{model.description}</p>

                <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
                  <span className="text-[11px] text-slate-500">Context: {model.contextWindow}</span>
                  {isActive ? (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
                      <CheckCircle className="w-3.5 h-3.5" />
                      Active on GPU
                    </span>
                  ) : (
                    <button
                      onClick={() => onSwitchLlmModel(model.id)}
                      disabled={switchState.state === 'loading'}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold transition"
                    >
                      {isSwitching ? (
                        <>
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          <span>Switching…</span>
                        </>
                      ) : (
                        <>
                          <span>Switch to Model</span>
                          <ArrowRight className="w-3 h-3" />
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Custom Hugging Face Repo Input */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col sm:flex-row items-center gap-3">
          <div className="flex-1 w-full">
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Custom OpenVINO Hugging Face Repo
            </label>
            <input
              type="text"
              placeholder="e.g. OpenVINO/Qwen2.5-Coder-7B-Instruct-int4-ov"
              value={customModelRepo}
              onChange={e => setCustomModelRepo(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button
            onClick={() => customModelRepo.trim() && onSwitchLlmModel(customModelRepo.trim())}
            disabled={!customModelRepo.trim() || switchState.state === 'loading'}
            className="w-full sm:w-auto mt-auto sm:mt-5 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold transition"
          >
            Load Custom Repo
          </button>
        </div>
      </div>

      <hr className="border-slate-800" />

      {/* Embedding Models Section */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
            <Layers className="w-5 h-5 text-purple-400" />
            <span>NPU Vector Embedding Models</span>
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Running on the Intel NPU. The default BGE Base produces 768-dimensional vectors aligned with the Qdrant index.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CURATED_EMBED_MODELS.map(em => {
            const isActive = config.currentEmbedModel === em.id;
            return (
              <div
                key={em.id}
                className={`p-4 rounded-xl border transition-all ${
                  isActive
                    ? 'bg-purple-950/30 border-purple-500/80 shadow-lg shadow-purple-500/10'
                    : 'bg-slate-900/60 border-slate-800'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="font-bold text-slate-100 text-sm">{em.name}</div>
                  <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-purple-300">
                    {em.dims} dims
                  </span>
                </div>
                <div className="text-xs font-mono text-slate-400 mb-2">{em.id}</div>
                <p className="text-xs text-slate-400 mb-3">{em.description}</p>
                <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                  <span className="text-[11px] text-slate-500">Device: {em.device}</span>
                  {isActive ? (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
                      <CheckCircle className="w-3.5 h-3.5" />
                      Active on NPU
                    </span>
                  ) : (
                    <button
                      onClick={() => onSwitchEmbedModel(em.id)}
                      disabled={embedSwitchState.state === 'loading'}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold transition"
                    >
                      Switch & Reindex
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
