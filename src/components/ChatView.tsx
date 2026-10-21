import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Sparkles,
  Download,
  Copy,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  BarChart2,
  Brain,
  AlertCircle,
  FileCode,
  Check,
  Zap,
  Info
} from 'lucide-react';
import { ChatMessage, QueryStats, SourceItem } from '../types';
import { cleanUrl, answerToHtml } from '../utils/ragUtils';

interface ChatViewProps {
  messages: ChatMessage[];
  onSendMessage: (query: string) => void;
  isGenerating: boolean;
  activeCollection: string;
}

export const ChatView: React.FC<ChatViewProps> = ({
  messages,
  onSendMessage,
  isGenerating,
  activeCollection
}) => {
  const [input, setInput] = useState('');
  const [expandedStats, setExpandedStats] = useState<Record<string, boolean>>({});
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  const toggleStats = (id: string) => {
    setExpandedStats(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleSources = (id: string) => {
    setExpandedSources(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleThinking = (id: string) => {
    setExpandedThinking(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDownloadHtml = (msg: ChatMessage) => {
    const question = msg.query || 'Report';
    const htmlContent = answerToHtml(question, msg.content, msg.sources, msg.stats);
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report_${new Date().toISOString().slice(0, 10)}_${Date.now().toString().slice(-4)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSend = () => {
    if (!input.trim() || isGenerating) return;
    onSendMessage(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#030712] overflow-hidden">
      {/* Quick Suggestion Chips */}
      <div className="px-4 py-3 bg-slate-950/60 border-b border-slate-800/80">
        <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-slate-400">
          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
          <span>Suggested Research Topics:</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button
            onClick={() =>
              onSendMessage(
                'Provide a briefing on recent Minnesota state politics, legislative developments, and government actions based on the reporting from the Star Tribune, Minnesota Reformer, and Session Daily.'
              )
            }
            disabled={isGenerating}
            className="text-left text-xs bg-slate-900/90 border border-slate-800 hover:border-indigo-500/50 hover:bg-slate-850 p-2 rounded-lg text-slate-300 hover:text-white transition-all disabled:opacity-50"
          >
            🏛️ <span className="font-medium">Minnesota Politics</span>
          </button>

          <button
            onClick={() =>
              onSendMessage(
                'What are the latest high-impact cyber attacks, malware, and critical vulnerabilities reported by The Hacker News?'
              )
            }
            disabled={isGenerating}
            className="text-left text-xs bg-slate-900/90 border border-slate-800 hover:border-indigo-500/50 hover:bg-slate-850 p-2 rounded-lg text-slate-300 hover:text-white transition-all disabled:opacity-50"
          >
            🛡️ <span className="font-medium">Cybersecurity & CVEs</span>
          </button>

          <button
            onClick={() =>
              onSendMessage(
                'Summarize the recent tweets and posts from Elon Musk regarding SpaceX launches and tech updates.'
              )
            }
            disabled={isGenerating}
            className="text-left text-xs bg-slate-900/90 border border-slate-800 hover:border-indigo-500/50 hover:bg-slate-850 p-2 rounded-lg text-slate-300 hover:text-white transition-all disabled:opacity-50"
          >
            🚀 <span className="font-medium">SpaceX & Tech</span>
          </button>

          <button
            onClick={() =>
              onSendMessage(
                'What are the latest reports and discussions regarding oil prices, shipping in the Strait of Hormuz, and economic indicators?'
              )
            }
            disabled={isGenerating}
            className="text-left text-xs bg-slate-900/90 border border-slate-800 hover:border-indigo-500/50 hover:bg-slate-850 p-2 rounded-lg text-slate-300 hover:text-white transition-all disabled:opacity-50"
          >
            📈 <span className="font-medium">Economy & Oil Markets</span>
          </button>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto text-slate-400">
            <div className="w-16 h-16 rounded-2xl bg-indigo-950/60 border border-indigo-800/40 flex items-center justify-center text-indigo-400 mb-4 shadow-xl">
              <Zap className="w-8 h-8 text-sky-400" />
            </div>
            <h3 className="text-lg font-bold text-slate-100 mb-1">
              Welcome to K13 Intelligence Hub
            </h3>
            <p className="text-sm text-slate-400 mb-4">
              Ask anything grounded on Intel OpenVINO hardware acceleration and Qdrant neural search.
            </p>
            <div className="text-xs text-slate-500 space-y-1">
              <p>• GPU: INT4 LLM Pipeline (Qwen3 / Phi / Llama)</p>
              <p>• NPU: BGE Base 768-dim Vector Embeddings</p>
              <p>• Grounded citations with direct source links</p>
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => {
            const isUser = msg.role === 'user';
            const stats = msg.stats;
            const sources = msg.sources || [];

            return (
              <div
                key={msg.id || idx}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-4xl mx-auto`}
              >
                {/* Header label */}
                <div className="flex items-center gap-2 mb-1 text-xs text-slate-400 px-1">
                  <span className="font-semibold text-slate-300">
                    {isUser ? 'You' : '⚡ K13 Analyst'}
                  </span>
                  <span>•</span>
                  <span>{msg.timestamp}</span>
                </div>

                {/* Message Bubble Container */}
                <div
                  className={`w-full rounded-2xl p-4 sm:p-5 text-sm leading-relaxed transition-all ${
                    isUser
                      ? 'bg-indigo-600/20 border border-indigo-500/30 text-indigo-50 shadow-md ml-auto max-w-2xl'
                      : 'bg-slate-900/80 border border-slate-800 text-slate-200 shadow-xl'
                  }`}
                >
                  {/* Context Excerpts Accordion (Assistant only) */}
                  {!isUser && sources.length > 0 && (
                    <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-950/20 overflow-hidden">
                      <button
                        onClick={() => toggleSources(msg.id)}
                        className="w-full flex items-center justify-between p-3 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/30 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Brain className="w-4 h-4 text-indigo-400" />
                          <span>🔍 Retrieved {sources.length} Context Excerpts</span>
                        </div>
                        {expandedSources[msg.id] ? (
                          <ChevronUp className="w-4 h-4 text-indigo-400" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-indigo-400" />
                        )}
                      </button>

                      {expandedSources[msg.id] && (
                        <div className="p-3 pt-0 space-y-3 divide-y divide-slate-800/80">
                          {sources.map((src, sIdx) => {
                            const clean = cleanUrl(src.url);
                            return (
                              <div key={sIdx} className="pt-2.5 first:pt-0">
                                <div className="flex items-center justify-between gap-2">
                                  <a
                                    href={clean}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-semibold text-sky-400 hover:underline flex items-center gap-1.5"
                                  >
                                    <span>{src.title}</span>
                                    {src.url && <ExternalLink className="w-3 h-3 flex-shrink-0" />}
                                  </a>
                                </div>
                                <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                                  {src.feed && (
                                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                                      {src.feed}
                                    </span>
                                  )}
                                  {src.date && <span>{src.date}</span>}
                                </div>
                                <p className="text-xs text-slate-300/90 mt-1.5 bg-slate-950/50 p-2 rounded border border-slate-800/60 font-sans">
                                  {src.text}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Thinking Section if reasoning model */}
                  {!isUser && msg.thinking && (
                    <div className="mb-3 rounded-lg border border-purple-500/30 bg-purple-950/20 overflow-hidden">
                      <button
                        onClick={() => toggleThinking(msg.id)}
                        className="w-full flex items-center justify-between p-2.5 text-xs text-purple-300 hover:bg-purple-900/30 transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          <Brain className="w-3.5 h-3.5 text-purple-400" />
                          <span>Hidden Reasoning ({msg.thinking.length} chars)</span>
                        </div>
                        {expandedThinking[msg.id] ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {expandedThinking[msg.id] && (
                        <div className="p-3 pt-0 text-xs font-mono text-purple-200/80 whitespace-pre-wrap border-t border-purple-500/20">
                          {msg.thinking}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Main Content */}
                  <div className="prose prose-invert max-w-none prose-sm leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </div>

                  {/* Query Statistics Report (Assistant only) */}
                  {!isUser && stats && (
                    <div className="mt-4 pt-3 border-t border-slate-800/80">
                      <button
                        onClick={() => toggleStats(msg.id)}
                        className="flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
                      >
                        <BarChart2 className="w-3.5 h-3.5 text-sky-400" />
                        <span>📊 Query Statistics</span>
                        {expandedStats[msg.id] ? (
                          <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                        )}
                      </button>

                      {expandedStats[msg.id] && (
                        <div className="mt-3 p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs space-y-3 font-mono">
                          {/* 4 Metric Columns */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
                              <div className="text-[10px] text-slate-400 uppercase font-sans">Tokens/s</div>
                              <div className="text-base font-bold text-sky-400">
                                {stats.gen.tps.toFixed(1)}
                              </div>
                            </div>
                            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
                              <div className="text-[10px] text-slate-400 uppercase font-sans">Output Tokens</div>
                              <div className="text-base font-bold text-indigo-400">
                                {stats.gen.out_tokens.toLocaleString()}
                              </div>
                            </div>
                            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
                              <div className="text-[10px] text-slate-400 uppercase font-sans">Prompt Tokens</div>
                              <div className="text-base font-bold text-purple-400">
                                {stats.gen.in_tokens.toLocaleString()}
                              </div>
                            </div>
                            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
                              <div className="text-[10px] text-slate-400 uppercase font-sans">TTFT</div>
                              <div className="text-base font-bold text-emerald-400">
                                {stats.gen.ttft_s.toFixed(2)}s
                              </div>
                            </div>
                          </div>

                          {/* Timing & device breakdown */}
                          <div className="text-slate-300 font-sans space-y-1 text-xs">
                            <p>
                              • <strong>Total time:</strong> {stats.timing.total_s.toFixed(2)}s (embed{' '}
                              {stats.timing.embed_s.toFixed(2)}s · search {stats.timing.search_s.toFixed(2)}s · generate{' '}
                              {stats.timing.gen_s.toFixed(2)}s)
                            </p>
                            <p>
                              • <strong>Model:</strong> <code className="text-sky-300">{stats.model}</code> on{' '}
                              <strong className="text-emerald-300">{stats.gen.device}</strong>
                            </p>
                            <p>
                              • <strong>Stop reason:</strong> {stats.gen.stop}
                            </p>
                            {stats.gen.thinking_chars > 0 && (
                              <p>
                                • <strong>Hidden reasoning stripped:</strong> {stats.gen.thinking_chars.toLocaleString()} chars
                              </p>
                            )}
                          </div>

                          {/* Retrieval Truncation Table */}
                          <div className="border border-slate-800 rounded-lg overflow-hidden font-sans">
                            <table className="w-full text-left text-xs">
                              <thead className="bg-slate-900 text-slate-400 border-b border-slate-800">
                                <tr>
                                  <th className="p-2">Item</th>
                                  <th className="p-2 text-right">Count</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/80 text-slate-300">
                                <tr>
                                  <td className="p-1.5 px-2">Top K requested</td>
                                  <td className="p-1.5 px-2 text-right font-mono">{stats.retrieval.top_k}</td>
                                </tr>
                                <tr>
                                  <td className="p-1.5 px-2">Excerpts retrieved</td>
                                  <td className="p-1.5 px-2 text-right font-mono">{stats.retrieval.retrieved}</td>
                                </tr>
                                <tr>
                                  <td className="p-1.5 px-2">Excerpts sent to the model</td>
                                  <td className="p-1.5 px-2 text-right font-mono">{stats.retrieval.used}</td>
                                </tr>
                                <tr>
                                  <td className="p-1.5 px-2">Dropped (over token budget)</td>
                                  <td className="p-1.5 px-2 text-right font-mono">{stats.retrieval.dropped}</td>
                                </tr>
                                <tr>
                                  <td className="p-1.5 px-2">Cut at 300-char excerpt cap</td>
                                  <td className="p-1.5 px-2 text-right font-mono">{stats.retrieval.cut_to_cap}</td>
                                </tr>
                                <tr>
                                  <td className="p-1.5 px-2">Shortened further for budget</td>
                                  <td className="p-1.5 px-2 text-right font-mono">{stats.retrieval.cut_for_budget}</td>
                                </tr>
                                <tr>
                                  <td className="p-1.5 px-2">Final chars per excerpt</td>
                                  <td className="p-1.5 px-2 text-right font-mono">{stats.retrieval.excerpt_chars}</td>
                                </tr>
                                <tr>
                                  <td className="p-1.5 px-2">Context budget</td>
                                  <td className="p-1.5 px-2 text-right font-mono">
                                    ~{stats.retrieval.budget_tokens.toLocaleString()} tokens
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action Bar (Assistant only) */}
                  {!isUser && (
                    <div className="flex items-center gap-2 mt-4 pt-2 border-t border-slate-800 text-xs">
                      <button
                        onClick={() => handleDownloadHtml(msg)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white transition-colors"
                      >
                        <Download className="w-3.5 h-3.5 text-sky-400" />
                        <span>💾 Save as HTML</span>
                      </button>

                      <button
                        onClick={() => handleCopy(msg.id, msg.content)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white transition-colors"
                      >
                        {copiedId === msg.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-slate-400" />
                            <span>Copy Markdown</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Box Footer */}
      <div className="p-4 bg-slate-950/80 border-t border-slate-800/80">
        <div className="max-w-4xl mx-auto relative">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about breaking events, summaries, or specific topics (e.g. gas prices, Minnesota politics)..."
            rows={2}
            disabled={isGenerating}
            className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-4 py-3 pr-14 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none transition-all"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isGenerating}
            className="absolute right-3 bottom-4 p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white transition-all shadow-md shadow-indigo-600/30"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
