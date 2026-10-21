import React from 'react';
import { Cpu, Zap, Database, Server, FileText, Settings, Radio } from 'lucide-react';
import { ClusterConfig } from '../types';

interface HeaderProps {
  config: ClusterConfig;
  activeTab: 'chat' | 'models' | 'brief' | 'services' | 'config';
  onTabChange: (tab: 'chat' | 'models' | 'brief' | 'services' | 'config') => void;
  onReloadGpu: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  config,
  activeTab,
  onTabChange,
  onReloadGpu
}) => {
  return (
    <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand Logo & Name */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-600 p-0.5 shadow-lg shadow-indigo-500/20">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                <Zap className="w-5 h-5 text-sky-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">
                  K13 AI Hub
                </span>
                <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-sky-950/80 text-sky-300 border border-sky-800/50">
                  Ubuntu Server
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Native OpenVINO • GPU LLM + NPU Embeddings
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center gap-1 sm:gap-2">
            <button
              onClick={() => onTabChange('chat')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                activeTab === 'chat'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Radio className="w-4 h-4" />
              <span>Intelligence RAG</span>
            </button>

            <button
              onClick={() => onTabChange('models')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                activeTab === 'models'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Cpu className="w-4 h-4" />
              <span>Model Switcher</span>
            </button>

            <button
              onClick={() => onTabChange('brief')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                activeTab === 'brief'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <FileText className="w-4 h-4" />
              <span>Daily Brief</span>
            </button>

            <button
              onClick={() => onTabChange('services')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                activeTab === 'services'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Server className="w-4 h-4" />
              <span>k13ctl Services</span>
            </button>

            <button
              onClick={() => onTabChange('config')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                activeTab === 'config'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Settings className="w-4 h-4" />
              <span className="hidden md:inline">Config (.env)</span>
            </button>
          </nav>

          {/* Hardware status badge */}
          <div className="hidden lg:flex items-center gap-3">
            {config.llmHardware === 'CPU' ? (
              <button
                onClick={onReloadGpu}
                title="LLM is currently running on CPU fallback! Click to reload on Intel GPU."
                className="flex items-center gap-1.5 text-xs bg-amber-950/80 border border-amber-600/50 text-amber-300 px-2.5 py-1 rounded-md hover:bg-amber-900/60 transition"
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>CPU Fallback • Reload GPU</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg text-slate-300">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                <span className="font-mono text-[11px] text-slate-300">
                  GPU: <strong className="text-sky-300">{config.llmHardware}</strong> • NPU: <strong className="text-purple-300">{config.embedHardware}</strong>
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
