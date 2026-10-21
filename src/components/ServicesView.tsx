import React, { useState, useEffect, useCallback } from 'react';
import {
  Server,
  Play,
  Square,
  RotateCw,
  Terminal,
  Activity,
  CheckCircle,
  AlertCircle,
  Clock,
  HardDrive,
  RefreshCw,
  Cpu,
  Layers
} from 'lucide-react';
import { SystemService } from '../types';

interface ServicesViewProps {
  services: SystemService[];
  onControlService: (id: string, action: 'start' | 'stop' | 'restart') => Promise<any>;
  onRunSmokeTest: () => Promise<{
    embedSuccess: boolean;
    embedDims: number;
    chatSuccess: boolean;
    chatResponse: string;
    durationSeconds?: number;
  }>;
  onFetchLogs?: (id: string) => Promise<string[]>;
}

export const ServicesView: React.FC<ServicesViewProps> = ({
  services,
  onControlService,
  onRunSmokeTest,
  onFetchLogs
}) => {
  const [selectedLogService, setSelectedLogService] = useState<string>('openvino');
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [autoRefreshLogs, setAutoRefreshLogs] = useState<boolean>(true);
  const [actionInProgress, setActionInProgress] = useState<Record<string, boolean>>({});
  const [feedbackBanner, setFeedbackBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [testOutput, setTestOutput] = useState<{
    running: boolean;
    result?: {
      embedSuccess: boolean;
      embedDims: number;
      chatSuccess: boolean;
      chatResponse: string;
      durationSeconds?: number;
    };
  }>({ running: false });

  // Fetch real journalctl logs for selected service
  const loadLogs = useCallback(async (svcId: string) => {
    if (!onFetchLogs) return;
    setLogsLoading(true);
    try {
      const logs = await onFetchLogs(svcId);
      if (logs && logs.length > 0) {
        setLiveLogs(logs);
      }
    } catch {
      // Keep previous logs if error
    } finally {
      setLogsLoading(false);
    }
  }, [onFetchLogs]);

  useEffect(() => {
    loadLogs(selectedLogService);
  }, [selectedLogService, loadLogs]);

  // Periodic auto-refresh of logs every 4 seconds if enabled
  useEffect(() => {
    if (!autoRefreshLogs) return;
    const interval = setInterval(() => {
      loadLogs(selectedLogService);
    }, 4000);
    return () => clearInterval(interval);
  }, [autoRefreshLogs, selectedLogService, loadLogs]);

  const handleControl = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setActionInProgress(prev => ({ ...prev, [id]: true }));
    setFeedbackBanner(null);

    try {
      const res = await onControlService(id, action);
      if (res && res.error) {
        setFeedbackBanner({
          type: 'error',
          message: `Failed to ${action} ${id}: ${res.error}`
        });
      } else {
        setFeedbackBanner({
          type: 'success',
          message: `Signal sent: ${action.toUpperCase()} command issued for ${id}`
        });
        // Immediately reload logs to show the restart output
        setTimeout(() => loadLogs(id), 1000);
      }
    } catch (err: any) {
      setFeedbackBanner({
        type: 'error',
        message: `Error executing ${action} on ${id}: ${err.message || String(err)}`
      });
    } finally {
      setActionInProgress(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleTest = async () => {
    setTestOutput({ running: true });
    try {
      const res = await onRunSmokeTest();
      setTestOutput({ running: false, result: res });
    } catch {
      setTestOutput({ running: false });
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-8 bg-[#030712] max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent flex items-center gap-2">
            <Server className="w-6 h-6 text-sky-400" />
            <span>Ubuntu Systemd Services & Cluster Control (k13ctl.sh)</span>
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Native Linux systemd daemons running on this host without Docker or virtualization layers.
          </p>
        </div>

        <button
          onClick={handleTest}
          disabled={testOutput.running}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-lg shadow-indigo-600/30 transition disabled:opacity-50"
        >
          {testOutput.running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Terminal className="w-4 h-4" />}
          <span>{testOutput.running ? 'Running Tests…' : 'Run Live Smoke Test (k13ctl test)'}</span>
        </button>
      </div>

      {/* Action Feedback Banner */}
      {feedbackBanner && (
        <div className={`p-3 rounded-xl border flex items-center justify-between text-xs font-semibold ${
          feedbackBanner.type === 'success'
            ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-200'
            : 'bg-red-950/60 border-red-700/60 text-red-200'
        }`}>
          <div className="flex items-center gap-2">
            {feedbackBanner.type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <AlertCircle className="w-4 h-4 text-red-400" />}
            <span>{feedbackBanner.message}</span>
          </div>
          <button onClick={() => setFeedbackBanner(null)} className="text-slate-400 hover:text-slate-200 px-2 py-0.5">✕</button>
        </div>
      )}

      {/* Smoke Test Banner */}
      {testOutput.result && (
        <div className="p-4 rounded-xl bg-slate-900 border border-indigo-500/50 space-y-2 font-mono text-xs shadow-xl">
          <div className="text-xs font-bold text-slate-300 font-sans flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span>Live Smoke Test Completed (k13ctl.sh test)</span>
            </div>
            {testOutput.result.durationSeconds !== undefined && (
              <span className="text-slate-400 text-[11px] font-mono">
                Duration: {testOutput.result.durationSeconds}s
              </span>
            )}
          </div>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-slate-300 space-y-1">
            <p className={testOutput.result.embedSuccess ? "text-emerald-400 font-semibold" : "text-amber-400 font-semibold"}>
              [{testOutput.result.embedSuccess ? '✓' : '!'}] Embedding test: {testOutput.result.embedSuccess ? '200 OK' : 'Pending / Offline'}
            </p>
            <p className="text-slate-400 pl-4">• Vector dimensions: {testOutput.result.embedDims} (Intel NPU accelerated)</p>
            <p className={testOutput.result.chatSuccess ? "text-emerald-400 font-semibold mt-1" : "text-amber-400 font-semibold mt-1"}>
              [{testOutput.result.chatSuccess ? '✓' : '!'}] Chat LLM test: {testOutput.result.chatSuccess ? '200 OK' : 'Pending / Offline'}
            </p>
            <p className="text-slate-400 pl-4">• Response: "{testOutput.result.chatResponse}"</p>
          </div>
        </div>
      )}

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {services.map(svc => {
          const isActive = svc.status === 'active';
          const isRestarting = svc.status === 'restarting' || actionInProgress[svc.id];

          return (
            <div
              key={svc.id}
              className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 shadow-xl flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100 text-sm">{svc.name}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-400">
                        {svc.unit}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{svc.role}</p>
                  </div>

                  <span
                    className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${
                      isActive
                        ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60'
                        : isRestarting
                        ? 'bg-amber-950/80 text-amber-300 border-amber-800/60 animate-pulse'
                        : 'bg-red-950/80 text-red-300 border-red-800/60'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isActive
                          ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
                          : isRestarting
                          ? 'bg-amber-400'
                          : 'bg-red-400'
                      }`}
                    />
                    <span>{isRestarting ? 'restarting…' : svc.status}</span>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 my-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 text-xs text-slate-400 font-mono">
                  <div>
                    <span className="text-slate-500 block text-[10px] uppercase font-sans">Port / Cadence</span>
                    <span className="text-slate-200">{svc.port}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[10px] uppercase font-sans">Uptime</span>
                    <span className="text-slate-200">{svc.uptime}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[10px] uppercase font-sans">Memory</span>
                    <span className="text-slate-200">{svc.memory}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[10px] uppercase font-sans">Target Hardware</span>
                    <span className="text-slate-200">{svc.hardware.split(' ')[0]}</span>
                  </div>
                </div>
              </div>

              {/* Actions & Log trigger */}
              <div className="flex items-center justify-between pt-3 border-t border-slate-800">
                <button
                  onClick={() => setSelectedLogService(svc.id)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition flex items-center gap-1.5 ${
                    selectedLogService === svc.id
                      ? 'bg-sky-950 text-sky-300 border-sky-700 font-semibold shadow-sm'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  <Terminal className="w-3 h-3" />
                  <span>View Logs</span>
                </button>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleControl(svc.id, 'restart')}
                    disabled={isRestarting}
                    title="Restart service (k13ctl restart)"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 hover:text-white transition flex items-center gap-1 text-xs"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${isRestarting ? 'animate-spin text-sky-400' : ''}`} />
                    <span className="text-[11px] font-sans">Restart</span>
                  </button>
                  {isActive ? (
                    <button
                      onClick={() => handleControl(svc.id, 'stop')}
                      disabled={isRestarting}
                      title="Stop service (k13ctl stop)"
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-red-900/60 disabled:opacity-50 text-slate-300 hover:text-red-300 transition flex items-center gap-1 text-xs"
                    >
                      <Square className="w-3.5 h-3.5" />
                      <span className="text-[11px] font-sans">Stop</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleControl(svc.id, 'start')}
                      disabled={isRestarting}
                      title="Start service (k13ctl start)"
                      className="p-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white transition flex items-center gap-1 text-xs"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span className="text-[11px] font-sans">Start</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Terminal Journalctl Viewer */}
      <div className="rounded-2xl bg-slate-950 border border-slate-800 overflow-hidden shadow-2xl">
        <div className="px-4 py-3 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="font-mono text-xs text-slate-300">
              journalctl -fu {services.find(s => s.id === selectedLogService)?.unit || 'k13-openvino.service'} -n 100
            </span>
            {logsLoading && <RefreshCw className="w-3 h-3 animate-spin text-sky-400 ml-2" />}
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-slate-400 select-none">
              <input
                type="checkbox"
                checked={autoRefreshLogs}
                onChange={e => setAutoRefreshLogs(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-0 w-3 h-3"
              />
              <span>Live stream</span>
            </label>

            <button
              onClick={() => loadLogs(selectedLogService)}
              disabled={logsLoading}
              title="Refresh logs"
              className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
            >
              <RefreshCw className={`w-3 h-3 ${logsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="p-4 font-mono text-xs text-slate-300 space-y-1 overflow-x-auto max-h-80 min-h-48 font-light">
          {liveLogs.length > 0 ? (
            liveLogs.map((line, i) => (
              <div key={i} className="leading-relaxed hover:bg-slate-900/60 px-1 rounded flex">
                <span className="text-slate-600 mr-3 select-none w-6 text-right flex-shrink-0">{i + 1}</span>
                <span className={
                  line.includes('ERROR') || line.includes('error') || line.includes('Failed')
                    ? 'text-rose-400'
                    : line.includes('WARN') || line.includes('warning')
                    ? 'text-amber-300'
                    : line.includes('INFO')
                    ? 'text-sky-300'
                    : line.includes('[✓]') || line.includes('Started') || line.includes('ready')
                    ? 'text-emerald-400'
                    : 'text-slate-300'
                }>
                  {line}
                </span>
              </div>
            ))
          ) : (
            <div className="text-slate-500 italic py-8 text-center">
              {logsLoading ? 'Streaming systemd journal output…' : 'No log lines captured yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
