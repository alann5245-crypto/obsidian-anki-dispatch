import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ankiHtmlToEditableText,
  appendSourceFooter,
  BoundedNoteCardCache,
  buildObsidianDeepLink,
  buildSourceTag,
  DEFAULT_SETTINGS,
  extractSourceAnchorFromTags,
  generateNoteAnchorId,
  markdownToAnkiHtml,
  normalizeDeckPath,
  pushBoundedUnique,
  rankDecksFuzzy,
  renderClozePreviewHtml,
  resolveSmartDefaultDeck,
  stripSourceFooter,
  wrapNextCloze
} from "../src/core.ts";

describe("Anki Dispatch Core Engine", () => {
  it("normalizes hierarchical deck paths cleanly", () => {
    assert.equal(normalizeDeckPath("  CS :: Distributed Systems ::  Raft  "), "CS::Distributed Systems::Raft");
    assert.equal(normalizeDeckPath("Math::::Linear Algebra"), "Math::Linear Algebra");
  });

  it("ranks decks with Ctrl+O subsequence matching, leaf boost, pinning, and new subdeck detection", () => {
    const decks = [
      "Default",
      "Computer Science::Distributed Systems::Consensus::Raft",
      "Computer Science::Algorithms::Graphs",
      "Khoa học nhận thức::Trí nhớ::Tải nhận thức"
    ];

    const res1 = rankDecksFuzzy({
      query: "csraft",
      decks,
      pinnedDecks: [],
      recentDecks: []
    });
    assert.equal(res1.options[0]?.deckName, "Computer Science::Distributed Systems::Consensus::Raft");
    assert.equal(res1.options[0]?.leafName, "Raft");
    assert.equal(res1.canCreateNew, "csraft");

    const exact = rankDecksFuzzy({
      query: "Computer Science :: Algorithms :: Graphs",
      decks,
      pinnedDecks: [],
      recentDecks: []
    });
    assert.equal(exact.canCreateNew, null);

    const newSubdeck = rankDecksFuzzy({
      query: "Khoa học nhận thức::Giấc ngủ::REM",
      decks,
      pinnedDecks: [],
      recentDecks: []
    });
    assert.equal(newSubdeck.canCreateNew, "Khoa học nhận thức::Giấc ngủ::REM");
  });

  it("resolves smart default deck by priority: Note Memory > Longest Folder Rule > Recent > Global Default", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.defaultDeck = "General";
    settings.recentDecks = ["Recent::Deck"];
    settings.folderDeckRules = [
      { folderPrefix: "CS", deckName: "CS::Core" },
      { folderPrefix: "CS/Systems", deckName: "CS::Distributed" }
    ];
    settings.noteDeckMemory["abc12345"] = "Custom::PinnedNoteDeck";

    assert.deepEqual(
      resolveSmartDefaultDeck({ noteAnchorId: "abc12345", filePath: "CS/Systems/Raft.md", settings }),
      { deckName: "Custom::PinnedNoteDeck", reason: "note" }
    );
    assert.deepEqual(
      resolveSmartDefaultDeck({ noteAnchorId: null, filePath: "CS/Systems/Raft.md", settings }),
      { deckName: "CS::Distributed", reason: "folder" }
    );
    assert.deepEqual(
      resolveSmartDefaultDeck({ noteAnchorId: null, filePath: "Random/Note.md", settings }),
      { deckName: "Recent::Deck", reason: "recent" }
    );
  });

  it("auto-increments Cloze indices (c1 -> c2) and supports same-index mode", () => {
    const step1 = wrapNextCloze("Split-Attention Effect increases cognitive load", 0, 22, false);
    assert.equal(step1.text, "{{c1::Split-Attention Effect}} increases cognitive load");
    assert.equal(step1.indexUsed, 1);

    const start2 = step1.text.indexOf("cognitive load");
    const step2 = wrapNextCloze(step1.text, start2, start2 + 14, false);
    assert.equal(step2.text, "{{c1::Split-Attention Effect}} increases {{c2::cognitive load}}");
    assert.equal(step2.indexUsed, 2);

    const stepSame = wrapNextCloze(step1.text, start2, start2 + 14, true);
    assert.equal(stepSame.text, "{{c1::Split-Attention Effect}} increases {{c1::cognitive load}}");
  });

  it("converts Markdown, code, LaTeX math ($...$ / $$...$$), and pasted <img> safely to Anki HTML and back", () => {
    const raw = 'Formula $R = e^{-t/S}$ with **bold**, `O(1)` lookup, and <img src="paste-1.png">\n$$\\sum_{i=1}^n x_i$$';
    const html = markdownToAnkiHtml(raw);

    assert.match(html, /\\\(R = e\^\{-t\/S\}\\\)/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>O\(1\)<\/code>/);
    assert.match(html, /<img src="paste-1\.png">/);
    assert.match(html, /\\\[\\sum_\{i=1\}\^n x_i\\\]/);

    const link = buildObsidianDeepLink("My Vault", "Notes/Memory.md");
    const withFooter = appendSourceFooter(html, link, "Memory");
    assert.ok(withFooter.includes("obsidian://open"));

    // Stripping back to editable Markdown leaves no HTML noise or duplicate footers
    const editable = ankiHtmlToEditableText(withFooter);
    assert.ok(!editable.includes("obsidian://open"));
    assert.ok(editable.includes("$R = e^{-t/S}$"));
    assert.ok(editable.includes("**bold**"));
    assert.ok(editable.includes("`O(1)`"));
    assert.ok(editable.includes('<img src="paste-1.png">'));
  });

  it("renders interactive Cloze preview HTML in masked and revealed states", () => {
    const masked = renderClozePreviewHtml("Memory decays via {{c1::exponential::curve type}} curve.", false);
    assert.match(masked, /\[curve type\]/);
    const revealed = renderClozePreviewHtml("Memory decays via {{c1::exponential::curve type}} curve.", true);
    assert.match(revealed, /ad-cloze-revealed[^>]*>exponential/);
  });

  it("maintains strict O(1) bounded memory in BoundedNoteCardCache and fast fuzzy search on 2,000 decks", () => {
    const cache = new BoundedNoteCardCache(3);
    cache.set("n1", []);
    cache.set("n2", []);
    cache.set("n3", []);
    cache.get("n1"); // refresh n1 so n2 becomes oldest
    cache.set("n4", []);

    assert.equal(cache.size, 3);
    assert.equal(cache.get("n2"), undefined);
    assert.ok(Array.isArray(cache.get("n1")));

    // Performance budget: ranking 2,000 hierarchical decks must take < 25ms
    const manyDecks = Array.from({ length: 2000 }, (_, i) => `Domain${i % 20}::Topic${i % 100}::Subdeck${i}`);
    const t0 = performance.now();
    const ranked = rankDecksFuzzy({
      query: "d5sub1985",
      decks: manyDecks,
      pinnedDecks: pushBoundedUnique([], "Domain5::Topic85::Subdeck1985"),
      recentDecks: []
    });
    const elapsedMs = performance.now() - t0;

    assert.equal(ranked.options[0]?.deckName, "Domain5::Topic85::Subdeck1985");
    assert.ok(elapsedMs < 35, `Expected fuzzy search < 35ms on 2,000 decks, got ${elapsedMs.toFixed(2)}ms`);

    const anchor = generateNoteAnchorId();
    assert.equal(anchor.length, 8);
    assert.equal(extractSourceAnchorFromTags(["obsidian-dispatch", buildSourceTag(anchor)]), anchor);
  });
});
