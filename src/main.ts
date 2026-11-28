import {
  MarkdownView,
  Menu,
  Notice,
  normalizePath,
  Plugin,
  setIcon,
  TAbstractFile,
  TFile
} from "obsidian";
import {
  BoundedNoteCardCache,
  DEFAULT_MODELS,
  DEFAULT_SETTINGS,
  generateNoteAnchorId,
  normalizeDeckPath,
  pushBoundedUnique,
  stripSourceFooter,
  appendSourceFooter,
  buildObsidianDeepLink,
  type AnkiDispatchSettings,
  type AnkiNoteSummary,
  type QueuedCardItem,
  type QueuedMediaRef
} from "./core";
import {
  addCardToAnki,
  deleteCardFromAnki,
  fetchCardsForNoteAnchor,
  fetchDecksAndModels,
  fetchModelFields,
  openNoteInAnkiBrowser,
  pingAnkiWithLatency,
  storeMediaBase64,
  updateCardInAnki
} from "./anki";
import { buildCardTags, injectBacklinkIntoCardFields } from "./composer";
import { QuickDispatchModal } from "./modal";
import { ANKI_STUDIO_VIEW_TYPE, AnkiStudioView, type StudioViewBridge } from "./studio-view";
import { AnkiDispatchSettingTab } from "./settings";

export default class AnkiDispatchPlugin extends Plugin implements StudioViewBridge {
  settings: AnkiDispatchSettings = { ...DEFAULT_SETTINGS };

  private ankiOnline = false;
  private lastLatencyMs = 0;
  private isFlushingQueue = false;
  private noteCardCache = new BoundedNoteCardCache(50);

  private statusBarEl: HTMLElement | null = null;
  private floatingPillEl: HTMLElement | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private leafDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(ANKI_STUDIO_VIEW_TYPE, (leaf) => new AnkiStudioView(leaf, this));
    this.addSettingTab(new AnkiDispatchSettingTab(this.app, this));

    this.addRibbonIcon("layers", "Anki Studio", () => {
      void this.activateStudioSidebar();
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("ad-statusbar-pill");
    this.statusBarEl.addEventListener("click", () => {
      if (this.settings.pendingQueue.length > 0) {
        void this.flushOfflineQueue(true);
      } else {
        void this.activateStudioSidebar();
      }
    });
    this.updateStatusBar();

    this.addCommand({
      id: "open-quick-dispatch",
      name: "Quick capture card",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "a" }],
      callback: () => {
        const selection = this.getCurrentEditorSelection();
        void this.openCaptureSurface(selection, false);
      }
    });

    this.addCommand({
      id: "quick-cloze-from-selection",
      name: "Create Cloze from selection",
      callback: () => {
        const selection = this.getCurrentEditorSelection();
        void this.openCaptureSurface(selection, true);
      }
    });

    this.addCommand({
      id: "open-anki-studio-sidebar",
      name: "Open Anki Studio",
      callback: () => {
        void this.activateStudioSidebar();
      }
    });

    this.addCommand({
      id: "flush-offline-queue",
      name: "Flush offline queue",
      callback: () => {
        void this.flushOfflineQueue(true);
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor) => {
        const sel = editor.getSelection()?.trim() ?? "";
        menu.addItem((item) => {
          item
            .setTitle("Anki: New Card")
            .setIcon("plus")
            .onClick(() => void this.openCaptureSurface(sel, false));
        });
        if (sel) {
          menu.addItem((item) => {
            item
              .setTitle("Anki: Cloze")
              .setIcon("braces")
              .onClick(() => void this.openCaptureSurface(sel, true));
          });
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.hideFloatingSelectionPill();
        if (this.leafDebounceTimer) clearTimeout(this.leafDebounceTimer);
        this.leafDebounceTimer = setTimeout(() => {
          for (const view of this.getOpenStudioViews()) {
            void view.onActiveNoteChanged();
          }
        }, 140);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.handleNoteRenamed(file);
        }
      })
    );

    this.mountFloatingSelectionListeners();

    this.app.workspace.onLayoutReady(() => {
      void this.refreshAnkiConnection(false);
    });
  }

  onunload(): void {
    this.hideFloatingSelectionPill();
    this.floatingPillEl?.remove();
    this.floatingPillEl = null;
    this.noteCardCache.clear();
  }

  getSettings(): AnkiDispatchSettings {
    return this.settings;
  }

  isAnkiOnline(): boolean {
    return this.ankiOnline;
  }

  getLatencyMs(): number {
    return this.lastLatencyMs;
  }

  getActiveFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }

  async getNoteAnchorId(file: TFile, createIfMissing: boolean): Promise<string | null> {
    const cachedFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const existing = typeof cachedFm?.anki_note_id === "string" ? cachedFm.anki_note_id.trim() : "";
    if (existing) return existing;
    if (!createIfMissing) return null;

    let assigned = "";
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (typeof fm.anki_note_id === "string" && fm.anki_note_id.trim()) {
        assigned = fm.anki_note_id.trim();
      } else {
        assigned = generateNoteAnchorId();
        fm.anki_note_id = assigned;
      }
    });
    return assigned;
  }

  async togglePinDeck(deckName: string): Promise<void> {
    const clean = normalizeDeckPath(deckName);
    if (!clean) return;
    const idx = this.settings.pinnedDecks.indexOf(clean);
    if (idx >= 0) {
      this.settings.pinnedDecks.splice(idx, 1);
    } else {
      this.settings.pinnedDecks.unshift(clean);
    }
    await this.saveSettings();
  }

  async ensureModelFieldsLoaded(modelName: string): Promise<string[]> {
    const existing = this.settings.cachedModels[modelName];
    if (existing && existing.length > 0) return existing;

    if (this.ankiOnline) {
      try {
        const fields = await fetchModelFields(this.settings.ankiConnectUrl, modelName);
        if (fields.length > 0) {
          this.settings.cachedModels[modelName] = fields;
          await this.saveSettings();
          return fields;
        }
      } catch {
        // Fall through to defaults
      }
    }
    return DEFAULT_MODELS[modelName] ?? ["Front", "Back"];
  }

  async handlePastedImage(file: File): Promise<{ filename: string; queuedRef?: QueuedMediaRef }> {
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const filename = `anki-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const buffer = await file.arrayBuffer();

    if (this.ankiOnline) {
      const base64 = arrayBufferToBase64(buffer);
      await storeMediaBase64(this.settings.ankiConnectUrl, filename, base64);
      return { filename };
    }

    const mediaDir = normalizePath(`${this.manifest.dir ?? ".obsidian/plugins/anki-dispatch"}/queue-media`);
    if (!(await this.app.vault.adapter.exists(mediaDir))) {
      await this.app.vault.adapter.mkdir(mediaDir);
    }
    const tempPath = normalizePath(`${mediaDir}/${filename}`);
    await this.app.vault.adapter.writeBinary(tempPath, buffer);
    return { filename, queuedRef: { filename, tempPath } };
  }

  async dispatchCard(payload: {
    editingNoteId: number | null;
    previousDeckName?: string;
    deckName: string;
    modelName: string;
    fieldsHtml: Record<string, string>;
    extraTags: string[];
    mediaRefs: QueuedMediaRef[];
    targetFile: TFile | null;
  }): Promise<{ status: "added" | "updated" | "queued"; noteId?: number }> {
    const cleanDeck = normalizeDeckPath(payload.deckName) || "Default";
    const anchorId = payload.targetFile
      ? await this.getNoteAnchorId(payload.targetFile, true)
      : null;

    this.settings.recentDecks = pushBoundedUnique(this.settings.recentDecks, cleanDeck, 8);
    if (!this.settings.cachedDecks.includes(cleanDeck)) {
      this.settings.cachedDecks.unshift(cleanDeck);
    }
    if (anchorId) {
      this.settings.noteDeckMemory[anchorId] = cleanDeck;
      const keys = Object.keys(this.settings.noteDeckMemory);
      if (keys.length > 300) {
        delete this.settings.noteDeckMemory[keys[0]];
      }
    }

    const finalFields =
      this.settings.appendObsidianBacklink && payload.targetFile
        ? injectBacklinkIntoCardFields({
            fieldsHtml: payload.fieldsHtml,
            vaultName: this.app.vault.getName(),
            filePath: payload.targetFile.path,
            fileBasename: payload.targetFile.basename
          })
        : payload.fieldsHtml;

    const tags = buildCardTags(anchorId, payload.extraTags);

    if (payload.editingNoteId) {
      await updateCardInAnki(this.settings.ankiConnectUrl, {
        noteId: payload.editingNoteId,
        newDeckName: cleanDeck,
        currentDeckName: payload.previousDeckName,
        fields: finalFields
      });
      if (anchorId) this.noteCardCache.invalidate(anchorId);
      await this.saveSettings();
      this.notifyAllViewsStatusChanged();
      return { status: "updated", noteId: payload.editingNoteId };
    }

    if (this.ankiOnline) {
      try {
        await this.uploadAndPurgeQueuedMedia(payload.mediaRefs);
        const noteId = await addCardToAnki(this.settings.ankiConnectUrl, {
          deckName: cleanDeck,
          modelName: payload.modelName,
          fields: finalFields,
          tags
        });
        if (anchorId) this.noteCardCache.invalidate(anchorId);
        await this.saveSettings();
        this.notifyAllViewsStatusChanged();
        return { status: "added", noteId };
      } catch {
        this.ankiOnline = false;
      }
    }

    const queueItem: QueuedCardItem = {
      queueId: generateNoteAnchorId(),
      createdAt: Date.now(),
      deckName: cleanDeck,
      modelName: payload.modelName,
      fields: finalFields,
      tags,
      noteAnchorId: anchorId ?? undefined,
      notePath: payload.targetFile?.path,
      mediaRefs: payload.mediaRefs
    };
    this.settings.pendingQueue.push(queueItem);
    await this.saveSettings();
    this.notifyAllViewsStatusChanged();
    return { status: "queued" };
  }

  async getNoteCardsForActiveFile(forceRefresh = false): Promise<AnkiNoteSummary[]> {
    const file = this.getActiveFile();
    if (!file) return [];
    const anchorId = await this.getNoteAnchorId(file, false);
    if (!anchorId) return [];

    if (!forceRefresh) {
      const cached = this.noteCardCache.get(anchorId);
      if (cached) return cached;
    }

    if (!this.ankiOnline) return [];

    const cards = await fetchCardsForNoteAnchor(this.settings.ankiConnectUrl, anchorId);
    this.noteCardCache.set(anchorId, cards);
    return cards;
  }

  async deleteAnkiCard(noteId: number): Promise<void> {
    await deleteCardFromAnki(this.settings.ankiConnectUrl, noteId);
    const file = this.getActiveFile();
    const anchor = file ? await this.getNoteAnchorId(file, false) : null;
    if (anchor) this.noteCardCache.invalidate(anchor);
  }

  async openCardInAnkiBrowser(noteId: number): Promise<void> {
    try {
      await openNoteInAnkiBrowser(this.settings.ankiConnectUrl, noteId);
    } catch (err) {
      new Notice(`Anki Browser: ${(err as Error).message}`);
    }
  }

  async refreshAnkiConnection(showNotice = false): Promise<void> {
    const ping = await pingAnkiWithLatency(this.settings.ankiConnectUrl);
    this.ankiOnline = ping.online;
    this.lastLatencyMs = ping.latencyMs;

    if (this.ankiOnline) {
      try {
        const { decks, modelNames } = await fetchDecksAndModels(this.settings.ankiConnectUrl);
        if (decks.length > 0) this.settings.cachedDecks = decks;
        for (const m of modelNames) {
          if (!this.settings.cachedModels[m]) {
            this.settings.cachedModels[m] = DEFAULT_MODELS[m] ?? [];
          }
        }
        await this.saveSettings();
      } catch {
        // Non-fatal metadata refresh
      }

      if (this.settings.pendingQueue.length > 0) {
        await this.flushOfflineQueue(showNotice);
      } else if (showNotice) {
        new Notice(`Anki Online (${this.lastLatencyMs}ms) · ${this.settings.cachedDecks.length} decks`);
      }
    } else if (showNotice) {
      new Notice("Anki offline · Queue active");
    }

    this.notifyAllViewsStatusChanged();
    for (const view of this.getOpenStudioViews()) {
      void view.refreshNoteCards(true);
    }
  }

  async flushOfflineQueue(showNotice = true): Promise<{ flushed: number; remaining: number }> {
    if (this.isFlushingQueue || this.settings.pendingQueue.length === 0) {
      return { flushed: 0, remaining: this.settings.pendingQueue.length };
    }

    this.isFlushingQueue = true;
    let flushed = 0;

    try {
      const ping = await pingAnkiWithLatency(this.settings.ankiConnectUrl);
      this.ankiOnline = ping.online;
      this.lastLatencyMs = ping.latencyMs;
      if (!this.ankiOnline) {
        if (showNotice) new Notice("Anki offline");
        return { flushed: 0, remaining: this.settings.pendingQueue.length };
      }

      while (this.settings.pendingQueue.length > 0) {
        const item = this.settings.pendingQueue[0];
        await this.uploadAndPurgeQueuedMedia(item.mediaRefs);
        await addCardToAnki(this.settings.ankiConnectUrl, {
          deckName: item.deckName,
          modelName: item.modelName,
          fields: item.fields,
          tags: item.tags
        });
        if (item.noteAnchorId) this.noteCardCache.invalidate(item.noteAnchorId);
        this.settings.pendingQueue.shift();
        flushed++;
      }

      await this.saveSettings();
      if (showNotice && flushed > 0) {
        new Notice(`Synced ${flushed} ${flushed === 1 ? "card" : "cards"}`);
      }
    } catch (err) {
      await this.saveSettings();
      if (showNotice) {
        new Notice(`Sync error: ${(err as Error).message}`);
      }
    } finally {
      this.isFlushingQueue = false;
      this.notifyAllViewsStatusChanged();
      for (const view of this.getOpenStudioViews()) {
        void view.refreshNoteCards(true);
      }
    }

    return { flushed, remaining: this.settings.pendingQueue.length };
  }

  async openCaptureSurface(selection: string, clozeMode: boolean): Promise<void> {
    this.hideFloatingSelectionPill();
    if (this.settings.defaultCaptureMode === "sidebar") {
      const view = await this.activateStudioSidebar();
      view?.receiveSelection(selection, clozeMode);
      return;
    }
    new QuickDispatchModal(this.app, this, { selection, clozeMode }).open();
  }

  async activateStudioSidebar(): Promise<AnkiStudioView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(ANKI_STUDIO_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return null;
      leaf = rightLeaf;
      await leaf.setViewState({ type: ANKI_STUDIO_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof AnkiStudioView ? leaf.view : null;
  }

  private mountFloatingSelectionListeners(): void {
    const scheduleSelectionCheck = () => {
      if (!this.settings.enableFloatingSelectionBar) return;
      if (this.selectionTimer) clearTimeout(this.selectionTimer);
      this.selectionTimer = setTimeout(() => this.evaluateSelectionForPill(), 140);
    };

    this.registerDomEvent(document, "mouseup", scheduleSelectionCheck);
    this.registerDomEvent(document, "keyup", (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        this.hideFloatingSelectionPill();
        return;
      }
      if (ev.shiftKey && ev.key.startsWith("Arrow")) {
        scheduleSelectionCheck();
      } else if (!ev.ctrlKey && !ev.metaKey && ev.key.length === 1) {
        this.hideFloatingSelectionPill();
      }
    });
    this.registerDomEvent(document, "scroll", () => this.hideFloatingSelectionPill(), true);
  }

  private evaluateSelectionForPill(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hideFloatingSelectionPill();
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 10 || text.length > 1500) {
      this.hideFloatingSelectionPill();
      return;
    }

    const anchorNode = sel.anchorNode;
    const editorContainer = anchorNode instanceof Element
      ? anchorNode.closest(".markdown-source-view, .markdown-reading-view")
      : anchorNode?.parentElement?.closest(".markdown-source-view, .markdown-reading-view");

    if (!editorContainer) {
      this.hideFloatingSelectionPill();
      return;
    }

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideFloatingSelectionPill();
      return;
    }

    this.showFloatingSelectionPill(rect, text);
  }

  private showFloatingSelectionPill(rect: DOMRect, selectedText: string): void {
    if (!this.floatingPillEl) {
      this.floatingPillEl = document.body.createDiv({ cls: "ad-floating-pill is-hidden" });
    }

    this.floatingPillEl.empty();

    // Ultra-compact [+ Card | { } Cloze]
    const dispatchBtn = this.floatingPillEl.createEl("button", {
      type: "button",
      cls: "ad-pill-action ad-pill-primary"
    });
    const plusIcon = dispatchBtn.createSpan({ cls: "ad-icon-inline" });
    setIcon(plusIcon, "plus");
    dispatchBtn.createSpan({ text: "Card" });
    dispatchBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.openCaptureSurface(selectedText, false);
    });

    const clozeBtn = this.floatingPillEl.createEl("button", {
      type: "button",
      cls: "ad-pill-action"
    });
    const bracesIcon = clozeBtn.createSpan({ cls: "ad-icon-inline" });
    setIcon(bracesIcon, "braces");
    clozeBtn.createSpan({ text: "Cloze" });
    clozeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.openCaptureSurface(selectedText, true);
    });

    this.floatingPillEl.removeClass("is-hidden");
    const top = Math.max(12, rect.top - 40);
    const left = Math.min(window.innerWidth - 180, Math.max(12, rect.left + rect.width / 2 - 72));
    this.floatingPillEl.style.top = `${Math.round(top)}px`;
    this.floatingPillEl.style.left = `${Math.round(left)}px`;
  }

  hideFloatingSelectionPill(): void {
    this.floatingPillEl?.addClass("is-hidden");
  }

  private getCurrentEditorSelection(): string {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const fromEditor = mdView?.editor?.getSelection()?.trim();
    if (fromEditor) return fromEditor;
    return window.getSelection()?.toString().trim() ?? "";
  }

  private async uploadAndPurgeQueuedMedia(refs: QueuedMediaRef[]): Promise<void> {
    for (const ref of refs) {
      if (await this.app.vault.adapter.exists(ref.tempPath)) {
        const bin = await this.app.vault.adapter.readBinary(ref.tempPath);
        await storeMediaBase64(this.settings.ankiConnectUrl, ref.filename, arrayBufferToBase64(bin));
        await this.app.vault.adapter.remove(ref.tempPath);
      }
    }
  }

  private async handleNoteRenamed(file: TFile): Promise<void> {
    if (!this.ankiOnline || !this.settings.appendObsidianBacklink) return;
    const anchorId = await this.getNoteAnchorId(file, false);
    if (!anchorId) return;

    try {
      const cards = await fetchCardsForNoteAnchor(this.settings.ankiConnectUrl, anchorId);
      const newLink = buildObsidianDeepLink(this.app.vault.getName(), file.path);
      for (const c of cards) {
        const keys = Object.keys(c.fields);
        if (keys.length === 0) continue;
        const targetKey = keys.length >= 2 ? keys[1] : keys[0];
        const stripped = stripSourceFooter(c.fields[targetKey] ?? "");
        const updatedHtml = appendSourceFooter(stripped, newLink, file.basename);
        await updateCardInAnki(this.settings.ankiConnectUrl, {
          noteId: c.noteId,
          newDeckName: c.deckName,
          currentDeckName: c.deckName,
          fields: { [targetKey]: updatedHtml }
        });
      }
      this.noteCardCache.invalidate(anchorId);
    } catch {
      // Non-blocking background backlink update
    }
  }

  private getOpenStudioViews(): AnkiStudioView[] {
    return this.app.workspace
      .getLeavesOfType(ANKI_STUDIO_VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is AnkiStudioView => v instanceof AnkiStudioView);
  }

  private notifyAllViewsStatusChanged(): void {
    this.updateStatusBar();
    for (const v of this.getOpenStudioViews()) {
      v.refreshStatusAndQueue();
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.createSpan({
      cls: `ad-status-dot ${this.ankiOnline ? "is-online" : "is-offline"}`
    });
    const qLen = this.settings.pendingQueue.length;
    const text = qLen > 0 ? `Anki (${qLen})` : "Anki";
    this.statusBarEl.createSpan({ text });
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<AnkiDispatchSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    this.settings.cachedModels = Object.assign({}, DEFAULT_MODELS, this.settings.cachedModels ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
