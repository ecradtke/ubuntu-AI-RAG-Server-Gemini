import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Header } from './components/Header';
import { TelemetryCards } from './components/TelemetryCards';
import { SidebarFilters } from './components/SidebarFilters';
import { ChatView } from './components/ChatView';
import { ModelManagerView } from './components/ModelManagerView';
import { DailyBriefView } from './components/DailyBriefView';
import { ServicesView } from './components/ServicesView';
import { ConfigView } from './components/ConfigView';
import { ClusterConfig, ChatMessage } from './types';
import { K13Client } from './services/k13Client';

const defaultHost = typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '127.0.0.1';

const envBudget = Number((import.meta as any).env?.RAG_CONTEXT_TOKEN_BUDGET || (import.meta as any).env?.VITE_RAG_CONTEXT_TOKEN_BUDGET) || 20000;
const envTopKMax = Number((import.meta as any).env?.TOP_K_MAX || (import.meta as any).env?.VITE_TOP_K_MAX) || 150;
const envMaxNewTokens = Number((import.meta as any).env?.MAX_NEW_TOKENS || (import.meta as any).env?.VITE_MAX_NEW_TOKENS) || 2048;

const INITIAL_CONFIG: ClusterConfig = {
  connectionMode: 'live',
  inferenceUrl: `http://${defaultHost}:11434`,
  qdrantUrl: `http://${defaultHost}:6333`,
  activeCollection: 'rss_articles',
  activeDbEngine: 'Qdrant (Local)',
  currentLlmModel: (import.meta as any).env?.DEFAULT_MODEL || 'OpenVINO/Phi-3.5-mini-instruct-int4-ov',
  currentEmbedModel: (import.meta as any).env?.EMBED_MODEL || 'BAAI/bge-base-en-v1.5',
  llmHardware: 'GPU',
  embedHardware: 'NPU',
  topK: 6,
  topKMax: envTopKMax,
  maxNewTokens: envMaxNewTokens,
  ragContextTokenBudget: envBudget,
  persona: 'Objective News Analyst',
  feedFilter: '(All Feeds)',
  groupFilter: '(All Groups)',
  timeframeChoice: 'All Time',
  timeZone: 'America/Chicago',
  searchKeywords: '',
  llmThinking: false,
  switchAllowCpu: false
};

export const App: React.FC = () => {
  const [config, setConfig] = useState<ClusterConfig>(() => {
    const saved = localStorage.getItem('k13_cluster_config');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // If accessed from a remote LAN IP or hostname, update stale 127.0.0.1/localhost to current host
        if (defaultHost !== '127.0.0.1' && defaultHost !== 'localhost') {
          if (parsed.inferenceUrl?.includes('127.0.0.1') || parsed.inferenceUrl?.includes('localhost')) {
            parsed.inferenceUrl = `http://${defaultHost}:11434`;
          }
          if (parsed.qdrantUrl?.includes('127.0.0.1') || parsed.qdrantUrl?.includes('localhost')) {
            parsed.qdrantUrl = `http://${defaultHost}:6333`;
          }
        }
        return { ...INITIAL_CONFIG, ...parsed };
      } catch {
        return INITIAL_CONFIG;
      }
    }
    return INITIAL_CONFIG;
  });

  const [activeTab, setActiveTab] = useState<'chat' | 'models' | 'brief' | 'services' | 'config'>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem('k13_chat_history');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return [];
      }
    }
    return [];
  });

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [recordCount, setRecordCount] = useState<number>(0);
  const [dbState, setDbState] = useState<{ connected: boolean; count: number; error?: string }>({
    connected: true,
    count: 0
  });
  const [feedList, setFeedList] = useState<string[]>(['(All Feeds)']);
  const [groupList, setGroupList] = useState<string[]>(['(All Groups)']);

  // Client instance
  const client = useMemo(() => new K13Client(config), []);

  useEffect(() => {
    client.updateConfig(config);
    localStorage.setItem('k13_cluster_config', JSON.stringify(config));
  }, [config, client]);

  useEffect(() => {
    localStorage.setItem('k13_chat_history', JSON.stringify(messages));
  }, [messages]);

  // Fetch live .env values from Vite server middleware
  const fetchLiveEnv = useCallback(async () => {
    try {
      const res = await fetch('/api/env');
      if (res.ok) {
        const data = await res.json();
        if (data && data.env) {
          setConfig(prev => {
            const updates: Partial<ClusterConfig> = {
              liveEnv: data.env,
              envSource: data.source || '.env'
            };

            if (data.env.RAG_CONTEXT_TOKEN_BUDGET) {
              const b = parseInt(data.env.RAG_CONTEXT_TOKEN_BUDGET, 10);
              if (!isNaN(b) && b > 0) {
                updates.ragContextTokenBudget = b;
              }
            }

            if (data.env.TOP_K_MAX) {
              const k = parseInt(data.env.TOP_K_MAX, 10);
              if (!isNaN(k) && k > 0) {
                updates.topKMax = k;
              }
            }

            if (data.env.MAX_NEW_TOKENS) {
              const m = parseInt(data.env.MAX_NEW_TOKENS, 10);
              if (!isNaN(m) && m > 0) {
                updates.maxNewTokens = m;
              }
            }

            if (data.env.DEFAULT_MODEL) {
              updates.currentLlmModel = data.env.DEFAULT_MODEL;
            }

            if (data.env.EMBED_MODEL) {
              updates.currentEmbedModel = data.env.EMBED_MODEL;
            }

            if (data.env.SWITCH_ALLOW_CPU !== undefined) {
              updates.switchAllowCpu = data.env.SWITCH_ALLOW_CPU.toLowerCase() === 'on';
            }

            if (data.env.LLM_THINKING !== undefined) {
              updates.llmThinking = data.env.LLM_THINKING.toLowerCase() === 'on';
            }

            return { ...prev, ...updates };
          });
        }
      }
    } catch {
      // Ignore if offline
    }
  }, []);

  // Query real Qdrant count & facets + OpenVINO health
  const refreshClusterData = useCallback(async () => {
    // 0. Fetch live environment variables from .env
    await fetchLiveEnv();

    // 1. Fetch real Qdrant status & point count
    const status = await client.fetchCollectionStatus();
    setDbState(status);
    setRecordCount(status.count);

    // 2. Fetch real feed facets
    const feeds = await client.fetchFacets('feed');
    if (feeds.length > 0) {
      setFeedList(['(All Feeds)', ...feeds.sort()]);
    }

    // 3. Fetch real group facets
    const groups = await client.fetchFacets('group');
    if (groups.length > 0) {
      setGroupList(['(All Groups)', ...groups.sort()]);
    }

    // 4. Fetch live OpenVINO health
    const health = await client.fetchHealth();
    if (health.connected) {
      setConfig(prev => ({
        ...prev,
        llmHardware: health.llmHardware,
        embedHardware: health.embedHardware,
        currentLlmModel: health.currentModel || prev.currentLlmModel
      }));
    }
  }, [client, fetchLiveEnv]);

  useEffect(() => {
    refreshClusterData();
    const interval = setInterval(refreshClusterData, 30000);
    return () => clearInterval(interval);
  }, [refreshClusterData]);

  const [services, setServices] = useState(() => client.getServices());
  const [switchState, setSwitchState] = useState(client.getSwitchStatus());
  const [embedSwitchState, setEmbedSwitchState] = useState(client.getEmbedSwitchStatus());

  const handleUpdateConfig = (newConfig: Partial<ClusterConfig>) => {
    setConfig(prev => ({ ...prev, ...newConfig }));
  };

  const handleClearChat = () => {
    setMessages([]);
    localStorage.removeItem('k13_chat_history');
  };

  const handleReloadGpu = () => {
    handleUpdateConfig({ llmHardware: 'GPU' });
  };

  const handleSendMessage = async (userQuery: string) => {
    if (isGenerating) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userQuery,
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages(prev => [...prev, userMsg]);
    setIsGenerating(true);

    const assistantId = `assistant-${Date.now()}`;
    const initialAssistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages(prev => [...prev, initialAssistantMsg]);

    try {
      const finalMsg = await client.executeChatStream(
        userQuery,
        (partialText, thinking, stats) => {
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantId
                ? {
                    ...m,
                    content: partialText || (thinking ? '💭 *Thinking…*' : 'Searching Qdrant vectors…'),
                    stats: stats || m.stats
                  }
                : m
            )
          );
        }
      );

      setMessages(prev =>
        prev.map(m => (m.id === assistantId ? { ...finalMsg, id: assistantId } : m))
      );
    } catch (err: any) {
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                content: `⚠️ Error during execution: ${err.message || String(err)}`
              }
            : m
        )
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSwitchLlmModel = async (modelId: string) => {
    setSwitchState({ state: 'loading', model: modelId, stage: 'initiating' });
    const timer = setInterval(() => {
      setSwitchState({ ...client.getSwitchStatus() });
    }, 1500);

    try {
      const res = await client.switchLlmModel(modelId);
      if (res.success) {
        handleUpdateConfig({ currentLlmModel: modelId, llmHardware: client.getConfig().llmHardware });
        setSwitchState({ state: 'idle', model: modelId });
      } else {
        setSwitchState({ state: 'error', error: res.error, model: config.currentLlmModel });
      }
    } finally {
      clearInterval(timer);
    }
  };

  const handleSwitchEmbedModel = async (modelId: string) => {
    setEmbedSwitchState({ state: 'loading', model: modelId, stage: 'initiating' });
    const timer = setInterval(() => {
      setEmbedSwitchState({ ...client.getEmbedSwitchStatus() });
    }, 1500);

    try {
      const res = await client.switchEmbedModel(modelId);
      if (res.success) {
        handleUpdateConfig({ currentEmbedModel: modelId, embedHardware: client.getConfig().embedHardware });
        setEmbedSwitchState({ state: 'idle', model: modelId });
      } else {
        setEmbedSwitchState({ state: 'error', error: res.error, model: config.currentEmbedModel });
      }
    } finally {
      clearInterval(timer);
    }
  };

  const handleControlService = async (id: string, action: 'start' | 'stop' | 'restart') => {
    await client.controlService(id, action);
    setServices([...client.getServices()]);
  };

  const handleRunSmokeTest = async () => {
    return await client.runSmokeTest();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#030712] text-slate-100 font-sans">
      {/* Top Header */}
      <Header
        config={config}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onReloadGpu={handleReloadGpu}
      />

      {/* Main Workspace */}
      <main className="flex-1 flex flex-col overflow-hidden max-w-[1920px] w-full mx-auto">
        {activeTab === 'chat' && (
          <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
            {/* Sidebar Filters */}
            <SidebarFilters
              config={config}
              onUpdateConfig={handleUpdateConfig}
              feedList={feedList}
              groupList={groupList}
              onClearChat={handleClearChat}
              onOpenModelManager={() => setActiveTab('models')}
            />

            {/* Chat Workspace */}
            <div className="flex-1 flex flex-col overflow-hidden p-4 sm:p-6">
              <TelemetryCards
                config={config}
                articleCount={recordCount}
                dbConnected={dbState.connected}
                dbError={dbState.error}
              />
              <ChatView
                messages={messages}
                onSendMessage={handleSendMessage}
                isGenerating={isGenerating}
                activeCollection={config.activeCollection}
              />
            </div>
          </div>
        )}

        {activeTab === 'models' && (
          <ModelManagerView
            config={config}
            onSwitchLlmModel={handleSwitchLlmModel}
            onSwitchEmbedModel={handleSwitchEmbedModel}
            onReloadGpu={handleReloadGpu}
            onUpdateConfig={handleUpdateConfig}
            switchState={switchState}
            embedSwitchState={embedSwitchState}
          />
        )}

        {activeTab === 'brief' && (
          <DailyBriefView client={client} availableFeeds={feedList} />
        )}

        {activeTab === 'services' && (
          <ServicesView
            services={services}
            onControlService={handleControlService}
            onRunSmokeTest={handleRunSmokeTest}
          />
        )}

        {activeTab === 'config' && (
          <ConfigView config={config} onUpdateConfig={handleUpdateConfig} />
        )}
      </main>
    </div>
  );
};
