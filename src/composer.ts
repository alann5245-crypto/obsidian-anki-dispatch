import { setIcon, type TFile } from "obsidian";
import {
  ankiHtmlToEditableText,
  appendSourceFooter,
  buildObsidianDeepLink,
  buildSourceTag,
  DEFAULT_MODELS,
  markdownToAnkiHtml,
  normalizeDeckPath,
  rankDecksFuzzy,
  renderClozePreviewHtml,
  resolveSmartDefaultDeck,
  wrapNextCloze,
  type AnkiDispatchSettings,
  type AnkiNoteSummary,
  type QueuedMediaRef
} from "./core";
import { checkDuplicateFront } from "./anki";

export interface ComposerHostBridge {
  getSettings(): AnkiDispatchSettings;
  isAnkiOnline(): boolean;
  getActiveFile(): TFile | null;
  getNoteAnchorId(file: TFile, createIfMissing: boolean): Promise<string | null>;
  togglePinDeck(deckName: string): Promise<void>;
  ensureModelFieldsLoaded(modelName: string): Promise<string[]>;
  handlePastedImage(file: File): Promise<{ filename: string; queuedRef?: QueuedMediaRef }>;
  dispatchCard(payload: {
    editingNoteId: number | null;
    previousDeckName?: string;
    deckName: string;
    modelName: string;
    fieldsHtml: Record<string, string>;
    extraTags: string[];
    mediaRefs: QueuedMediaRef[];
    targetFile: TFile | null;
  }): Promise<{ status: "added" | "updated" | "queued"; noteId?: number }>;
}

export interface CardComposerOptions {
  surface: "sidebar" | "modal";
  initialContextText?: string;
  initialClozeMode?: boolean;
  onSubmitted?: (result: { status: "added" | "updated" | "queued"; rapidFire: boolean }) => void;
}

export class CardComposer {
  private containerEl: HTMLElement;
  private host: ComposerHostBridge;
  private opts: CardComposerOptions;

  private contextText = "";
  private selectedDeck = "Default";
  private selectedModel = "Basic";
  private editingCard: AnkiNoteSummary | null = null;
  private previewMode = false;
  private clozePreviewRevealed = false;
  private rapidFire = true;
  private queuedMediaRefs: QueuedMediaRef[] = [];

  // DOM refs
  private contextWrapEl!: HTMLElement;
  private contextQuoteEl!: HTMLElement;
  private deckInputEl!: HTMLInputElement;
  private deckDropdownEl!: HTMLElement;
  private fieldsWrapEl!: HTMLElement;
  private previewWrapEl!: HTMLElement;
  private tagsInputEl!: HTMLInputElement;
  private dupHintEl!: HTMLElement;
  private feedbackEl!: HTMLElement;
  private submitBtnEl!: HTMLButtonElement;
  private submitLabelEl!: HTMLElement;
  private cancelEditBtnEl!: HTMLButtonElement;
  private modeBadgeEl!: HTMLElement;
  private customModelSelectEl!: HTMLSelectElement;
  private tabBtns: Map<string, HTMLButtonElement> = new Map();

  private fieldInputs: Map<string, HTMLTextAreaElement | HTMLInputElement> = new Map();
  private focusedFieldEl: HTMLTextAreaElement | HTMLInputElement | null = null;
  private dropdownOptions: Array<{ deckName: string; isCreate: boolean }> = [];
  private activeOptionIdx = 0;
  private dupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(containerEl: HTMLElement, host: ComposerHostBridge, opts: CardComposerOptions) {
    this.containerEl = containerEl;
    this.host = host;
    this.opts = opts;
    this.contextText = (opts.initialContextText ?? "").trim();
    this.selectedModel = opts.initialClozeMode
      ? "Cloze"
      : host.getSettings().defaultModel || "Basic";
  }

  async mount(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass("ad-composer");

    await this.syncDefaultDeckForActiveNote();

    // 1. Reference Context Box (Anti-Collector's Fallacy)
    this.contextWrapEl = this.containerEl.createDiv({ cls: "ad-context-box" });
    const ctxHead = this.contextWrapEl.createDiv({ cls: "ad-context-head" });
    const ctxTitle = ctxHead.createDiv({ cls: "ad-context-title" });
    const quoteIcon = ctxTitle.createSpan({ cls: "ad-icon-inline" });
    setIcon(quoteIcon, "quote");
    ctxTitle.createSpan({ text: "Reference context (reformulate in your own words)" });

    const ctxActions = ctxHead.createDiv({ cls: "ad-context-actions" });
    const toClozeBtn = ctxActions.createEl("button", {
      type: "button",
      cls: "ad-link-btn",
      text: "Send to Cloze"
    });
    toClozeBtn.addEventListener("click", () => {
      if (!this.contextText) return;
      void this.switchModel("Cloze", { Text: this.contextText });
    });

    const clearCtxBtn = ctxActions.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Dismiss reference context", title: "Dismiss context" }
    });
    setIcon(clearCtxBtn, "x");
    clearCtxBtn.addEventListener("click", () => this.setReferenceContext(""));

    this.contextQuoteEl = this.contextWrapEl.createDiv({ cls: "ad-context-quote" });
    this.refreshContextBox();

    // 2. Raycast-Grade Fuzzy Deck Combobox
    const deckGroup = this.containerEl.createDiv({ cls: "ad-field-group ad-deck-combo" });
    const deckLabelRow = deckGroup.createDiv({ cls: "ad-label-row" });
    deckLabelRow.createEl("label", {
      cls: "ad-label",
      text: "Target Anki Deck"
    });
    deckLabelRow.createSpan({
      cls: "ad-hint",
      text: "Type A::B to create"
    });

    const deckInputShell = deckGroup.createDiv({ cls: "ad-deck-shell" });
    const folderIcon = deckInputShell.createSpan({ cls: "ad-icon-inline ad-teal" });
    setIcon(folderIcon, "folder-tree");

    this.deckInputEl = deckInputShell.createEl("input", {
      type: "text",
      cls: "ad-deck-input",
      value: this.selectedDeck,
      placeholder: "Fuzzy search deck or type Parent::Child::New...",
      attr: {
        role: "combobox",
        autocomplete: "off",
        "aria-expanded": "false"
      }
    });

    const clearDeckBtn = deckInputShell.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Search or switch deck", title: "Search decks" }
    });
    setIcon(clearDeckBtn, "search");
    clearDeckBtn.addEventListener("click", () => {
      this.deckInputEl.select();
      this.deckInputEl.focus();
      this.openDeckDropdown(this.deckInputEl.value === this.selectedDeck ? "" : this.deckInputEl.value);
    });

    this.deckDropdownEl = deckGroup.createDiv({
      cls: "ad-deck-dropdown",
      attr: { role: "listbox" }
    });

    this.wireDeckComboboxEvents(deckGroup);

    // 3. Note Type Segmented Tabs + Dynamic Custom Model Select
    const modelGroup = this.containerEl.createDiv({ cls: "ad-field-group" });
    const modelLabelRow = modelGroup.createDiv({ cls: "ad-label-row" });
    modelLabelRow.createSpan({ cls: "ad-label", text: "Note Type" });

    const previewToggleBtn = modelLabelRow.createEl("button", {
      type: "button",
      cls: "ad-chip-btn",
      attr: { "aria-pressed": "false", title: "Preview rendered Anki card" }
    });
    const eyeSpan = previewToggleBtn.createSpan({ cls: "ad-icon-inline" });
    setIcon(eyeSpan, "eye");
    const eyeText = previewToggleBtn.createSpan({ text: "Preview" });
    previewToggleBtn.addEventListener("click", () => {
      this.previewMode = !this.previewMode;
      previewToggleBtn.setAttribute("aria-pressed", String(this.previewMode));
      previewToggleBtn.toggleClass("is-active", this.previewMode);
      eyeText.setText(this.previewMode ? "Edit fields" : "Preview");
      this.renderPreviewOrFields();
    });

    const typeBar = modelGroup.createDiv({ cls: "ad-type-bar", attr: { role: "tablist" } });
    const coreTabs: Array<{ model: string; label: string }> = [
      { model: "Basic", label: "Basic" },
      { model: "Basic (and reversed card)", label: "Reversed" },
      { model: "Cloze", label: "Cloze" }
    ];

    this.tabBtns.clear();
    for (const tab of coreTabs) {
      const btn = typeBar.createEl("button", {
        type: "button",
        cls: "ad-type-tab",
        text: tab.label,
        attr: { role: "tab", "aria-selected": String(this.selectedModel === tab.model) }
      });
      btn.addEventListener("click", () => void this.switchModel(tab.model));
      this.tabBtns.set(tab.model, btn);
    }

    this.customModelSelectEl = typeBar.createEl("select", {
      cls: "ad-custom-model-select",
      attr: { "aria-label": "Select custom Anki Note Type" }
    });
    this.populateCustomModelDropdown();
    this.customModelSelectEl.addEventListener("change", () => {
      if (this.customModelSelectEl.value) {
        void this.switchModel(this.customModelSelectEl.value);
      }
    });

    // 4. Formatting & Cloze Micro-Toolbar
    const toolbar = this.containerEl.createDiv({ cls: "ad-toolbar" });
    const toolsLeft = toolbar.createDiv({ cls: "ad-tools-left" });

    const clozeBtn = toolsLeft.createEl("button", {
      type: "button",
      cls: "ad-chip-btn",
      attr: { title: "Wrap selection in {{c1::...}} (Ctrl/Cmd+Shift+C)" }
    });
    const bracesIcon = clozeBtn.createSpan({ cls: "ad-icon-inline" });
    setIcon(bracesIcon, "braces");
    clozeBtn.createSpan({ text: "Cloze {{c1}}" });
    clozeBtn.addEventListener("click", () => this.applyClozeToFocusedField(false));

    const mathBtn = toolsLeft.createEl("button", {
      type: "button",
      cls: "ad-chip-btn",
      text: "Math $x$",
      attr: { title: "Insert LaTeX math (auto-converted to Anki MathJax)" }
    });
    mathBtn.addEventListener("click", () => this.wrapSelectionInFocusedField("$", "$", "x^2"));

    const codeBtn = toolsLeft.createEl("button", {
      type: "button",
      cls: "ad-chip-btn",
      text: "Code",
      attr: { title: "Wrap inline code" }
    });
    codeBtn.addEventListener("click", () => this.wrapSelectionInFocusedField("`", "`", "code"));

    this.dupHintEl = toolbar.createDiv({ cls: "ad-dup-hint" });

    // 5. Dynamic Fields + Live Preview Flipper Container
    this.fieldsWrapEl = this.containerEl.createDiv({ cls: "ad-fields-wrap" });
    this.previewWrapEl = this.containerEl.createDiv({ cls: "ad-preview-wrap is-hidden" });

    await this.renderDynamicFields(
      this.opts.initialClozeMode && this.contextText ? { Text: this.contextText } : undefined
    );

    // 6. Optional Tags Row
    const tagsRow = this.containerEl.createDiv({ cls: "ad-tags-row" });
    const tagIcon = tagsRow.createSpan({ cls: "ad-icon-inline" });
    setIcon(tagIcon, "tag");
    this.tagsInputEl = tagsRow.createEl("input", {
      type: "text",
      cls: "ad-tags-input",
      placeholder: "Extra Anki tags (space-separated, optional)..."
    });

    // 7. Accessible Inline Feedback Banner
    this.feedbackEl = this.containerEl.createDiv({
      cls: "ad-feedback is-hidden",
      attr: { role: "alert", tabindex: "-1" }
    });

    // 8. Submit Action Row
    const footer = this.containerEl.createDiv({ cls: "ad-composer-footer" });
    const footerLeft = footer.createDiv({ cls: "ad-footer-left" });
    this.modeBadgeEl = footerLeft.createSpan({
      cls: "ad-subtle-note",
      text: this.opts.surface === "modal" ? "Ctrl/Cmd+Enter to submit" : "100% pure .md note"
    });

    if (this.opts.surface === "modal") {
      const rapidWrap = footerLeft.createEl("label", { cls: "ad-rapid-toggle" });
      const rapidChk = rapidWrap.createEl("input", { type: "checkbox" });
      rapidChk.checked = this.rapidFire;
      rapidChk.addEventListener("change", () => {
        this.rapidFire = rapidChk.checked;
      });
      rapidWrap.createSpan({ text: "Rapid-fire" });
    }

    const footerActions = footer.createDiv({ cls: "ad-footer-actions" });
    this.cancelEditBtnEl = footerActions.createEl("button", {
      type: "button",
      cls: "ad-btn ad-btn-secondary is-hidden",
      text: "Cancel"
    });
    this.cancelEditBtnEl.addEventListener("click", () => void this.resetFormState());

    this.submitBtnEl = footerActions.createEl("button", {
      type: "button",
      cls: "ad-btn ad-btn-cta"
    });
    const sendIcon = this.submitBtnEl.createSpan({ cls: "ad-icon-inline" });
    setIcon(sendIcon, "send");
    this.submitLabelEl = this.submitBtnEl.createSpan({
      text: this.host.isAnkiOnline() ? "Add to Anki" : "Save to Queue"
    });
    this.submitBtnEl.addEventListener("click", () => void this.submit());

    // Keyboard shortcuts inside composer
    this.containerEl.addEventListener("keydown", (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "c") {
        ev.preventDefault();
        this.applyClozeToFocusedField(ev.altKey);
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
        ev.preventDefault();
        void this.submit();
      }
    });
  }

  setReferenceContext(text: string, switchToCloze = false): void {
    this.contextText = text.trim();
    this.refreshContextBox();
    if (switchToCloze && this.contextText) {
      void this.switchModel("Cloze", { Text: this.contextText });
    }
  }

  refreshOnlineState(): void {
    if (!this.submitLabelEl) return;
    if (this.editingCard) {
      this.submitLabelEl.setText("Update Card");
    } else {
      this.submitLabelEl.setText(this.host.isAnkiOnline() ? "Add to Anki" : "Save to Queue");
    }
    this.populateCustomModelDropdown();
  }

  async syncDefaultDeckForActiveNote(): Promise<void> {
    if (this.editingCard) return;
    const file = this.host.getActiveFile();
    const anchor = file ? await this.host.getNoteAnchorId(file, false) : null;
    const resolved = resolveSmartDefaultDeck({
      noteAnchorId: anchor,
      filePath: file?.path ?? null,
      settings: this.host.getSettings()
    });
    this.selectedDeck = resolved.deckName;
    if (this.deckInputEl) {
      this.deckInputEl.value = this.selectedDeck;
    }
  }

  async loadCardForEdit(card: AnkiNoteSummary): Promise<void> {
    this.editingCard = card;
    this.previewMode = false;
    this.selectedDeck = card.deckName;
    if (this.deckInputEl) this.deckInputEl.value = card.deckName;

    const editablePrefill: Record<string, string> = {};
    for (const [k, htmlVal] of Object.entries(card.fields)) {
      editablePrefill[k] = ankiHtmlToEditableText(htmlVal);
    }

    await this.switchModel(card.modelName, editablePrefill);
    const userTags = card.tags.filter((t) => !t.startsWith("obs-src::") && t !== "obsidian-dispatch");
    if (this.tagsInputEl) this.tagsInputEl.value = userTags.join(" ");

    this.cancelEditBtnEl.removeClass("is-hidden");
    this.submitLabelEl.setText("Update Card");
    this.modeBadgeEl.setText(`Editing #${card.noteId}`);
    this.focusFirstField();
  }

  focusFirstField(): void {
    const first = this.fieldInputs.values().next().value as HTMLElement | undefined;
    first?.focus();
  }

  applyClozeCommand(sameIndex = false): void {
    this.applyClozeToFocusedField(sameIndex);
  }

  private refreshContextBox(): void {
    if (!this.contextWrapEl) return;
    if (!this.contextText) {
      this.contextWrapEl.addClass("is-hidden");
      return;
    }
    this.contextWrapEl.removeClass("is-hidden");
    this.contextQuoteEl.setText(this.contextText);
  }

  private populateCustomModelDropdown(): void {
    if (!this.customModelSelectEl) return;
    const allModels = Object.keys(this.host.getSettings().cachedModels);
    const customModels = allModels.filter(
      (m) => m !== "Basic" && m !== "Basic (and reversed card)" && m !== "Cloze"
    );

    this.customModelSelectEl.empty();
    this.customModelSelectEl.createEl("option", {
      value: "",
      text: customModels.length > 0 ? `More (${customModels.length})...` : "More..."
    });
    for (const m of customModels) {
      const opt = this.customModelSelectEl.createEl("option", { value: m, text: m });
      if (this.selectedModel === m) opt.selected = true;
    }
    this.customModelSelectEl.toggleClass("is-active", customModels.includes(this.selectedModel));
  }

  private async switchModel(modelName: string, prefill?: Record<string, string>): Promise<void> {
    const prevPrimary = this.getFirstFieldValue();
    this.selectedModel = modelName;

    for (const [m, btn] of this.tabBtns.entries()) {
      btn.setAttribute("aria-selected", String(m === modelName));
    }
    this.populateCustomModelDropdown();

    const mergedPrefill = prefill ?? (prevPrimary ? { __carryPrimary: prevPrimary } : undefined);
    await this.renderDynamicFields(mergedPrefill);
    if (this.previewMode) this.renderPreviewOrFields();
  }

  private async renderDynamicFields(prefill?: Record<string, string>): Promise<void> {
    const fieldNames = await this.host.ensureModelFieldsLoaded(this.selectedModel);
    const effectiveFields = fieldNames.length > 0
      ? fieldNames
      : (DEFAULT_MODELS[this.selectedModel] ?? ["Front", "Back"]);

    this.fieldsWrapEl.empty();
    this.fieldInputs.clear();

    effectiveFields.forEach((fieldName, idx) => {
      const group = this.fieldsWrapEl.createDiv({ cls: "ad-field-group" });
      group.createEl("label", {
        cls: "ad-label",
        text: this.formatFieldLabel(fieldName, idx)
      });

      const initialVal =
        prefill?.[fieldName] ??
        (idx === 0 && prefill?.__carryPrimary ? prefill.__carryPrimary : "");

      const useCompactInput = effectiveFields.length > 2 && idx >= 2;
      const inputEl = useCompactInput
        ? group.createEl("input", {
            type: "text",
            cls: "ad-input",
            value: initialVal,
            placeholder: this.getPlaceholder(fieldName, idx)
          })
        : group.createEl("textarea", {
            cls: "ad-textarea",
            placeholder: this.getPlaceholder(fieldName, idx)
          });

      if (!useCompactInput) {
        (inputEl as HTMLTextAreaElement).value = initialVal;
      }

      inputEl.addEventListener("focus", () => {
        this.focusedFieldEl = inputEl;
      });

      if (idx === 0) {
        this.focusedFieldEl = inputEl;
        inputEl.addEventListener("input", () => this.scheduleDuplicateCheck(fieldName, inputEl.value));
      }

      // Ctrl+V screenshot paste handler
      inputEl.addEventListener("paste", (ev: ClipboardEvent) => {
        const items = ev.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith("image/")) {
            const blob = item.getAsFile();
            if (blob) {
              ev.preventDefault();
              void this.insertPastedImage(inputEl, blob);
              break;
            }
          }
        }
      });

      this.fieldInputs.set(fieldName, inputEl);
    });
  }

  private formatFieldLabel(fieldName: string, idx: number): string {
    if (this.selectedModel === "Basic" && fieldName === "Front") return "Front (Prompt)";
    if (this.selectedModel === "Basic" && fieldName === "Back") return "Back (Atomic Answer)";
    if (this.selectedModel === "Cloze" && fieldName === "Text") return "Text (with {{c1::...}} deletions)";
    return idx === 0 ? `${fieldName} *` : fieldName;
  }

  private getPlaceholder(fieldName: string, idx: number): string {
    if (this.selectedModel === "Cloze" && idx === 0) {
      return "Select keywords and press Ctrl/Cmd+Shift+C to wrap {{c1::...}}";
    }
    if (idx === 0) return "Write a concise retrieval prompt in your own words...";
    if (idx === 1) return "One atomic fact (supports $LaTeX$, `code`, and Ctrl+V images)...";
    return `Enter ${fieldName}...`;
  }

  private getFirstFieldValue(): string {
    const first = this.fieldInputs.values().next().value as HTMLTextAreaElement | HTMLInputElement | undefined;
    return first?.value ?? "";
  }

  private renderPreviewOrFields(): void {
    if (!this.previewMode) {
      this.previewWrapEl.addClass("is-hidden");
      this.fieldsWrapEl.removeClass("is-hidden");
      return;
    }

    this.fieldsWrapEl.addClass("is-hidden");
    this.previewWrapEl.removeClass("is-hidden");
    this.previewWrapEl.empty();

    const entries = Array.from(this.fieldInputs.entries());
    const primaryRaw = entries[0]?.[1]?.value ?? "";
    const secondaryRaw = entries[1]?.[1]?.value ?? "";

    const cardSurface = this.previewWrapEl.createDiv({ cls: "ad-preview-card" });
    const head = cardSurface.createDiv({ cls: "ad-preview-head" });
    head.createSpan({ cls: "ad-preview-badge", text: `${this.selectedModel} · ${this.selectedDeck}` });

    if (this.selectedModel === "Cloze" || /\{\{c\d+::/.test(primaryRaw)) {
      const revealBtn = head.createEl("button", {
        type: "button",
        cls: "ad-link-btn",
        text: this.clozePreviewRevealed ? "Hide [...]" : "Reveal Cloze"
      });
      revealBtn.addEventListener("click", () => {
        this.clozePreviewRevealed = !this.clozePreviewRevealed;
        this.renderPreviewOrFields();
      });

      const frontFace = cardSurface.createDiv({ cls: "ad-preview-face" });
      frontFace.innerHTML = renderClozePreviewHtml(primaryRaw || "(Empty Cloze text)", this.clozePreviewRevealed);
      if (secondaryRaw.trim() && this.clozePreviewRevealed) {
        const extra = cardSurface.createDiv({ cls: "ad-preview-back" });
        extra.innerHTML = markdownToAnkiHtml(secondaryRaw);
      }
    } else {
      const frontFace = cardSurface.createDiv({ cls: "ad-preview-face" });
      frontFace.innerHTML = markdownToAnkiHtml(primaryRaw || "(Empty front)");
      const backFace = cardSurface.createDiv({ cls: "ad-preview-back" });
      backFace.innerHTML = markdownToAnkiHtml(secondaryRaw || "(Empty back)");
    }
  }

  private applyClozeToFocusedField(sameIndex: boolean): void {
    const run = async () => {
      if (this.selectedModel !== "Cloze") {
        await this.switchModel("Cloze");
      }
      const target = this.focusedFieldEl ?? (this.fieldInputs.values().next().value as HTMLTextAreaElement | undefined);
      if (!target) return;

      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const res = wrapNextCloze(target.value, start, end, sameIndex);
      target.value = res.text;
      target.focus();
      target.setSelectionRange(res.cursorEnd, res.cursorEnd);
      if (this.previewMode) this.renderPreviewOrFields();
    };
    void run();
  }

  private wrapSelectionInFocusedField(prefix: string, suffix: string, fallback: string): void {
    const target = this.focusedFieldEl ?? (this.fieldInputs.values().next().value as HTMLTextAreaElement | undefined);
    if (!target) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const inner = target.value.slice(start, end) || fallback;
    const replacement = `${prefix}${inner}${suffix}`;
    target.value = target.value.slice(0, start) + replacement + target.value.slice(end);
    target.focus();
    const cursor = start + replacement.length;
    target.setSelectionRange(cursor, cursor);
  }

  private async insertPastedImage(target: HTMLTextAreaElement | HTMLInputElement, file: File): Promise<void> {
    try {
      const saved = await this.host.handlePastedImage(file);
      if (saved.queuedRef) this.queuedMediaRefs.push(saved.queuedRef);
      const imgTag = `<img src="${saved.filename}">`;
      const pos = target.selectionStart ?? target.value.length;
      target.value = target.value.slice(0, pos) + imgTag + target.value.slice(pos);
      this.showFeedback("success", `Attached image ${saved.filename}`);
    } catch (err) {
      this.showFeedback("error", `Failed to attach pasted image: ${(err as Error).message}`);
    }
  }

  private scheduleDuplicateCheck(fieldName: string, value: string): void {
    if (this.dupTimer) clearTimeout(this.dupTimer);
    this.dupHintEl.setText("");
    if (this.editingCard || !this.host.isAnkiOnline() || value.trim().length < 5) return;

    this.dupTimer = setTimeout(async () => {
      const count = await checkDuplicateFront(this.host.getSettings().ankiConnectUrl, fieldName, value);
      if (count > 0) {
        this.dupHintEl.setText(`Duplicate front (${count} in Anki)`);
      } else {
        this.dupHintEl.setText("");
      }
    }, 380);
  }

  private wireDeckComboboxEvents(wrapperEl: HTMLElement): void {
    this.deckInputEl.addEventListener("focus", () => {
      this.openDeckDropdown("");
    });

    this.deckInputEl.addEventListener("input", () => {
      this.openDeckDropdown(this.deckInputEl.value);
    });

    this.deckInputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
      const isOpen = this.deckDropdownEl.hasClass("is-open");
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!isOpen) this.openDeckDropdown(this.deckInputEl.value);
        else this.moveActiveDeckOption(1);
      } else if (ev.key === "ArrowUp" && isOpen) {
        ev.preventDefault();
        this.moveActiveDeckOption(-1);
      } else if (ev.key === "Enter" && isOpen) {
        ev.preventDefault();
        ev.stopPropagation();
        const chosen = this.dropdownOptions[this.activeOptionIdx];
        if (chosen) this.commitDeckChoice(chosen.deckName);
        else if (this.deckInputEl.value.trim()) {
          this.commitDeckChoice(normalizeDeckPath(this.deckInputEl.value));
        }
      } else if (ev.key === "Escape" && isOpen) {
        ev.preventDefault();
        ev.stopPropagation();
        this.deckInputEl.value = this.selectedDeck;
        this.closeDeckDropdown();
      }
    });

    this.deckInputEl.addEventListener("blur", () => {
      setTimeout(() => {
        if (!wrapperEl.contains(document.activeElement)) {
          const typed = normalizeDeckPath(this.deckInputEl.value);
          if (typed) this.selectedDeck = typed;
          this.deckInputEl.value = this.selectedDeck;
          this.closeDeckDropdown();
        }
      }, 150);
    });
  }

  private openDeckDropdown(query: string): void {
    const settings = this.host.getSettings();
    const file = this.host.getActiveFile();
    const folderDeck = file
      ? resolveSmartDefaultDeck({ noteAnchorId: null, filePath: file.path, settings })
      : null;

    const ranked = rankDecksFuzzy({
      query,
      decks: settings.cachedDecks,
      noteDefaultDeck: this.selectedDeck,
      folderDefaultDeck: folderDeck?.reason === "folder" ? folderDeck.deckName : undefined,
      pinnedDecks: settings.pinnedDecks,
      recentDecks: settings.recentDecks
    });

    this.deckDropdownEl.empty();
    this.dropdownOptions = [];
    this.activeOptionIdx = 0;

    const badgeLabels: Record<string, string> = {
      note: "Selected",
      folder: "Folder rule",
      pinned: "Pinned",
      recent: "Recent"
    };

    ranked.options.slice(0, 30).forEach((opt, idx) => {
      this.dropdownOptions.push({ deckName: opt.deckName, isCreate: false });
      const row = this.deckDropdownEl.createDiv({
        cls: `ad-deck-opt ${idx === 0 ? "is-active" : ""}`,
        attr: { role: "option", title: opt.deckName }
      });

      const selectBtn = row.createEl("button", { type: "button", cls: "ad-deck-opt-main" });
      const pathSpan = selectBtn.createSpan({ cls: "ad-deck-path" });
      if (opt.parentBreadcrumb) {
        pathSpan.createSpan({ cls: "ad-deck-parent", text: opt.parentBreadcrumb });
      }
      pathSpan.createSpan({ cls: "ad-deck-leaf", text: opt.leafName });

      if (opt.badge && badgeLabels[opt.badge]) {
        selectBtn.createSpan({ cls: "ad-deck-badge", text: badgeLabels[opt.badge] });
      }

      selectBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commitDeckChoice(opt.deckName);
      });

      const pinBtn = row.createEl("button", {
        type: "button",
        cls: `ad-pin-btn ${opt.isPinned ? "is-pinned" : ""}`,
        attr: {
          "aria-label": opt.isPinned ? `Unpin ${opt.deckName}` : `Pin ${opt.deckName}`,
          title: opt.isPinned ? "Unpin deck" : "Pin deck to top"
        }
      });
      setIcon(pinBtn, "star");
      pinBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.host.togglePinDeck(opt.deckName).then(() => {
          this.openDeckDropdown(this.deckInputEl.value === this.selectedDeck ? "" : this.deckInputEl.value);
        });
      });
    });

    if (ranked.canCreateNew) {
      const createIdx = this.dropdownOptions.length;
      const newDeck = ranked.canCreateNew;
      this.dropdownOptions.push({ deckName: newDeck, isCreate: true });
      const createRow = this.deckDropdownEl.createEl("button", {
        type: "button",
        cls: `ad-deck-opt ad-deck-create ${createIdx === 0 ? "is-active" : ""}`,
        attr: { role: "option" }
      });
      const plusIcon = createRow.createSpan({ cls: "ad-icon-inline ad-teal" });
      setIcon(plusIcon, "plus-circle");
      createRow.createSpan({
        cls: "ad-deck-path",
        text: `Create new subdeck: "${newDeck}"`
      });
      createRow.createSpan({ cls: "ad-deck-badge is-create", text: "New" });
      createRow.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commitDeckChoice(newDeck);
      });
    }

    this.deckDropdownEl.addClass("is-open");
    this.deckInputEl.setAttribute("aria-expanded", "true");
  }

  private moveActiveDeckOption(delta: number): void {
    const total = this.dropdownOptions.length;
    if (total === 0) return;
    this.activeOptionIdx = (this.activeOptionIdx + delta + total) % total;
    const rows = Array.from(this.deckDropdownEl.children) as HTMLElement[];
    rows.forEach((r, idx) => {
      r.toggleClass("is-active", idx === this.activeOptionIdx);
      if (idx === this.activeOptionIdx) r.scrollIntoView({ block: "nearest" });
    });
  }

  private commitDeckChoice(deckName: string): void {
    const clean = normalizeDeckPath(deckName) || "Default";
    this.selectedDeck = clean;
    this.deckInputEl.value = clean;
    this.closeDeckDropdown();
  }

  private closeDeckDropdown(): void {
    this.deckDropdownEl?.removeClass("is-open");
    this.deckInputEl?.setAttribute("aria-expanded", "false");
  }

  private async submit(): Promise<void> {
    const deckName = normalizeDeckPath(this.deckInputEl.value || this.selectedDeck);
    if (!deckName) {
      this.showFeedback("error", "Please select or enter a target Anki deck.");
      this.deckInputEl.focus();
      return;
    }
    this.selectedDeck = deckName;

    const entries = Array.from(this.fieldInputs.entries());
    const primaryEntry = entries[0];
    if (!primaryEntry || !primaryEntry[1].value.trim()) {
      this.showFeedback("error", `Field "${primaryEntry?.[0] ?? "Front"}" cannot be empty.`);
      primaryEntry?.[1]?.focus();
      return;
    }

    const fieldsHtml: Record<string, string> = {};
    for (const [k, input] of entries) {
      fieldsHtml[k] = markdownToAnkiHtml(input.value);
    }

    const extraTags = this.tagsInputEl.value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    this.submitBtnEl.disabled = true;
    try {
      const targetFile = this.host.getActiveFile();
      const editingNoteId = this.editingCard?.noteId ?? null;
      const previousDeckName = this.editingCard?.deckName;

      const res = await this.host.dispatchCard({
        editingNoteId,
        previousDeckName,
        deckName,
        modelName: this.selectedModel,
        fieldsHtml,
        extraTags,
        mediaRefs: [...this.queuedMediaRefs],
        targetFile
      });

      const wasEditing = Boolean(editingNoteId);
      await this.resetFormState(true);

      if (res.status === "updated") {
        this.showFeedback("success", `Updated card in "${deckName}".`);
      } else if (res.status === "added") {
        this.showFeedback("success", `Added card to "${deckName}".`);
      } else {
        this.showFeedback("success", `Anki offline: Queued card for "${deckName}".`);
      }

      this.opts.onSubmitted?.({
        status: res.status,
        rapidFire: !wasEditing && this.rapidFire
      });
    } catch (err) {
      this.showFeedback("error", `Dispatch failed: ${(err as Error).message}`);
    } finally {
      this.submitBtnEl.disabled = false;
    }
  }

  private async resetFormState(keepDeckAndModel = false): Promise<void> {
    this.editingCard = null;
    this.queuedMediaRefs = [];
    this.previewMode = false;
    this.clozePreviewRevealed = false;
    this.dupHintEl.setText("");

    if (!keepDeckAndModel) {
      await this.syncDefaultDeckForActiveNote();
    }

    for (const input of this.fieldInputs.values()) {
      input.value = "";
    }
    this.previewWrapEl.addClass("is-hidden");
    this.fieldsWrapEl.removeClass("is-hidden");
    this.cancelEditBtnEl.addClass("is-hidden");
    this.refreshOnlineState();
    this.modeBadgeEl.setText(this.opts.surface === "modal" ? "Ctrl/Cmd+Enter to submit" : "100% pure .md note");
    this.focusFirstField();
  }

  private showFeedback(kind: "success" | "error", message: string): void {
    this.feedbackEl.removeClass("is-hidden", "is-success", "is-error");
    this.feedbackEl.addClass(kind === "success" ? "is-success" : "is-error");
    this.feedbackEl.setText(message);
    if (kind === "error") this.feedbackEl.focus();
  }
}

export function injectBacklinkIntoCardFields(params: {
  fieldsHtml: Record<string, string>;
  vaultName: string;
  filePath: string;
  fileBasename: string;
}): Record<string, string> {
  const keys = Object.keys(params.fieldsHtml);
  if (keys.length === 0) return params.fieldsHtml;
  const targetKey = keys.length >= 2 ? keys[1] : keys[0];
  const deepLink = buildObsidianDeepLink(params.vaultName, params.filePath);
  return {
    ...params.fieldsHtml,
    [targetKey]: appendSourceFooter(params.fieldsHtml[targetKey] ?? "", deepLink, params.fileBasename)
  };
}

export function buildCardTags(anchorId: string | null, extraTags: string[]): string[] {
  const set = new Set<string>(["obsidian-dispatch", ...extraTags]);
  if (anchorId) set.add(buildSourceTag(anchorId));
  return Array.from(set);
}
