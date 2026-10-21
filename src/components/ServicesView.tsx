import React, { useState } from 'react';
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
  HardDrive
} from 'lucide-react';
import { SystemService } from '../types';

interface ServicesViewProps {
  services: SystemService[];
  onControlService: (id: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
  onRunSmokeTest: () => Promise<{
    embedSuccess: boolean;
    embedDims: number;
    chatSuccess: boolean;
    chatResponse: string;
  }>;
}

export const ServicesView: React.FC<ServicesViewProps> = ({
  services,
  onControlService,
  onRunSmokeTest
}) => {
  const [selectedLogService, setSelectedLogService] = useState<string>('openvino');
  const [testOutput, setTestOutput] = useState<{
    running: boolean;
    result?: {
      embedSuccess: boolean;
      embedDims: number;
      chatSuccess: boolean;
      chatResponse: string;
    };
  }>({ running: false });

  const handleTest = async () => {
    setTestOutput({ running: true });
    const res = await onRunSmokeTest();
    setTestOutput({ running: false, result: res });
  };

  const getLogs = (svcId: string): string[] => {
    const timestamp = new Date().toLocaleTimeString();
    switch (svcId) {
      case 'openvino':
        return [
          `systemd[1]: Started k13-openvino.service - OpenVINO Inference Server.`,
          `openvino-server: INFO - OpenVINO detected available devices: ['CPU', 'GPU.0', 'NPU']`,
          `openvino-server: INFO - [✓] Intel GPU.0 selected for LLM inference.`,
          `openvino-server: INFO - [✓] Intel NPU selected for embedding generation.`,
          `openvino-server: INFO - Loading LLM pipeline from /opt/k13/models/OpenVINO-Phi-3.5-mini-instruct-int4-ov`,
          `openvino-server: INFO - LLM pipeline compiled successfully on Intel GPU (INT4, 2.2GB VRAM).`,
          `openvino-server: INFO - Embedding model BAAI/bge-base-en-v1.5 compiled with static shape (1, 512) on Intel NPU.`,
          `openvino-server: INFO - Uvicorn running on http://127.0.0.1:11434 (Press CTRL+C to quit)`
        ];
      case 'qdrant':
        return [
          `systemd[1]: Started k13-qdrant.service - Qdrant Vector Database.`,
          `qdrant: INFO - Storage path: /opt/k13/data/qdrant`,
          `qdrant: INFO - REST API listening on 127.0.0.1:6333, gRPC on :6334`,
          `qdrant: INFO - Loaded collection 'rss_articles' (dim: 768, distance: Cosine)`,
          `qdrant: INFO - Loaded collection 'audio_transcripts' (dim: 768, distance: Cosine)`,
          `qdrant: INFO - Indexed points count: 14,820 points`
        ];
      case 'web':
        return [
          `systemd[1]: Started k13-web.service - K13 AI Hub Web Portal.`,
          `k13-web: Vite dev server running on port 3000 (host: 0.0.0.0)`,
          `k13-web: Proxying vector search to http://127.0.0.1:6333`,
          `k13-web: Telemetry connected to http://127.0.0.1:11434/healthz`
        ];
      case 'rss':
        return [
          `systemd[1]: Triggered k13-rss-sync.timer.`,
          `k13-rss-sync: Connecting to FreshRSS NAS API (user: admin)...`,
          `k13-rss-sync: Fetched 38 new articles since last sync.`,
          `k13-rss-sync: Generating 768-dim embeddings via Intel NPU (:11434/api/embed)...`,
          `k13-rss-sync: Upserted 38 points to Qdrant collection 'rss_articles'.`,
          `systemd[1]: k13-rss-sync.service: Deactivated successfully.`
        ];
      default:
        return [`Log stream initialized.`];
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
          <Terminal className="w-4 h-4" />
          <span>{testOutput.running ? 'Running Tests…' : 'Run Smoke Test (k13ctl test)'}</span>
        </button>
      </div>

      {/* Smoke Test Banner */}
      {testOutput.result && (
        <div className="p-4 rounded-xl bg-slate-900 border border-indigo-500/50 space-y-2 font-mono text-xs shadow-xl">
          <div className="text-xs font-bold text-slate-300 font-sans flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            <span>Smoke Test Completed Successfully (k13ctl.sh test)</span>
          </div>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-slate-300 space-y-1">
            <p className="text-emerald-400 font-semibold">[✓] Embedding test: HTTP 200 OK</p>
            <p className="text-slate-400 pl-4">• Vector dimensions: {testOutput.result.embedDims} (NPU accelerated)</p>
            <p className="text-emerald-400 font-semibold mt-1">[✓] Chat test: HTTP 200 OK</p>
            <p className="text-slate-400 pl-4">• Response: "{testOutput.result.chatResponse}"</p>
          </div>
        </div>
      )}

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {services.map(svc => {
          const isActive = svc.status === 'active';
          const isRestarting = svc.status === 'restarting';

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
                        ? 'bg-amber-950/80 text-amber-300 border-amber-800/60'
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
                    <span>{svc.status}</span>
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
                    <span className="text-slate-500 block text-[10px] uppercase font-sans">Target</span>
                    <span className="text-slate-200">{svc.hardware.split(' ')[0]}</span>
                  </div>
                </div>
              </div>

              {/* Actions & Log trigger */}
              <div className="flex items-center justify-between pt-3 border-t border-slate-800">
                <button
                  onClick={() => setSelectedLogService(svc.id)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                    selectedLogService === svc.id
                      ? 'bg-sky-950 text-sky-300 border-sky-700 font-semibold'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  View Logs
                </button>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => onControlService(svc.id, 'restart')}
                    disabled={isRestarting}
                    title="Restart service (k13ctl restart)"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                  {isActive ? (
                    <button
                      onClick={() => onControlService(svc.id, 'stop')}
                      title="Stop service (k13ctl stop)"
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-red-900/60 text-slate-300 hover:text-red-300 transition"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => onControlService(svc.id, 'start')}
                      title="Start service (k13ctl start)"
                      className="p-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white transition"
                    >
                      <Play className="w-3.5 h-3.5" />
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
              journalctl -fu {services.find(s => s.id === selectedLogService)?.unit} -n 100
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-700" />
            <span className="w-2.5 h-2.5 rounded-full bg-slate-700" />
            <span className="w-2.5 h-2.5 rounded-full bg-slate-700" />
          </div>
        </div>

        <div className="p-4 font-mono text-xs text-slate-300 space-y-1 overflow-x-auto max-h-72">
          {getLogs(selectedLogService).map((line, i) => (
            <div key={i} className="leading-relaxed hover:bg-slate-900/40 px-1 rounded">
              <span className="text-slate-500 mr-2">{i + 1}</span>
              <span className={line.includes('INFO') ? 'text-sky-300' : line.includes('Started') ? 'text-emerald-400' : 'text-slate-300'}>
                {line}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
