# K13 AI Hub - React & Vite Edition (Intel OpenVINO RAG Platform)

A full-featured React application rewriting the Streamlit portal and Python utilities of K13 AI Hub. The application provides neural vector search, grounded RAG chat, live model switching across Intel GPU and NPU accelerators, automated daily news briefings, and systemd cluster control (`k13ctl`).

```
 browser ──► K13 React Portal (:3000) ──┬──► OpenVINO Server (:11434)  [LLM on GPU + BGE on NPU]
                                       └──► Qdrant Vector DB (:6333)  [768-dim Cosine Index]
```

## Features Ported

1. **Neural Vector RAG & Intelligence Chat**:
   - Hybrid vector + exact URL lookup retrieval.
   - Grounded citations with direct article hyperlinks.
   - Persona prompts: Objective News Analyst, Executive Intelligence Brief, Technical Deep Dive, and Analytical Unbiased (6-principle framework).
   - Timeframe filter (All Time, 24 Hours, 7 Days, 30 Days, Custom range with timezone selection and date-time pickers).
   - Feed and Group facet filtering.
   - Real-time token streaming with `<think>...</think>` reasoning striping.
   - Comprehensive Query Statistics: Tokens/s, Output tokens, Prompt tokens, Time to 1st token (TTFT), Timing breakdown, and Retrieval & Truncation report.
   - Self-contained standalone HTML report export (`answer_to_html`).

2. **Intel Hardware & Model Engine Switcher**:
   - Intel GPU (`/dev/dri`): INT4 chat models with ~6.8 GB VRAM cap enforcement and CPU rollback handling.
   - Intel NPU (`/dev/accel/accel0`): BGE Base (768 dims) and BGE Small (384 dims) models.
   - Force reload on GPU action for CPU fallbacks.
   - Custom Hugging Face repo loader.

3. **Daily Briefing Generator (`brief/brief.py`)**:
   - Generates 4 numbered summaries [1]-[4], synopsis, and verified real source citations from 24-hour news feeds.
   - Formats: Markdown (with `[[n]](url)` hyperlinks) and Facebook post text.
   - Export to `.md` or `.txt`, clipboard copy, and scheduled publication simulator.

4. **Systemd Services & Cluster Control (`k13ctl.sh`)**:
   - Service health monitoring: `k13-openvino.service`, `k13-qdrant.service`, `k13-web.service`, `k13-rss-sync.timer`.
   - Actions: Start, Stop, Restart, Status.
   - Smoke test execution (`k13ctl.sh test`) checking embedding dimensions and chat response.
   - Live systemd journalctl log viewer.

5. **Configuration Inspector (`.env`)**:
   - Environment parameters viewer, platform architecture guidelines, and cluster mode switcher (Simulated Intel Cluster vs Live Local Endpoints).

## Development

```bash
# Install dependencies
npm install

# Start Vite dev server on port 3000
npm run dev

# Build production bundle
npm run build
```
