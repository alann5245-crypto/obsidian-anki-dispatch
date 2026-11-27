export interface FolderDeckRule {
  folderPrefix: string;
  deckName: string;
}

export interface QueuedMediaRef {
  filename: string;
  tempPath: string;
}

export interface QueuedCardItem {
  queueId: string;
  createdAt: number;
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  noteAnchorId?: string;
  notePath?: string;
  mediaRefs: QueuedMediaRef[];
}

export interface AnkiDispatchSettings {
  ankiConnectUrl: string;
  defaultDeck: string;
  defaultModel: string;
  defaultCaptureMode: "modal" | "sidebar";
  enableFloatingSelectionBar: boolean;
  appendObsidianBacklink: boolean;
  pinnedDecks: string[];
  recentDecks: string[];
  noteDeckMemory: Record<string, string>;
  folderDeckRules: FolderDeckRule[];
  cachedDecks: string[];
  cachedModels: Record<string, string[]>;
  pendingQueue: QueuedCardItem[];
}

export const DEFAULT_MODELS: Record<string, string[]> = {
  "Basic": ["Front", "Back"],
  "Basic (and reversed card)": ["Front", "Back"],
  "Cloze": ["Text", "Back Extra"]
};

export const DEFAULT_SETTINGS: AnkiDispatchSettings = {
  ankiConnectUrl: "http://127.0.0.1:8765",
  defaultDeck: "Default",
  defaultModel: "Basic",
  defaultCaptureMode: "modal",
  enableFloatingSelectionBar: true,
  appendObsidianBacklink: true,
  pinnedDecks: [],
  recentDecks: [],
  noteDeckMemory: {},
  folderDeckRules: [],
  cachedDecks: ["Default"],
  cachedModels: { ...DEFAULT_MODELS },
  pendingQueue: []
};

export interface AnkiNoteSummary {
  noteId: number;
  modelName: string;
  deckName: string;
  fields: Record<string, string>;
  tags: string[];
}

export interface DeckRankedOption {
  deckName: string;
  parentBreadcrumb: string;
  leafName: string;
  badge: "note" | "folder" | "pinned" | "recent" | "";
  isPinned: boolean;
  score: number;
}

const SOURCE_TAG_PREFIX = "obs-src::";
const BACKLINK_START = "<!--ad-src-start-->";
const BACKLINK_END = "<!--ad-src-end-->";

export function generateNoteAnchorId(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  for (let i = 0; i < 8; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function buildSourceTag(anchorId: string): string {
  return `${SOURCE_TAG_PREFIX}${anchorId.trim()}`;
}

export function extractSourceAnchorFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (t.startsWith(SOURCE_TAG_PREFIX)) {
      return t.slice(SOURCE_TAG_PREFIX.length) || null;
    }
  }
  return null;
}

export function buildObsidianDeepLink(vaultName: string, filePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
}

export function normalizeDeckPath(raw: string): string {
  return raw
    .split("::")
    .map((seg) => seg.trim())
    .filter(Boolean)
    .join("::");
}

export function splitDeckHierarchy(deckName: string): { parentBreadcrumb: string; leafName: string } {
  const parts = deckName.split("::").filter(Boolean);
  if (parts.length <= 1) {
    return { parentBreadcrumb: "", leafName: deckName };
  }
  const leafName = parts[parts.length - 1];
  const parentBreadcrumb = parts.slice(0, -1).join(" › ") + " › ";
  return { parentBreadcrumb, leafName };
}

export function resolveSmartDefaultDeck(params: {
  noteAnchorId?: string | null;
  filePath?: string | null;
  settings: AnkiDispatchSettings;
}): { deckName: string; reason: "note" | "folder" | "recent" | "default" } {
  const { noteAnchorId, filePath, settings } = params;

  if (noteAnchorId && settings.noteDeckMemory[noteAnchorId]) {
    return { deckName: settings.noteDeckMemory[noteAnchorId], reason: "note" };
  }

  if (filePath) {
    const normalizedPath = filePath.replace(/^\/+/, "");
    let bestRule: FolderDeckRule | null = null;
    for (const rule of settings.folderDeckRules) {
      const prefix = rule.folderPrefix.replace(/^\/+|\/+$/g, "");
      if (prefix && (normalizedPath === prefix || normalizedPath.startsWith(prefix + "/"))) {
        if (!bestRule || prefix.length > bestRule.folderPrefix.length) {
          bestRule = rule;
        }
      }
    }
    if (bestRule?.deckName) {
      return { deckName: bestRule.deckName, reason: "folder" };
    }
  }

  if (settings.recentDecks.length > 0) {
    return { deckName: settings.recentDecks[0], reason: "recent" };
  }

  return { deckName: settings.defaultDeck || "Default", reason: "default" };
}

export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  if (c === q) return 1000;
  const subIdx = c.indexOf(q);
  if (subIdx !== -1) {
    const leafStart = c.lastIndexOf("::") + 2;
    const inLeafBonus = subIdx >= leafStart ? 180 : 0;
    const prefixBonus = subIdx === 0 || c[subIdx - 1] === ":" || c[subIdx - 1] === " " ? 90 : 0;
    return 500 + inLeafBonus + prefixBonus - Math.min(subIdx, 60);
  }

  // Subsequence match (Ctrl+O style, e.g. "csraf" -> "CS::Consensus::Raft")
  let qi = 0;
  let score = 100;
  let consecutive = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++;
      consecutive++;
      score += 12 + consecutive * 6;
      if (ci === 0 || c[ci - 1] === ":" || c[ci - 1] === " " || c[ci - 1] === "/" || c[ci - 1] === "-") {
        score += 18;
      }
    } else {
      consecutive = 0;
    }
  }
  return qi === q.length ? score - Math.min(c.length, 50) : -1;
}

export function rankDecksFuzzy(params: {
  query: string;
  decks: string[];
  noteDefaultDeck?: string;
  folderDefaultDeck?: string;
  pinnedDecks: string[];
  recentDecks: string[];
}): { options: DeckRankedOption[]; canCreateNew: string | null } {
  const cleanQuery = normalizeDeckPath(params.query);
  const rawTrimmed = params.query.trim();
  const pinnedSet = new Set(params.pinnedDecks);
  const recentIdx = new Map(params.recentDecks.map((d, idx) => [d, idx]));
  const uniqueDecks = Array.from(new Set([
    ...params.decks,
    ...params.pinnedDecks,
    ...params.recentDecks,
    ...(params.noteDefaultDeck ? [params.noteDefaultDeck] : []),
    ...(params.folderDefaultDeck ? [params.folderDefaultDeck] : [])
  ].filter(Boolean)));

  const options: DeckRankedOption[] = [];
  for (const deckName of uniqueDecks) {
    const baseScore = fuzzyScore(rawTrimmed, deckName);
    if (baseScore < 0) continue;

    let priorityBonus = 0;
    let badge: DeckRankedOption["badge"] = "";
    const isPinned = pinnedSet.has(deckName);

    if (params.noteDefaultDeck && deckName === params.noteDefaultDeck) {
      priorityBonus += 80;
      badge = "note";
    } else if (params.folderDefaultDeck && deckName === params.folderDefaultDeck) {
      priorityBonus += 65;
      badge = "folder";
    } else if (isPinned) {
      priorityBonus += 50;
      badge = "pinned";
    } else if (recentIdx.has(deckName)) {
      priorityBonus += Math.max(15, 40 - (recentIdx.get(deckName) ?? 0) * 5);
      badge = "recent";
    }

    const { parentBreadcrumb, leafName } = splitDeckHierarchy(deckName);
    options.push({
      deckName,
      parentBreadcrumb,
      leafName,
      badge,
      isPinned,
      score: baseScore + priorityBonus
    });
  }

  options.sort((a, b) => b.score - a.score || a.deckName.localeCompare(b.deckName));

  const exactExists = cleanQuery
    ? uniqueDecks.some((d) => d.toLowerCase() === cleanQuery.toLowerCase())
    : true;

  return {
    options,
    canCreateNew: cleanQuery && !exactExists ? cleanQuery : null
  };
}

export function wrapNextCloze(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  sameIndex = false
): { text: string; cursorEnd: number; indexUsed: number } {
  let maxIdx = 0;
  const clozeRegex = /\{\{c(\d+)::/g;
  let match: RegExpExecArray | null;
  while ((match = clozeRegex.exec(text)) !== null) {
    const n = Number(match[1]);
    if (n > maxIdx) maxIdx = n;
  }

  const nextIdx = sameIndex ? Math.max(1, maxIdx) : maxIdx + 1;
  const selected = text.slice(selectionStart, selectionEnd);
  const inner = selected || "...";
  const token = `{{c${nextIdx}::${inner}}}`;
  const updated = text.slice(0, selectionStart) + token + text.slice(selectionEnd);
  const cursorEnd = selected
    ? selectionStart + token.length
    : selectionStart + `{{c${nextIdx}::`.length + inner.length;

  return { text: updated, cursorEnd, indexUsed: nextIdx };
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

/**
 * Converts lightweight Obsidian Markdown + LaTeX ($...$ / $$...$$) + code into clean Anki HTML.
 * Preserves existing <img> tags generated from pasted screenshots.
 */
export function markdownToAnkiHtml(raw: string): string {
  if (!raw.trim()) return "";

  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const key = `\u0000ADPH${placeholders.length}\u0000`;
    placeholders.push(html);
    return key;
  };

  // 1. Preserve explicit <img src="..."> media tags from Ctrl+V image paste
  let working = raw.replace(/<img\s+src="([^"<>]+)"\s*\/?>/gi, (_m, src) => {
    return stash(`<img src="${escapeHtml(src)}">`);
  });

  // 2. Fenced code blocks ```lang\n...\n```
  working = working.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return stash(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
  });

  // 3. Inline code `...`
  working = working.replace(/`([^`\n]+)`/g, (_m, code) => {
    return stash(`<code>${escapeHtml(code)}</code>`);
  });

  // 4. Display math $$...$$ -> \[...\]
  working = working.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr) => {
    return stash(`\\[${escapeHtml(expr.trim())}\\]`);
  });

  // 5. Inline math $...$ -> \(...\) (avoid matching "$100 and $200" currency)
  working = working.replace(/(?<!\\|\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_m, expr) => {
    return stash(`\\(${escapeHtml(expr)}\\)`);
  });

  // 6. Escape remaining plain text safely
  working = escapeHtml(working).replace(/\\\$/g, "$");

  // 7. Inline Markdown formatting
  working = working
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

  // 8. Line breaks
  working = working.replace(/\r?\n/g, "<br>");

  // 9. Restore stashed blocks
  return working.replace(/\u0000ADPH(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)] ?? "");
}

export function appendSourceFooter(fieldHtml: string, deepLink: string, noteTitle: string): string {
  const clean = stripSourceFooter(fieldHtml);
  const footer = `${BACKLINK_START}<div style="margin-top:10px;font-size:0.8em;opacity:0.68;"><a href="${escapeHtml(deepLink)}">Obsidian: ${escapeHtml(noteTitle)}</a></div>${BACKLINK_END}`;
  return clean ? `${clean}${footer}` : footer;
}

export function stripSourceFooter(fieldHtml: string): string {
  const start = fieldHtml.indexOf(BACKLINK_START);
  if (start === -1) return fieldHtml;
  const end = fieldHtml.indexOf(BACKLINK_END, start);
  if (end === -1) return fieldHtml.slice(0, start).trim();
  return (fieldHtml.slice(0, start) + fieldHtml.slice(end + BACKLINK_END.length)).trim();
}

export function ankiHtmlToEditableText(fieldHtml: string): string {
  let clean = stripSourceFooter(fieldHtml);
  clean = clean
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/gi, (_m, lang, code) => {
      return `\`\`\`${lang || ""}\n${unescapeHtml(code)}\n\`\`\``;
    })
    .replace(/<code>([\s\S]*?)<\/code>/gi, (_m, c) => `\`${unescapeHtml(c)}\``)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, m) => `$$${unescapeHtml(m)}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, m) => `$${unescapeHtml(m)}$`)
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<mark>([\s\S]*?)<\/mark>/gi, "==$1==")
    .replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*")
    .replace(/<(?!img\b)[^>]+>/gi, "");

  return unescapeHtml(clean).trim();
}

export function unescapeHtml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function renderClozePreviewHtml(rawText: string, revealed: boolean): string {
  const html = markdownToAnkiHtml(rawText);
  return html.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_m, idx, answer, hint) => {
    if (revealed) {
      return `<span class="ad-cloze-revealed" title="c${idx}">${answer}</span>`;
    }
    const label = hint ? `[${hint}]` : `[...]`;
    return `<span class="ad-cloze-blank" title="c${idx}">${label}</span>`;
  });
}

export function pushBoundedUnique(list: string[], item: string, maxLen = 8): string[] {
  const clean = normalizeDeckPath(item);
  if (!clean) return list.slice(0, maxLen);
  return [clean, ...list.filter((x) => x !== clean)].slice(0, maxLen);
}

/**
 * O(1) Bounded LRU Cache for per-note Anki card summaries.
 * Guarantees memory never grows unbounded even in 10,000+ note vaults.
 */
export class BoundedNoteCardCache {
  private map = new Map<string, AnkiNoteSummary[]>();
  private readonly maxEntries: number;

  constructor(maxEntries = 50) {
    this.maxEntries = maxEntries;
  }

  get(anchorId: string): AnkiNoteSummary[] | undefined {
    const val = this.map.get(anchorId);
    if (val !== undefined) {
      this.map.delete(anchorId);
      this.map.set(anchorId, val);
    }
    return val;
  }

  set(anchorId: string, cards: AnkiNoteSummary[]): void {
    if (this.map.has(anchorId)) {
      this.map.delete(anchorId);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(anchorId, cards);
  }

  invalidate(anchorId: string): void {
    this.map.delete(anchorId);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
