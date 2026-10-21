import { LLMModelInfo, EmbedModelInfo, SystemService } from '../types';

export const CURATED_LLM_MODELS: LLMModelInfo[] = [
  {
    id: 'OpenVINO/Phi-3.5-mini-instruct-int4-ov',
    name: 'Phi-3.5 Mini',
    params: '3.8B',
    size: '~2.2 GB',
    description: 'Ultra-fast INT4 default model on Intel GPU. Excellent latency and minimal memory footprint.',
    default: true,
    contextWindow: '8k'
  },
  {
    id: 'OpenVINO/Phi-4-mini-instruct-int4-ov',
    name: 'Phi-4 Mini ⭐',
    params: '3.8B',
    size: '~2.5 GB',
    description: 'State-of-the-art reasoning and factual recall. Highly recommended for daily news briefs.',
    recommended: true,
    contextWindow: '16k'
  },
  {
    id: 'OpenVINO/Qwen3-4B-int4-ov',
    name: 'Qwen3 4B',
    params: '4B',
    size: '~2.8 GB',
    description: 'High performance coding & reasoning model with native tool-use and thinking tokens.',
    contextWindow: '32k'
  },
  {
    id: 'OpenVINO/Llama-3.2-3B-Instruct-int4-ov',
    name: 'Llama 3.2 3B',
    params: '3B',
    size: '~2.0 GB',
    description: 'Meta compact instruction model. Extremely reliable and factual, fast TTFT.',
    contextWindow: '128k'
  },
  {
    id: 'OpenVINO/gemma-3-4B-it-int4-ov',
    name: 'Gemma 3 4B',
    params: '4B',
    size: '~2.5 GB',
    description: 'Google multimodal & reasoning model fine-tuned for high precision instruction following.',
    contextWindow: '32k'
  },
  {
    id: 'OpenVINO/Qwen2.5-7B-Instruct-int4-ov',
    name: 'Qwen2.5 7B Instruct ⭐',
    params: '7B',
    size: '~4.3 GB',
    description: 'Best for news summaries & long-form RAG. Small KV cache allows extensive token contexts.',
    recommended: true,
    contextWindow: '128k'
  },
  {
    id: 'OpenVINO/Mistral-7B-Instruct-v0.3-int4-ov',
    name: 'Mistral 7B v0.3',
    params: '7B',
    size: '~4.2 GB',
    description: 'Crisp, concise writing, neutral journalistic tone, 32k context window.',
    contextWindow: '32k'
  },
  {
    id: 'OpenVINO/Llama-3.1-8B-Instruct-int4-ov',
    name: 'Llama 3.1 8B Instruct',
    params: '8B',
    size: '~4.8 GB',
    description: 'Comprehensive 8B general reasoning model with full 128k context support.',
    contextWindow: '128k'
  },
  {
    id: 'OpenVINO/Qwen3-8B-int4-ov',
    name: 'Qwen3 8B 🔥',
    params: '8B',
    size: '~5.5 GB',
    description: 'Top quality intelligence on Lunar Lake GPU runtime. Fits within ~6.8GB VRAM cap.',
    recommended: true,
    contextWindow: '32k'
  },
  {
    id: 'OpenVINO/gemma-3-12b-it-int4-ov',
    name: 'Gemma 3 12B',
    params: '12B',
    size: '~7.5 GB',
    description: 'Heavy 12B model. Requires >8 GB GPU memory (may trigger CPU fallback if VRAM overflows).',
    heavy: true,
    contextWindow: '32k'
  },
  {
    id: 'OpenVINO/Qwen3-14B-int4-ov',
    name: 'Qwen3 14B',
    params: '14B',
    size: '~8.5 GB',
    description: 'Large parameter model. Requires >9 GB GPU memory; rolls back if memory check fails.',
    heavy: true,
    contextWindow: '32k'
  }
];

export const CURATED_EMBED_MODELS: EmbedModelInfo[] = [
  {
    id: 'BAAI/bge-base-en-v1.5',
    name: 'BGE Base ⭐',
    dims: 768,
    size: '~430 MB',
    description: 'Standard 768-dim embeddings running natively on Intel NPU (/dev/accel/accel0). Default collection format.',
    device: 'NPU (Intel Lunar Lake / Meteor Lake)',
    default: true,
    recommended: true
  },
  {
    id: 'BAAI/bge-small-en-v1.5',
    name: 'BGE Small',
    dims: 384,
    size: '~90 MB',
    description: 'Ultra-fast 384-dim embeddings. Warning: Switching requires re-indexing Qdrant collections.',
    device: 'NPU (Static shape 1x512)',
    recommended: false
  }
];

export const DEFAULT_SYSTEMD_SERVICES: SystemService[] = [
  {
    id: 'openvino',
    name: 'OpenVINO Inference Server',
    unit: 'k13-openvino.service',
    role: 'FastAPI server hosting openvino_genai LLM on GPU and BGE embeddings on NPU',
    port: 11434,
    status: 'active',
    enabled: true,
    uptime: 'Running on :11434',
    memory: 'GPU VRAM / System RAM',
    hardware: 'Intel GPU (/dev/dri) & Intel NPU (/dev/accel/accel0)'
  },
  {
    id: 'qdrant',
    name: 'Qdrant Vector Database',
    unit: 'k13-qdrant.service',
    role: 'Native vector database serving 768-dim cosine index for news and audio collections',
    port: 6333,
    status: 'active',
    enabled: true,
    uptime: 'Running on :6333',
    memory: 'Vector Index',
    hardware: 'Intel CPU'
  },
  {
    id: 'web',
    name: 'K13 Web Portal',
    unit: 'k13-web.service',
    role: 'React web interface for vector intelligence, chat, telemetry & model switching',
    port: 3000,
    status: 'active',
    enabled: true,
    uptime: 'Running on :3000',
    memory: 'Node.js Runtime',
    hardware: 'Web Server'
  },
  {
    id: 'rss',
    name: 'FreshRSS Vector Synchronizer',
    unit: 'k13-rss-sync.timer',
    role: 'Scheduled timer running every 5 min (FreshRSS NAS -> PostgreSQL -> NPU BGE -> Qdrant)',
    port: 'Every 5m',
    status: 'active',
    enabled: true,
    uptime: 'Active Timer',
    memory: 'NPU Embeddings',
    hardware: 'Intel NPU'
  }
];
