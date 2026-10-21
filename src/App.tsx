import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { TelemetryCards } from './components/TelemetryCards';
import { SidebarFilters } from './components/SidebarFilters';
import { ChatView } from './components/ChatView';
import { ModelManagerView } from './components/ModelManagerView';
import { DailyBriefView } from './components/DailyBriefView';
import { ServicesView } from './components/ServicesView';
import { ConfigView } from './components/ConfigView';
import { ClusterConfig, ChatMessage, SourceItem } from './types';
import { K13Client } from './services/k13Client';

const INITIAL_CONFIG: ClusterConfig = {
  connectionMode: 'simulated',
  inferenceUrl: 'http://127.0.0.1:11434',
  qdrantUrl: 'http://127.0.0.1:6333',
  activeCollection: 'rss_articles',
  activeDbEngine: 'Qdrant (Local)',
  currentLlmModel: 'OpenVINO/Phi-3.5-mini-instruct-int4-ov',
  currentEmbedModel: 'BAAI/bge-base-en-v1.5',
  llmHardware: 'GPU',
  embedHardware: 'NPU',
  topK: 6,
  ragContextTokenBudget: 8000,
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
        return { ...INITIAL_CONFIG, ...JSON.parse(saved) };
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

  // Initialize client
  const client = useMemo(() => new K13Client(config), []);

  useEffect(() => {
    client.updateConfig(config);
    localStorage.setItem('k13_cluster_config', JSON.stringify(config));
  }, [config, client]);

  useEffect(() => {
    localStorage.setItem('k13_chat_history', JSON.stringify(messages));
  }, [messages]);

  const [articles, setArticles] = useState<SourceItem[]>(() => client.getArticles());
  const [services, setServices] = useState(() => client.getServices());
  const [switchState, setSwitchState] = useState(client.getSwitchStatus());
  const [embedSwitchState, setEmbedSwitchState] = useState(client.getEmbedSwitchStatus());

  // Extract distinct feeds & groups
  const feedList = useMemo(() => {
    const set = new Set<string>(['(All Feeds)']);
    articles.forEach(a => a.feed && set.add(a.feed));
    return Array.from(set);
  }, [articles]);

  const groupList = useMemo(() => {
    const set = new Set<string>(['(All Groups)']);
    articles.forEach(a => a.group && set.add(a.group));
    return Array.from(set);
  }, [articles]);

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
    // Temporary placeholder message
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
                    content: partialText || (thinking ? '💭 *Thinking…*' : 'Generating…'),
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
    } catch (err) {
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                content: `⚠️ Error during OpenVINO execution: ${String(err)}`
              }
            : m
        )
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSwitchLlmModel = async (modelId: string) => {
    setSwitchState({ state: 'loading', model: modelId });
    const res = await client.switchLlmModel(modelId);
    if (res.success) {
      handleUpdateConfig({ currentLlmModel: modelId, llmHardware: 'GPU' });
      setSwitchState({ state: 'idle', model: modelId });
    } else {
      setSwitchState({ state: 'error', error: res.error, model: config.currentLlmModel });
    }
  };

  const handleSwitchEmbedModel = async (modelId: string) => {
    setEmbedSwitchState({ state: 'loading', model: modelId });
    const res = await client.switchEmbedModel(modelId);
    if (res.success) {
      handleUpdateConfig({ currentEmbedModel: modelId });
      setEmbedSwitchState({ state: 'idle', model: modelId });
    } else {
      setEmbedSwitchState({ state: 'error', error: res.error, model: config.currentEmbedModel });
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
              <TelemetryCards config={config} articleCount={articles.length} />
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
          <DailyBriefView articles={articles} availableFeeds={feedList} />
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
