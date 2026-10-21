import { SourceItem, QueryStats, TimeframeChoice } from '../types';

export const EXCERPT_MAX_CHARS = 300;
export const CHARS_PER_TOKEN = 3.5;
export const TOKENS_PER_EXCERPT = 145;

/**
 * Extract clean target URL from Google redirect wrapper or return original
 */
export function cleanUrl(rawUrl: string): string {
  if (!rawUrl || rawUrl === 'N/A') return rawUrl;
  if (rawUrl.includes('google.com/url')) {
    try {
      const urlObj = new URL(rawUrl);
      const target = urlObj.searchParams.get('url');
      if (target) return target;
    } catch {
      // return as-is
    }
  }
  return rawUrl;
}

/**
 * Trim excerpt with clean sentence termination
 */
export function trimExcerpt(text: string, limit: number = EXCERPT_MAX_CHARS): string {
  if (text.length <= limit) return text;
  const trimmed = text.slice(0, limit);
  const lastPeriod = trimmed.lastIndexOf('. ');
  if (lastPeriod > limit * 0.6) {
    return trimmed.slice(0, lastPeriod + 1);
  }
  return trimmed.trimEnd() + '…';
}

/**
 * Join retrieved excerpts into one context string that fits the token budget.
 */
export function buildContext(
  docs: string[],
  metas: SourceItem[],
  budgetTokens: number = 8000
): { contextText: string; usedCount: number; charsPerExcerpt: number; wasTrimmed: boolean } {
  const budgetChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  const sep = '\n\n---\n\n';
  const heads = metas.map((m, i) => {
    const title = m.title || `Doc ${i + 1}`;
    const feed = m.feed ? ` - ${m.feed}` : '';
    const clean = cleanUrl(m.url || 'N/A');
    return `Source [${title}${feed}] (URL: ${clean}): `;
  });

  const render = (count: number, limit: number) => {
    return Array.from({ length: count })
      .map((_, i) => heads[i] + trimExcerpt(docs[i], limit))
      .join(sep);
  };

  const n = docs.length;
  if (n === 0) {
    return { contextText: '', usedCount: 0, charsPerExcerpt: EXCERPT_MAX_CHARS, wasTrimmed: false };
  }

  for (const limit of [EXCERPT_MAX_CHARS, 240, 190, 150, 120, 100]) {
    const text = render(n, limit);
    if (text.length <= budgetChars) {
      return {
        contextText: text,
        usedCount: n,
        charsPerExcerpt: limit,
        wasTrimmed: limit < EXCERPT_MAX_CHARS
      };
    }
  }

  // If still too long at 100 chars, drop from the end
  let count = n;
  while (count > 1 && render(count, 100).length > budgetChars) {
    count -= 1;
  }

  return {
    contextText: render(count, 100),
    usedCount: count,
    charsPerExcerpt: 100,
    wasTrimmed: true
  };
}

/**
 * Calculate retrieval statistics
 */
export function getContextStats(
  docs: string[],
  used: number,
  limit: number,
  budgetTokens: number = 8000
) {
  const usedDocs = docs.slice(0, used);
  return {
    retrieved: docs.length,
    used,
    dropped: docs.length - used,
    cut_to_cap: usedDocs.filter(d => d.length > EXCERPT_MAX_CHARS).length,
    cut_for_budget: limit < EXCERPT_MAX_CHARS ? usedDocs.filter(d => d.length > limit).length : 0,
    excerpt_chars: limit,
    budget_tokens: budgetTokens
  };
}

/**
 * Remove reasoning blocks (<think>...</think>) from model output
 */
export function stripThinking(
  text: string,
  streaming: boolean = false
): { visibleText: string; thinking: boolean; rawThinking: string } {
  let cleaned = text;
  let rawThinking = '';

  const thinkClose = '</think>';
  const thinkOpen = '<think>';

  // Capture finished thinking blocks
  const blockMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (blockMatch) {
    rawThinking = blockMatch[1].trim();
    cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  }

  // If tag started before text
  if (cleaned.toLowerCase().includes(thinkClose) && !cleaned.toLowerCase().split(thinkClose)[0].includes(thinkOpen)) {
    const parts = cleaned.split(new RegExp(thinkClose, 'i'));
    cleaned = parts[1] || '';
  }

  let thinking = false;
  const lower = cleaned.toLowerCase();
  const idx = lower.lastIndexOf(thinkOpen);

  if (idx !== -1) {
    rawThinking = (rawThinking ? rawThinking + '\n' : '') + cleaned.slice(idx + thinkOpen.length);
    cleaned = cleaned.slice(0, idx);
    thinking = true;
  } else if (streaming) {
    for (let n = thinkOpen.length - 1; n > 0; n--) {
      if (lower.endsWith(thinkOpen.slice(0, n))) {
        cleaned = cleaned.slice(0, -n);
        break;
      }
    }
  }

  return { visibleText: cleaned.trimStart(), thinking, rawThinking };
}

/**
 * Calculate timeframe filter ranges
 */
export function resolveTimeframe(
  choice: TimeframeChoice,
  customStartTs?: number,
  customEndTs?: number,
  nowTs: number = Math.floor(Date.now() / 1000)
): { gte: number | null; lte: number | null } {
  if (choice === 'Custom range…') {
    return { gte: customStartTs ?? null, lte: customEndTs ?? null };
  }
  const presets: Record<string, number> = {
    'Past 24 Hours': 24 * 3600,
    'Past 7 Days': 7 * 24 * 3600,
    'Past 30 Days': 30 * 24 * 3600
  };
  if (presets[choice]) {
    return { gte: nowTs - presets[choice], lte: null };
  }
  return { gte: null, lte: null };
}

/**
 * Generate self-contained downloadable HTML report
 */
export function answerToHtml(
  question: string,
  answer: string,
  sources?: SourceItem[],
  stats?: QueryStats
): string {
  const escapeHtml = (str: string) =>
    (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  const nowFormatted = new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  // Convert basic markdown formatting to html
  let formattedAnswer = escapeHtml(answer)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  let srcHtml = '';
  if (sources && sources.length > 0) {
    const items = sources.map(s => {
      const title = escapeHtml(s.title || 'Source');
      const url = s.url || '';
      const meta = [s.feed, s.date].filter(Boolean).map(escapeHtml).join(' &middot; ');
      const link = url ? `<a href="${encodeURI(url)}" target="_blank" rel="noopener">${title}</a>` : title;
      return `<li>${link}${meta ? ` <span class="m">(${meta})</span>` : ''}</li>`;
    });
    srcHtml = `<h2>Sources & Grounded Citations</h2><ol>${items.join('')}</ol>`;
  }

  let statHtml = '';
  if (stats) {
    const g = stats.gen || ({} as any);
    const r = stats.retrieval || ({} as any);
    statHtml = `<p class="m">Model: ${escapeHtml(stats.model)} &middot; ${(g.out_tokens || 0).toLocaleString()} output tokens &middot; ${(g.tps || 0).toFixed(1)} tokens/s &middot; ${r.used || 0} of ${r.retrieved || 0} excerpts used &middot; Device: ${g.device || 'GPU'}</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(question.slice(0, 80)) || 'K13 Intelligence Hub Report'}</title>
  <style>
    body { font: 16px/1.6 system-ui, -apple-system, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; color: #1b1f24; background: #ffffff; }
    h1 { font-size: 1.4rem; color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 0.5rem; }
    h2 { font-size: 1.15rem; margin-top: 2rem; color: #1e293b; }
    .q { background: #f1f5f9; padding: 1rem 1.2rem; border-radius: 8px; border-left: 4px solid #6366f1; margin-bottom: 1.5rem; }
    .m { color: #64748b; font-size: 0.85rem; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ol { padding-left: 1.2rem; }
    li { margin-bottom: 0.4rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #0b0f19; color: #e2e8f0; }
      h1 { color: #f8fafc; border-bottom-color: #6366f1; }
      h2 { color: #cbd5e1; }
      .q { background: #1e293b; color: #f1f5f9; border-left-color: #818cf8; }
      .m { color: #94a3b8; }
      a { color: #60a5fa; }
    }
  </style>
</head>
<body>
  <h1>⚡ K13 AI Intelligence Hub Report</h1>
  <p class="m">Generated on ${nowFormatted}</p>
  <div class="q"><strong>Question:</strong> ${escapeHtml(question)}</div>
  <h2>Intelligence Assessment</h2>
  <div><p>${formattedAnswer}</p></div>
  ${srcHtml}
  ${statHtml}
</body>
</html>`;
}
