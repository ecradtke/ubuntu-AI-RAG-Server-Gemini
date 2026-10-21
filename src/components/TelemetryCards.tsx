import React from 'react';
import { Cpu, Database, Sparkles, Network } from 'lucide-react';
import { ClusterConfig } from '../types';

interface TelemetryCardsProps {
  config: ClusterConfig;
  articleCount: number;
  dbConnected?: boolean;
  dbError?: string;
}

export const TelemetryCards: React.FC<TelemetryCardsProps> = ({ config, articleCount, dbConnected = true, dbError }) => {
  const modelShortName = config.currentLlmModel.split('/').pop() || config.currentLlmModel;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {/* Metric 1: Inference Engine */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 backdrop-blur-md hover:border-indigo-500/40 transition-all hover:-translate-y-0.5">
        <div className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
          <span>Inference Engine (Intel)</span>
          <Cpu className="w-4 h-4 text-sky-400" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
          <span className="text-base sm:text-lg font-bold text-slate-100">
            OpenVINO ({config.llmHardware} • {config.embedHardware})
          </span>
        </div>
        <div className="text-[11px] text-slate-500 mt-1 font-mono">
          GPU: LLM • NPU: BGE-Base 768d
        </div>
      </div>

      {/* Metric 2: Vector Database Records */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 backdrop-blur-md hover:border-indigo-500/40 transition-all hover:-translate-y-0.5">
        <div className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
          <span>{config.activeDbEngine.split(' ')[0]} ({config.activeCollection})</span>
          <Database className="w-4 h-4 text-indigo-400" />
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              dbConnected
                ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                : 'bg-rose-500 shadow-[0_0_8px_#f43f5e] animate-pulse'
            }`}
          />
          <span className="text-base sm:text-lg font-bold text-slate-100">
            {dbConnected
              ? `${articleCount.toLocaleString()} Records`
              : 'Disconnected'}
          </span>
        </div>
        <div className="text-[11px] text-slate-400 mt-1 font-mono truncate" title={dbError || ''}>
          {dbConnected
            ? articleCount === 0
              ? 'Collection empty (run sync to embed)'
              : 'Cosine Index :6333'
            : (dbError ? `Error: ${dbError.slice(0, 32)}` : 'Port 6333 unreachable')}
        </div>
      </div>

      {/* Metric 3: Active Model */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 backdrop-blur-md hover:border-indigo-500/40 transition-all hover:-translate-y-0.5">
        <div className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
          <span>Active LLM Model</span>
          <Sparkles className="w-4 h-4 text-purple-400" />
        </div>
        <div className="text-base sm:text-lg font-bold text-slate-100 truncate" title={config.currentLlmModel}>
          {modelShortName}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 font-mono truncate">
          INT4 OpenVINO Pipeline
        </div>
      </div>

      {/* Metric 4: Search Strategy */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 backdrop-blur-md hover:border-indigo-500/40 transition-all hover:-translate-y-0.5">
        <div className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
          <span>Search Strategy</span>
          <Network className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="text-base sm:text-lg font-bold text-slate-100">
          Hybrid (Vector + URL)
        </div>
        <div className="text-[11px] text-slate-500 mt-1 font-mono">
          NPU Embeddings + Exact Match
        </div>
      </div>
    </div>
  );
};
