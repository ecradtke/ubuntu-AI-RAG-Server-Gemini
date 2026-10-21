export type DBEngine = 'Qdrant (Local)' | 'ChromaDB (Local File)';

export type PersonaType =
  | 'Objective News Analyst'
  | 'Executive Intelligence Brief'
  | 'Technical Deep Dive'
  | 'Analytical Unbiased';

export type TimeframeChoice =
  | 'All Time'
  | 'Past 24 Hours'
  | 'Past 7 Days'
  | 'Past 30 Days'
  | 'Custom range…';

export interface SourceItem {
  id?: string;
  title: string;
  url: string;
  date: string;
  feed: string;
  group?: string;
  text: string;
  published_at?: number;
  score?: number;
}

export interface GenStats {
  tps: number;
  out_tokens: number;
  in_tokens: number;
  ttft_s: number;
  exact: boolean;
  device: string;
  stop: string;
  thinking_chars: number;
}

export interface RetrievalStats {
  top_k: number;
  retrieved: number;
  used: number;
  dropped: number;
  cut_to_cap: number;
  cut_for_budget: number;
  excerpt_chars: number | string;
  budget_tokens: number;
}

export interface TimingStats {
  embed_s: number;
  search_s: number;
  gen_s: number;
  total_s: number;
}

export interface QueryStats {
  model: string;
  gen: GenStats;
  retrieval: RetrievalStats;
  timing: TimingStats;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources?: SourceItem[];
  query?: string;
  stats?: QueryStats;
  timestamp: string;
  thinking?: string;
}

export interface LLMModelInfo {
  id: string;
  name: string;
  params: string;
  size: string;
  description: string;
  recommended?: boolean;
  default?: boolean;
  contextWindow?: string;
  heavy?: boolean;
}

export interface EmbedModelInfo {
  id: string;
  name: string;
  dims: number;
  size: string;
  description: string;
  recommended?: boolean;
  default?: boolean;
  device: string;
}

export interface SystemService {
  id: string;
  name: string;
  unit: string;
  role: string;
  port?: string | number;
  status: 'active' | 'inactive' | 'failed' | 'restarting';
  enabled: boolean;
  uptime: string;
  memory: string;
  hardware: string;
}

export interface ClusterConfig {
  connectionMode: 'simulated' | 'live';
  inferenceUrl: string;
  qdrantUrl: string;
  activeCollection: string;
  activeDbEngine: DBEngine;
  currentLlmModel: string;
  currentEmbedModel: string;
  llmHardware: 'GPU' | 'CPU';
  embedHardware: 'NPU' | 'CPU';
  topK: number;
  ragContextTokenBudget: number;
  persona: PersonaType;
  feedFilter: string;
  groupFilter: string;
  timeframeChoice: TimeframeChoice;
  customStartDate?: string;
  customStartTime?: string;
  customEndDate?: string;
  customEndTime?: string;
  timeZone: string;
  searchKeywords: string;
  llmThinking: boolean;
  switchAllowCpu: boolean;
}
