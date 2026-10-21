import {
  ClusterConfig,
  SourceItem,
  ChatMessage,
  QueryStats,
  SystemService
} from '../types';
import { INITIAL_ARTICLES, INITIAL_SYSTEMD_SERVICES } from '../data/mockArticles';
import {
  buildContext,
  getContextStats,
  stripThinking,
  resolveTimeframe,
  CHARS_PER_TOKEN,
  cleanUrl
} from '../utils/ragUtils';

export class K13Client {
  private config: ClusterConfig;
  private articles: SourceItem[] = [...INITIAL_ARTICLES];
  private services: SystemService[] = [...INITIAL_SYSTEMD_SERVICES];
  private switchStatus: { state: 'idle' | 'loading' | 'error'; model?: string; error?: string } = { state: 'idle' };
  private embedSwitchStatus: { state: 'idle' | 'loading' | 'error'; model?: string; error?: string } = { state: 'idle' };

  constructor(config: ClusterConfig) {
    this.config = config;
  }

  public updateConfig(newConfig: Partial<ClusterConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  public getConfig(): ClusterConfig {
    return this.config;
  }

  public getArticles(): SourceItem[] {
    return this.articles;
  }

  public getServices(): SystemService[] {
    return this.services;
  }

  public getSwitchStatus() {
    return this.switchStatus;
  }

  public getEmbedSwitchStatus() {
    return this.embedSwitchStatus;
  }

  /**
   * Search knowledge base with exact URL lookup, keyword/vector matching, and faceted filters
   */
  public async searchArticles(
    query: string,
    keywords?: string
  ): Promise<{
    docs: string[];
    metas: SourceItem[];
    exactMatches: SourceItem[];
    filtersWereActive: boolean;
    fallbackTriggered: boolean;
  }> {
    const rawSearch = keywords && keywords.trim() ? keywords.trim() : query;
    const searchTerms = rawSearch.toLowerCase().split(/\s+/).filter(t => t.length > 2);

    // 1. Detect explicit URLs in the user query for exact matching
    const urlRegex = /https?:\/\/[^\s"'<>]+/g;
    const detectedUrls = query.match(urlRegex) || [];
    const exactMatches: SourceItem[] = [];

    for (const rawUrl of detectedUrls) {
      const clean = rawUrl.replace(/[/.,);]+$/, '');
      const match = this.articles.find(a => cleanUrl(a.url) === clean || a.url === clean);
      if (match && !exactMatches.some(e => e.id === match.id)) {
        exactMatches.push({ ...match, title: `[Exact URL] ${match.title}` });
      }
    }

    // 2. Resolve timeframe filter
    let customStartTs: number | undefined;
    let customEndTs: number | undefined;

    if (this.config.timeframeChoice === 'Custom range…') {
      if (this.config.customStartDate) {
        const startStr = `${this.config.customStartDate}T${this.config.customStartTime || '00:00'}:00`;
        customStartTs = Math.floor(new Date(startStr).getTime() / 1000);
      }
      if (this.config.customEndDate) {
        const endStr = `${this.config.customEndDate}T${this.config.customEndTime || '23:59'}:59`;
        customEndTs = Math.floor(new Date(endStr).getTime() / 1000);
      }
    }

    const { gte, lte } = resolveTimeframe(
      this.config.timeframeChoice,
      customStartTs,
      customEndTs
    );

    const hasFeedFilter = this.config.feedFilter && this.config.feedFilter !== '(All Feeds)';
    const hasGroupFilter = this.config.groupFilter && this.config.groupFilter !== '(All Groups)';
    const hasTimeFilter = gte !== null || lte !== null;
    const filtersWereActive = hasFeedFilter || hasGroupFilter || hasTimeFilter;

    // Filter articles
    const filterFn = (a: SourceItem) => {
      if (hasFeedFilter && a.feed !== this.config.feedFilter) return false;
      if (hasGroupFilter && a.group !== this.config.groupFilter) return false;
      if (a.published_at) {
        if (gte !== null && a.published_at < gte) return false;
        if (lte !== null && a.published_at > lte) return false;
      }
      return true;
    };

    let filtered = this.articles.filter(filterFn);
    let fallbackTriggered = false;

    // If active filters caused 0 results, retry without filters (matches app.py lines 997-1007)
    if (filtered.length === 0 && filtersWereActive && this.config.timeframeChoice !== 'Custom range…') {
      filtered = this.articles;
      fallbackTriggered = true;
    }

    // Rank by relevance score
    const scored = filtered.map(item => {
      let score = 0;
      const combinedText = `${item.title} ${item.feed} ${item.group || ''} ${item.text}`.toLowerCase();
      
      for (const term of searchTerms) {
        if (item.title.toLowerCase().includes(term)) score += 5;
        if (item.text.toLowerCase().includes(term)) score += 2;
        if (item.feed.toLowerCase().includes(term)) score += 3;
      }

      // Base vector score simulation
      score += Math.random() * 0.5 + 0.5;

      return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Limit to Top K
    const topResults = scored.slice(0, this.config.topK).map(s => s.item);

    // Prepend exact URL matches
    for (const em of exactMatches) {
      if (!topResults.some(r => r.id === em.id)) {
        topResults.unshift(em);
      }
    }

    const finalResults = topResults.slice(0, this.config.topK);
    const docs = finalResults.map(r => r.text);
    const metas = finalResults.map(r => ({ ...r }));

    return {
      docs,
      metas,
      exactMatches,
      filtersWereActive,
      fallbackTriggered
    };
  }

  /**
   * Execute chat query and stream response with token statistics
   */
  public async executeChatStream(
    userQuery: string,
    onChunk: (partial: string, thinking: boolean, stats?: QueryStats) => void
  ): Promise<ChatMessage> {
    const t0 = performance.now();

    // 1. Search vector records
    const tEmbed0 = performance.now();
    const searchRes = await this.searchArticles(userQuery, this.config.searchKeywords);
    const tEmbed1 = performance.now();
    const tSearchEnd = performance.now();

    const { docs, metas } = searchRes;
    const { contextText, usedCount, charsPerExcerpt } = buildContext(
      docs,
      metas,
      this.config.ragContextTokenBudget
    );
    const ctxStats = getContextStats(docs, usedCount, charsPerExcerpt, this.config.ragContextTokenBudget);

    // 2. Select system persona prompt
    let systemPrompt = '';
    switch (this.config.persona) {
      case 'Executive Intelligence Brief':
        systemPrompt =
          'You are an executive intelligence briefing officer. Provide an executive summary with key strategic takeaways, high-level bullets, and risk implications strictly using the provided context. Whenever you cite a source, include its URL as a Markdown link.';
        break;
      case 'Technical Deep Dive':
        systemPrompt =
          'You are a principal technical analyst. Deeply examine the architectural, technical, and factual details strictly using the provided context. Reference source titles and include their URLs as Markdown links where applicable.';
        break;
      case 'Analytical Unbiased':
        systemPrompt =
          'You are a rigorous, analytically-driven researcher with no political, ideological, or editorial bias. Your sole objective is to evaluate the provided source excerpts with intellectual honesty and methodical precision. Follow these principles strictly:\n1. BASE EVERY CLAIM on direct evidence from the retrieved context. Never introduce assumptions, prior beliefs, or information outside the provided excerpts.\n2. PRESENT MULTIPLE PERSPECTIVES where the sources contain differing or conflicting accounts. Do not favour one narrative over another without evidentiary justification.\n3. IDENTIFY GAPS AND CONFLICTS explicitly. If sources contradict each other or if insufficient data exists to answer the question, state this clearly and neutrally.\n4. SEPARATE FACTS FROM INTERPRETATION. Clearly distinguish between what the sources report as fact and what is editorial opinion, speculation, or projection.\n5. USE NEUTRAL, PRECISE LANGUAGE. Avoid emotive, sensational, or loaded phrasing. Quantify claims where possible (dates, figures, percentages).\n6. CITE YOUR SOURCES by referencing the source title and feed for every key claim, and include the URL as a Markdown link.\nIf the retrieved context does not contain sufficient information to answer the question, state this directly rather than speculating.';
        break;
      default:
        systemPrompt =
          'You are an objective news research analyst. Answer the query using ONLY the provided source context. If the excerpts do not contain the answer, explicitly state that the database lacks sufficient reporting on the topic. Reference source titles and include their URLs as Markdown links where applicable.';
        break;
    }

    // 3. Synthesize intelligent response grounded on context
    const fullTextAnswer = this.generateResponseContent(userQuery, metas, this.config.persona);

    // If model includes thinking (Qwen3 / DeepSeek)
    let generatedStream = fullTextAnswer;
    if (this.config.currentLlmModel.includes('Qwen3') || this.config.llmThinking) {
      const reasoning = `<think>\nAnalyzing retrieved vector excerpts (${usedCount} sources from ${this.config.activeCollection}).\nExamining timeline, cross-referencing published figures, verifying URLs against indexed payload.\nApplying ${this.config.persona} constraints.\n</think>\n\n`;
      generatedStream = reasoning + fullTextAnswer;
    }

    // 4. Stream simulation with real tokens/sec
    const tGen0 = performance.now();
    let emitted = '';
    const words = generatedStream.split(' ');
    let firstTokenTime: number | null = null;

    for (let i = 0; i < words.length; i++) {
      if (firstTokenTime === null) {
        firstTokenTime = performance.now();
      }
      emitted += (i === 0 ? '' : ' ') + words[i];
      const { visibleText, thinking } = stripThinking(emitted, true);
      onChunk(visibleText, thinking);
      // Fast realistic typing delay (12-25ms)
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 12) + 12));
    }

    const tEnd = performance.now();
    const genSeconds = Math.max((tEnd - tGen0) / 1000, 0.05);
    const ttftSeconds = firstTokenTime ? (firstTokenTime - tGen0) / 1000 : 0.12;
    const outTokens = Math.max(Math.floor(emitted.length / CHARS_PER_TOKEN), 1);
    const inTokens = Math.floor((systemPrompt.length + contextText.length + userQuery.length) / CHARS_PER_TOKEN);
    const tps = outTokens / genSeconds;

    const { visibleText, rawThinking } = stripThinking(emitted, false);

    const stats: QueryStats = {
      model: this.config.currentLlmModel,
      gen: {
        tps,
        out_tokens: outTokens,
        in_tokens: inTokens,
        ttft_s: ttftSeconds,
        exact: true,
        device: `Intel ${this.config.llmHardware}`,
        stop: 'stop_token',
        thinking_chars: rawThinking.length
      },
      retrieval: {
        ...ctxStats,
        top_k: this.config.topK
      },
      timing: {
        embed_s: Math.max((tEmbed1 - tEmbed0) / 1000, 0.02),
        search_s: Math.max((tSearchEnd - tEmbed1) / 1000, 0.03),
        gen_s: genSeconds,
        total_s: (tEnd - t0) / 1000
      }
    };

    onChunk(visibleText, false, stats);

    return {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: visibleText,
      sources: metas,
      query: userQuery,
      stats,
      timestamp: new Date().toLocaleTimeString(),
      thinking: rawThinking
    };
  }

  /**
   * Generates grounded factual response based on real query and retrieved sources
   */
  private generateResponseContent(query: string, sources: SourceItem[], persona: string): string {
    const qLower = query.toLowerCase();

    if (sources.length === 0) {
      return `⚠️ **No matching context retrieved** from collection \`${this.config.activeCollection}\`. The database lacks sufficient reporting to answer your query directly. Try broadening your timeframe or clearing the feed filters.`;
    }

    // Gas prices query
    if (qLower.includes('gas') || qLower.includes('fuel') || qLower.includes('oil') || qLower.includes('crude')) {
      return `Based on the latest reports in the vector repository:

1. **Midwest Price Dynamics**: Retail gasoline across Minnesota and Wisconsin rose by approximately 8 cents per gallon to an average of **$3.24/gal**. This increase followed scheduled maintenance turnaround along the upper Mississippi refinery corridor, where runs dipped 2.4% according to EIA data ([EIA Midwest Weekly](${cleanUrl(sources[0]?.url || '')})).
2. **Crude Benchmark Pressures**: Global crude benchmarks strengthened, with Brent reaching **$82.40/barrel** driven by maritime security rerouting around the Cape of Good Hope and a 14% increase in Persian Gulf-to-Rotterdam charter rates ([Reuters Energy](${cleanUrl(sources[1]?.url || '')})).
3. **State Tax Adjustment**: The Minnesota Department of Revenue's scheduled 0.9¢/gallon statutory fuel tax indexation took effect Tuesday, with Twin Cities metro pump prices holding steady at **$3.19/gal** as distributors absorbed initial adjustments ([Star Tribune](${cleanUrl(sources[2]?.url || '')})).
4. **Refining Spreads**: Atlantic Basin crack spreads softened to **$19.50/bbl** due to moderate European industrial diesel demand, even as finished motor gasoline consumption held firm at 9.1 million barrels per day ([Bloomberg Distillates](${cleanUrl(sources[3]?.url || '')})).

**Synopsis**: Supply-side refinery maintenance and international shipping logistics continue to exert modest upward pressure on spot wholesale fuel prices, though retail pump prices in the Upper Midwest remain comparatively cushioned.`;
    }

    // Minnesota Politics query
    if (qLower.includes('minnesota') || qLower.includes('politics') || qLower.includes('budget') || qLower.includes('bonding')) {
      return `Based on state legislative reporting:

1. **Capital Investment Bonding**: The Minnesota House Capital Investment Committee is deliberating a **$1.2 billion public works bonding package** focused on municipal wastewater improvements, college campus asset preservation, and bridge renewals. Passage requires a three-fifths bipartisan supermajority ([Session Daily](${cleanUrl(sources[0]?.url || '')})).
2. **Clean Energy Grid Reform**: Governor Walz signed Chapter 64 reforming Public Utilities Commission certificate-of-need timelines for high-voltage transmission lines and utility-scale battery storage. Typical permitting cycles are reduced from 27 down to 14 months to support the state's 2040 carbon-free electricity mandate ([Minnesota Reformer](${cleanUrl(sources[1]?.url || '')})).
3. **Budget Outlook**: Minnesota Management and Budget projects a stable **$3.71 billion general fund balance** through the biennium, bolstered by strong corporate tax revenues and lower-than-anticipated social safety net caseloads ([Star Tribune](${cleanUrl(sources[2]?.url || '')})).

**Assessment**: The state legislature is prioritizing energy infrastructure regulatory speed and infrastructure maintenance while navigating competing demands for budget reserve preservation versus tax relief.`;
    }

    // Cybersecurity query
    if (qLower.includes('cyber') || qLower.includes('cve') || qLower.includes('attack') || qLower.includes('ransomware') || qLower.includes('ssh')) {
      return `According to cybersecurity disclosures from The Hacker News and advisory bulletins:

1. **Critical SSH Proxy Vulnerability (CVE-2025-2418)**: A CVSS **9.8 critical authentication bypass** was discovered in PAM authentication routines of open-source SSH gateways. Attackers can trigger remote code execution or bypass credentials using crafted ANSI control escape sequences. Immediate upgrading to v4.9.2 is urged ([The Hacker News](${cleanUrl(sources[0]?.url || '')})).
2. **Edge Router Exploitation**: CISA added two active zero-day exploit chains targeting dual-WAN VPN hardware to the Known Exploited Vulnerabilities catalog. The Akira ransomware affiliate has weaponized memory corruption flaws to establish unmonitored foothold in municipal and healthcare networks ([The Hacker News](${cleanUrl(sources[1]?.url || '')})).
3. **Post-Quantum Migration Mandate**: CISA released actionable deployment checklists for NIST FIPS 203 (ML-KEM) and FIPS 204 (ML-DSA) encryption, directing critical infrastructure operators to inventory legacy RSA-2048 keys before Q3 2026 ([CISA Quantum Readiness](${cleanUrl(sources[2]?.url || '')})).

**Risk Takeaway**: Enterprise perimeters face immediate threats from edge appliance vulnerabilities and credential gateway flaws, requiring rapid firmware patching alongside strategic planning for post-quantum cryptographic standards.`;
    }

    // SpaceX / Aerospace Tech query
    if (qLower.includes('space') || qLower.includes('spacex') || qLower.includes('starship') || qLower.includes('musk') || qLower.includes('starlink')) {
      return `Based on verified aerospace reporting:

1. **Starship Flight 8 Milestone**: SpaceX launched Starship Flight 8 from Starbase Boca Chica, completing the first in-orbit cryogenic propellant transfer between header tanks in microgravity. Elon Musk confirmed the Super Heavy booster accomplished its tower catch maneuver with zero grid-fin thermal degradation, clearing key milestones for Artemis III lunar lander refueling ([TechCrunch](${cleanUrl(sources[0]?.url || '')})).
2. **Direct-to-Cell Expansion**: Falcon 9 deployed 23 additional direct-to-cell Starlink satellites from Cape Canaveral, bringing the orbital constellation to over 3,000 mobile-capable spacecraft. Commercial emergency texting partnerships are now operational across multiple international carriers ([Spaceflight Now](${cleanUrl(sources[1]?.url || '')})).

**Technical Outlook**: Rapid validation of in-orbit fluid dynamics and booster reusability reinforces SpaceX's flight cadence towards orbital refueling and deep-space missions.`;
    }

    // Default synthesis
    const s1 = sources[0];
    const s2 = sources[1];
    return `### Intelligence Summary on "${query}"

Based on ${sources.length} retrieved vector excerpts from \`${this.config.activeCollection}\`:

- **Primary Finding**: According to reporting from **${s1.feed}**, "${s1.title}", key developments highlight that: ${s1.text.slice(0, 160)}… ([Read Source](${cleanUrl(s1.url)})).
${s2 ? `- **Supporting Context**: Additional coverage from **${s2.feed}** ("${s2.title}") confirms that: ${s2.text.slice(0, 150)}… ([Read Source](${cleanUrl(s2.url)})).` : ''}

**Analytical Note**: This brief was synthesized using strictly the retrieved excerpts under the **${persona}** framework. No external or unverified assertions were incorporated.`;
  }

  /**
   * Switch LLM model with memory ceiling validation (~6.8GB GPU limit)
   */
  public async switchLlmModel(targetModelId: string): Promise<{ success: boolean; error?: string }> {
    this.switchStatus = { state: 'loading', model: targetModelId };

    // Check GPU memory cap if heavy model
    const isHeavy = targetModelId.includes('12b') || targetModelId.includes('14b');
    if (isHeavy && !this.config.switchAllowCpu) {
      await new Promise(r => setTimeout(r, 1200));
      this.switchStatus = {
        state: 'error',
        model: this.config.currentLlmModel,
        error: `Model ${targetModelId} exceeds 6.8 GB GPU VRAM limit on Lunar Lake. Rolled back to ${this.config.currentLlmModel}. (Set SWITCH_ALLOW_CPU=on to allow CPU fallback)`
      };
      return { success: false, error: this.switchStatus.error };
    }

    // Simulate model download and OpenVINO compilation
    await new Promise(r => setTimeout(r, 1800));
    this.config.currentLlmModel = targetModelId;
    this.switchStatus = { state: 'idle', model: targetModelId };
    return { success: true };
  }

  /**
   * Switch Embedding model with dimension checking
   */
  public async switchEmbedModel(targetModelId: string): Promise<{ success: boolean; error?: string }> {
    this.embedSwitchStatus = { state: 'loading', model: targetModelId };
    await new Promise(r => setTimeout(r, 1500));
    this.config.currentEmbedModel = targetModelId;
    this.embedSwitchStatus = { state: 'idle', model: targetModelId };
    return { success: true };
  }

  /**
   * Control systemd services (k13ctl.sh)
   */
  public async controlService(serviceId: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    const idx = this.services.findIndex(s => s.id === serviceId);
    if (idx !== -1) {
      if (action === 'restart') {
        this.services[idx].status = 'restarting';
        await new Promise(r => setTimeout(r, 800));
        this.services[idx].status = 'active';
        this.services[idx].uptime = 'Just now';
      } else if (action === 'stop') {
        this.services[idx].status = 'inactive';
      } else if (action === 'start') {
        this.services[idx].status = 'active';
        this.services[idx].uptime = 'Just now';
      }
    }
  }

  /**
   * Run smoke test (k13ctl.sh test)
   */
  public async runSmokeTest(): Promise<{
    embedSuccess: boolean;
    embedDims: number;
    chatSuccess: boolean;
    chatResponse: string;
  }> {
    await new Promise(r => setTimeout(r, 1000));
    const dims = this.config.currentEmbedModel.includes('small') ? 384 : 768;
    return {
      embedSuccess: true,
      embedDims: dims,
      chatSuccess: true,
      chatResponse: 'ready (OpenVINO INT4 on Intel GPU runtime)'
    };
  }
}
