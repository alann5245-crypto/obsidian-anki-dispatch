# Anki Dispatch for Obsidian

[![CI](https://github.com/alann5245-crypto/obsidian-anki-dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/alann5245-crypto/obsidian-anki-dispatch/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/alann5245-crypto/obsidian-anki-dispatch)](https://github.com/alann5245-crypto/obsidian-anki-dispatch/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](./LICENSE)

Create Anki flashcards and route each card to any existing Deck or brand-new Subdeck right from Obsidian—**while keeping your Markdown notes 100% pure, readable, and free of inline flashcard syntax**. Zero external runtime dependencies, zero typing overhead.

---

## Why Anki Dispatch?

Traditional Obsidian-to-Anki plugins embed `Q:/A:` blocks, `START/END` markers, or inline callouts directly between paragraphs. Cognitive science highlights two major problems with that approach:

1. **Split-Attention Effect (John Sweller):** Mixing quiz blocks into connected prose forces working memory to constantly switch between *comprehending a mental model* and *scanning isolated test prompts*, degrading reading flow.
2. **The Collector's Fallacy & Piotr Wozniak's Minimum Information Principle:** Auto-converting highlighted paragraphs into cards encourages passive hoarding before genuine comprehension (*"Do not learn if you do not understand"*).

**Anki Dispatch** separates **Notes for Comprehension** from **Anki for Atomic Retrieval**:
- **100% Clean Markdown Prose:** No card blocks are ever injected into your note body. Notes that have cards receive only a tiny 8-character `anki_note_id` in YAML frontmatter (rename- and move-proof across your vault), paired with an `obs-src::<id>` tag and `obsidian://open` source backlink in Anki.
- **Instant Two-Way Inspection (`~5–15ms`):** Opening a note in Obsidian queries `AnkiConnect` asynchronously (with an `O(1)` bounded 50-note RAM cache) so you can view, edit, move Decks, or delete that note's Anki cards right from the **Anki Studio** sidebar without creating duplicates.
- **Anti-Hoarding Reference Context Box:** Highlighted excerpts appear inside a *Reference Context* card above the composer so you formulate concise prompts in your own words—with a 1-click **Send to Cloze** helper when you want quick `{{c1::...}}` deletions.

---

## Core Features

1. **Raycast-Style Fuzzy Deck Combobox (`Ctrl+O` UX)**
   - Subsequence & substring search across hierarchical `Parent::Child::Subdeck` decks with dimmed parent breadcrumbs and full `↑` / `↓` / `Enter` / `Esc` keyboard control.
   - Pin favorite decks (`★`) right inside the dropdown.
   - Smart default routing per **Note → Folder Rule → Recent → Global Fallback**.
   - Type any new path (e.g. `CS::Distributed Systems::Raft`) to create the subdeck in Anki on the fly.

2. **Dual Capture Surfaces (Single Shared `CardComposer`)**
   - **Quick Dispatch Modal (`Ctrl/Cmd + Shift + A`):** Centered popup with **Rapid-Fire** mode (`Ctrl/Cmd + Enter` dispatches and clears fields while keeping your target Deck locked).
   - **Right Sidebar — Anki Studio:** Keep your full note unobstructed on the left while writing, previewing, and managing cards on the right.
   - **Floating Selection Pill (`0.00ms` Keystroke Cost):** Highlighting a passage surfaces a lightweight `[Anki Dispatch | Cloze]` pill after mouse release.

3. **Rich Card Types, Live Cloze Flipper & Media**
   - Built-in tabs for **Basic**, **Basic (and reversed card)**, and **Cloze** (`Ctrl/Cmd + Shift + C` auto-increments `c1`, `c2`…; `Ctrl/Cmd + Alt + Shift + C` reuses the current index), plus dynamic field loading for **any custom Anki Note Type**.
   - **Live Preview Flipper:** Render Front/Back and interactively flip `[...]` Cloze blanks before sending to Anki.
   - Automatic `$...$` / `$$...$$` LaTeX-to-MathJax (`\(...\)` / `\[...\]`) conversion, code formatting, duplicate-front warning, and `Ctrl+V` screenshot paste (`storeMediaFile`).

4. **Self-Purging `0-Byte` Offline Queue**
   - If Anki Desktop is closed (or when capturing on mobile), you can still browse cached Decks and queue cards normally.
   - Pasted offline images are stored in a separate temporary folder outside `data.json`, and the entire queue **auto-flushes and purges back to `0 bytes`** the moment Anki reconnects.

---

## Installation

### Option 1: Install via BRAT (Recommended)
1. Install the **BRAT** community plugin in Obsidian.
2. Open **BRAT → Add Beta plugin** and enter:
   ```text
   alann5245-crypto/obsidian-anki-dispatch
   ```
3. Enable **Anki Dispatch** in **Settings → Community plugins**.

### Option 2: Manual Install from GitHub Releases
1. Download `anki-dispatch-1.0.0.zip` (or `main.js`, `manifest.json`, and `styles.css`) from the [Latest Release](https://github.com/alann5245-crypto/obsidian-anki-dispatch/releases/latest).
2. Place `main.js`, `manifest.json`, and `styles.css` in `<Your Vault>/.obsidian/plugins/anki-dispatch/`.
3. Reload plugins and enable **Anki Dispatch**.

### AnkiConnect Setup
1. In **Anki Desktop**, open **Tools → Add-ons → Get Add-ons...**
2. Enter code **`2055492159`** ([AnkiConnect](https://ankiweb.net/shared/info/2055492159)) and restart Anki.
3. In Obsidian → **Settings → Anki Dispatch** → click **Test & Sync Decks**.

---

## Performance Architecture

- **`< 2ms` Startup:** `onload()` performs zero vault scans (`0` calls to `getMarkdownFiles()`) and defers `AnkiConnect` sync until `workspace.onLayoutReady()` using a single batched `multi` roundtrip.
- **`0.00ms` Typing Overhead:** No inline card syntax means zero per-keystroke regex or AST decoration passes inside CodeMirror.
- **Bounded Memory:** Per-note card summaries are cached in a strict 50-entry LRU map (`BoundedNoteCardCache`), and the entire production bundle is ~54 KB with zero external runtime dependencies.

## Development

```bash
npm install
npm test        # Run core unit & 2,000-deck benchmark tests (Node 22 strip-types)
npm run build   # Type-check and bundle minified main.js
```

### Releasing a New Version
1. Update `version` in `manifest.json`, `package.json`, and `versions.json`.
2. Commit and push a semver tag **without** a `v` prefix (required by Obsidian):
   ```bash
   git tag 1.0.1 && git push origin 1.0.1
   ```
3. GitHub Actions automatically runs tests, builds `main.js`, and publishes the GitHub Release with `main.js`, `manifest.json`, `styles.css`, and a ready-to-extract `.zip` archive.

## License

MIT — see [LICENSE](./LICENSE).
