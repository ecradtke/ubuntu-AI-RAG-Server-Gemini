import React from 'react';
import {
  Sliders,
  Database,
  Filter,
  Trash2,
  Cpu,
  Clock,
  Sparkles,
  HelpCircle,
  AlertTriangle
} from 'lucide-react';
import {
  ClusterConfig,
  DBEngine,
  PersonaType,
  TimeframeChoice
} from '../types';
import { CURATED_LLM_MODELS, CURATED_EMBED_MODELS } from '../constants/models';

interface SidebarFiltersProps {
  config: ClusterConfig;
  onUpdateConfig: (newConfig: Partial<ClusterConfig>) => void;
  feedList: string[];
  groupList: string[];
  onClearChat: () => void;
  onOpenModelManager: () => void;
}

const TIMEFRAME_CHOICES: TimeframeChoice[] = [
  'All Time',
  'Past 24 Hours',
  'Past 7 Days',
  'Past 30 Days',
  'Custom range…'
];

const COMMON_TIMEZONES = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Los_Angeles',
  'UTC'
];

export const SidebarFilters: React.FC<SidebarFiltersProps> = ({
  config,
  onUpdateConfig,
  feedList,
  groupList,
  onClearChat,
  onOpenModelManager
}) => {
  const estTokens = config.topK * 145;
  const isBudgetExceeded = estTokens > config.ragContextTokenBudget;

  return (
    <aside className="w-full lg:w-80 bg-slate-950/70 border-r border-slate-800/80 p-4 sm:p-5 flex flex-col gap-6 text-sm text-slate-300 overflow-y-auto">
      {/* Cluster Endpoints */}
      <div>
        <div className="flex items-center gap-2 text-xs uppercase font-bold tracking-wider text-slate-400 mb-3">
          <Sliders className="w-4 h-4 text-sky-400" />
          <span>Cluster Endpoints</span>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Inference Server URL
            </label>
            <input
              type="text"
              value={config.inferenceUrl}
              onChange={e => onUpdateConfig({ inferenceUrl: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
            />
            <span className="text-[10px] text-slate-500">FastAPI OpenVINO server (:11434)</span>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Active Database
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {(['Qdrant (Local)', 'ChromaDB (Local File)'] as DBEngine[]).map(engine => (
                <button
                  key={engine}
                  onClick={() => onUpdateConfig({ activeDbEngine: engine })}
                  className={`text-xs py-1.5 px-2 rounded-md font-medium text-center border transition-all ${
                    config.activeDbEngine === engine
                      ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {engine.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              {config.activeDbEngine.startsWith('Qdrant') ? 'Qdrant Collection' : 'Chroma Collection'}
            </label>
            <select
              value={config.activeCollection}
              onChange={e => onUpdateConfig({ activeCollection: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="rss_articles">rss_articles (News & Feeds)</option>
              <option value="audio_transcripts">audio_transcripts (Whisper Transcripts)</option>
            </select>
          </div>
        </div>
      </div>

      <hr className="border-slate-800" />

      {/* Intelligence & Search */}
      <div>
        <div className="flex items-center justify-between text-xs uppercase font-bold tracking-wider text-slate-400 mb-3">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-purple-400" />
            <span>Intelligence & Search</span>
          </div>
          <button
            onClick={onOpenModelManager}
            className="text-[11px] text-indigo-400 hover:text-indigo-300 underline font-normal"
          >
            Manage
          </button>
        </div>

        {/* Top K slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-300">Excerpts to Retrieve (Top K)</span>
            <span className="font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-indigo-300 font-semibold">
              {config.topK}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={config.topK}
            onChange={e => onUpdateConfig({ topK: parseInt(e.target.value) || 1 })}
            className="w-full accent-indigo-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
          />
          <div className="text-[11px] text-slate-400">
            {isBudgetExceeded ? (
              <span className="text-amber-400 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                ≈{estTokens.toLocaleString()} tokens needed; excerpts will be shortened to fit {config.ragContextTokenBudget.toLocaleString()} budget.
              </span>
            ) : (
              <span>
                ≈{estTokens.toLocaleString()} tokens of context (budget: {config.ragContextTokenBudget.toLocaleString()}).
              </span>
            )}
          </div>
        </div>

        {/* Persona */}
        <div className="mt-4">
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Analyst Persona
          </label>
          <select
            value={config.persona}
            onChange={e => onUpdateConfig({ persona: e.target.value as PersonaType })}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="Objective News Analyst">Objective News Analyst</option>
            <option value="Executive Intelligence Brief">Executive Intelligence Brief</option>
            <option value="Technical Deep Dive">Technical Deep Dive</option>
            <option value="Analytical Unbiased">Analytical Unbiased (Rigorous 6-Principle)</option>
          </select>
        </div>
      </div>

      <hr className="border-slate-800" />

      {/* Search Filters */}
      <div>
        <div className="flex items-center gap-2 text-xs uppercase font-bold tracking-wider text-slate-400 mb-3">
          <Filter className="w-4 h-4 text-emerald-400" />
          <span>Search Filters</span>
        </div>

        <div className="space-y-3">
          {/* Timeframe */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Timeframe
            </label>
            <select
              value={config.timeframeChoice}
              onChange={e => onUpdateConfig({ timeframeChoice: e.target.value as TimeframeChoice })}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {TIMEFRAME_CHOICES.map(tf => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </div>

          {/* Custom Date & Time Picker */}
          {config.timeframeChoice === 'Custom range…' && (
            <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 space-y-2 text-xs">
              <div>
                <label className="text-[11px] text-slate-400">Timezone</label>
                <select
                  value={config.timeZone}
                  onChange={e => onUpdateConfig({ timeZone: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-300 text-xs mt-0.5"
                >
                  {COMMON_TIMEZONES.map(tz => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <span className="text-[11px] font-semibold text-slate-300">From</span>
                <div className="grid grid-cols-2 gap-1.5 mt-0.5">
                  <input
                    type="date"
                    value={config.customStartDate || ''}
                    onChange={e => onUpdateConfig({ customStartDate: e.target.value })}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                  />
                  <input
                    type="time"
                    value={config.customStartTime || '00:00'}
                    onChange={e => onUpdateConfig({ customStartTime: e.target.value })}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                  />
                </div>
              </div>

              <div>
                <span className="text-[11px] font-semibold text-slate-300">To</span>
                <div className="grid grid-cols-2 gap-1.5 mt-0.5">
                  <input
                    type="date"
                    value={config.customEndDate || ''}
                    onChange={e => onUpdateConfig({ customEndDate: e.target.value })}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                  />
                  <input
                    type="time"
                    value={config.customEndTime || '23:59'}
                    onChange={e => onUpdateConfig({ customEndTime: e.target.value })}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Feed Filter */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Feed Source
            </label>
            <select
              value={config.feedFilter}
              onChange={e => onUpdateConfig({ feedFilter: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {feedList.map(feed => (
                <option key={feed} value={feed}>
                  {feed}
                </option>
              ))}
            </select>
          </div>

          {/* Group Filter */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Group / Category
            </label>
            <select
              value={config.groupFilter}
              onChange={e => onUpdateConfig({ groupFilter: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {groupList.map(group => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </div>

          {/* Search Keywords */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Vector Search Keywords
            </label>
            <input
              type="text"
              placeholder="Optional exact keywords..."
              value={config.searchKeywords}
              onChange={e => onUpdateConfig({ searchKeywords: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
            <span className="text-[10px] text-slate-500">Searches these exact words instead of long prompt.</span>
          </div>
        </div>
      </div>

      <div className="mt-auto pt-4 border-t border-slate-800">
        <button
          onClick={onClearChat}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-red-500/40 text-slate-400 hover:text-red-300 text-xs font-medium transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Clear Chat History</span>
        </button>
      </div>
    </aside>
  );
};
