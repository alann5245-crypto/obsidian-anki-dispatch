import { setIcon, setTooltip, type TFile } from "obsidian";
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
  private contextExpanded = false;
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
  private previewToggleBtnEl!: HTMLButtonElement;
  private customModelSelectEl!: HTMLSelectElement;
  private tabBtns: Map<string, HTMLButtonElement> = new Map();

  private fieldInputs: Map<string, HTMLTextAreaElement | HTMLInputElement> = new Map();
  private focusedFieldEl: HTMLTextAreaElement | HTMLInputElement | null = null;
  private dropdownOptions: Array<{ deckName: string; isCreate: boolean }> = [];
  private activeOptionIdx = 0;
  private dupTimer: ReturnType<typeof setTimeout> | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;

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

    // 1. Minimal 2-Line Quote Strip (Zero prose instructions; icon actions only)
    this.contextWrapEl = this.containerEl.createDiv({ cls: "ad-quote-strip" });
    this.contextQuoteEl = this.contextWrapEl.createDiv({ cls: "ad-quote-text" });
    this.contextQuoteEl.addEventListener("click", () => {
      this.contextExpanded = !this.contextExpanded;
      this.contextQuoteEl.toggleClass("is-expanded", this.contextExpanded);
    });

    const ctxActions = this.contextWrapEl.createDiv({ cls: "ad-quote-actions" });
    const toClozeBtn = ctxActions.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Insert quote as Cloze" }
    });
    setIcon(toClozeBtn, "braces");
    setTooltip(toClozeBtn, "Send to Cloze");
    toClozeBtn.addEventListener("click", () => {
      if (!this.contextText) return;
      void this.switchModel("Cloze", { Text: this.contextText });
    });

    const clearCtxBtn = ctxActions.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Dismiss quote" }
    });
    setIcon(clearCtxBtn, "x");
    setTooltip(clearCtxBtn, "Dismiss");
    clearCtxBtn.addEventListener("click", () => this.setReferenceContext(""));
    this.refreshContextBox();

    // 2. DECK — Minimal Labeled Fuzzy Combobox
    const deckGroup = this.containerEl.createDiv({ cls: "ad-field-group ad-deck-combo" });
    deckGroup.createEl("label", { cls: "ad-micro-label", text: "DECK" });

    const deckInputShell = deckGroup.createDiv({ cls: "ad-deck-shell" });
    const folderIcon = deckInputShell.createSpan({ cls: "ad-icon-inline ad-muted-icon" });
    setIcon(folderIcon, "folder");

    this.deckInputEl = deckInputShell.createEl("input", {
      type: "text",
      cls: "ad-deck-input",
      value: this.selectedDeck,
      placeholder: "Deck...",
      attr: {
        role: "combobox",
        autocomplete: "off",
        "aria-label": "Deck",
        "aria-expanded": "false"
      }
    });

    const chevronBtn = deckInputShell.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Switch deck" }
    });
    setIcon(chevronBtn, "chevrons-up-down");
    setTooltip(chevronBtn, "Switch deck");
    chevronBtn.addEventListener("click", () => {
      this.deckInputEl.select();
      this.deckInputEl.focus();
      this.openDeckDropdown(this.deckInputEl.value === this.selectedDeck ? "" : this.deckInputEl.value);
    });

    this.deckDropdownEl = deckGroup.createDiv({
      cls: "ad-deck-dropdown",
      attr: { role: "listbox" }
    });
    this.wireDeckComboboxEvents(deckGroup);

    // 3. TYPE — Segmented Control + Compact Icon Micro-Tools on One Clean Row
    const typeGroup = this.containerEl.createDiv({ cls: "ad-field-group" });
    const typeHead = typeGroup.createDiv({ cls: "ad-label-row" });
    typeHead.createSpan({ cls: "ad-micro-label", text: "TYPE" });

    const microTools = typeHead.createDiv({ cls: "ad-micro-tools" });
    this.dupHintEl = microTools.createSpan({ cls: "ad-dup-dot" });

    const clozeBtn = microTools.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Wrap Cloze deletion" }
    });
    setIcon(clozeBtn, "braces");
    setTooltip(clozeBtn, "Cloze (Mod+Shift+C)");
    clozeBtn.addEventListener("click", () => this.applyClozeToFocusedField(false));

    const mathBtn = microTools.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Insert LaTeX math" }
    });
    setIcon(mathBtn, "sigma");
    setTooltip(mathBtn, "Math ($...$)");
    mathBtn.addEventListener("click", () => this.wrapSelectionInFocusedField("$", "$", "x"));

    const codeBtn = microTools.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Wrap inline code" }
    });
    setIcon(codeBtn, "code");
    setTooltip(codeBtn, "Code (`...`)");
    codeBtn.addEventListener("click", () => this.wrapSelectionInFocusedField("`", "`", "code"));

    this.previewToggleBtnEl = microTools.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Toggle card preview", "aria-pressed": "false" }
    });
    setIcon(this.previewToggleBtnEl, "eye");
    setTooltip(this.previewToggleBtnEl, "Preview card");
    this.previewToggleBtnEl.addEventListener("click", () => {
      this.previewMode = !this.previewMode;
      this.previewToggleBtnEl.setAttribute("aria-pressed", String(this.previewMode));
      this.previewToggleBtnEl.toggleClass("is-active", this.previewMode);
      this.renderPreviewOrFields();
    });

    const typeBar = typeGroup.createDiv({ cls: "ad-type-bar", attr: { role: "tablist" } });
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
      attr: { "aria-label": "Custom Note Type" }
    });
    this.populateCustomModelDropdown();
    this.customModelSelectEl.addEventListener("change", () => {
      if (this.customModelSelectEl.value) {
        void this.switchModel(this.customModelSelectEl.value);
      }
    });

    // 4. FRONT / BACK (or Dynamic Model Fields) + Live Preview Flipper
    this.fieldsWrapEl = this.containerEl.createDiv({ cls: "ad-fields-wrap" });
    this.previewWrapEl = this.containerEl.createDiv({ cls: "ad-preview-wrap is-hidden" });

    await this.renderDynamicFields(
      this.opts.initialClozeMode && this.contextText ? { Text: this.contextText } : undefined
    );

    // 5. TAGS — Always Visible, Clean Uppercase Micro-Label
    const tagsGroup = this.containerEl.createDiv({ cls: "ad-field-group" });
    tagsGroup.createEl("label", { cls: "ad-micro-label", text: "TAGS" });
    this.tagsInputEl = tagsGroup.createEl("input", {
      type: "text",
      cls: "ad-input",
      placeholder: "",
      attr: { "aria-label": "Tags" }
    });

    // 6. Compact Inline Status Toast
    this.feedbackEl = this.containerEl.createDiv({
      cls: "ad-feedback is-hidden",
      attr: { role: "alert", tabindex: "-1" }
    });

    // 7. Minimal Action Footer
    const footer = this.containerEl.createDiv({ cls: "ad-composer-footer" });
    const footerLeft = footer.createDiv({ cls: "ad-footer-left" });

    if (this.opts.surface === "modal") {
      const repeatBtn = footerLeft.createEl("button", {
        type: "button",
        cls: `ad-icon-toggle ${this.rapidFire ? "is-active" : ""}`,
        attr: { "aria-pressed": String(this.rapidFire), "aria-label": "Keep modal open after adding" }
      });
      const repeatIcon = repeatBtn.createSpan({ cls: "ad-icon-inline" });
      setIcon(repeatIcon, "repeat");
      repeatBtn.createSpan({ text: "Repeat" });
      setTooltip(repeatBtn, "Rapid-fire: stay open for next card");
      repeatBtn.addEventListener("click", () => {
        this.rapidFire = !this.rapidFire;
        repeatBtn.setAttribute("aria-pressed", String(this.rapidFire));
        repeatBtn.toggleClass("is-active", this.rapidFire);
      });
    }

    const footerActions = footer.createDiv({ cls: "ad-footer-actions" });
    this.cancelEditBtnEl = footerActions.createEl("button", {
      type: "button",
      cls: "ad-btn ad-btn-ghost is-hidden",
      text: "Cancel"
    });
    this.cancelEditBtnEl.addEventListener("click", () => void this.resetFormState());

    this.submitBtnEl = footerActions.createEl("button", {
      type: "button",
      cls: "ad-btn ad-btn-accent"
    });
    this.submitLabelEl = this.submitBtnEl.createSpan({
      text: this.host.isAnkiOnline() ? "Add" : "Queue"
    });
    const enterIcon = this.submitBtnEl.createSpan({ cls: "ad-icon-inline" });
    setIcon(enterIcon, "corner-down-left");
    setTooltip(this.submitBtnEl, "Submit (Mod+Enter)");
    this.submitBtnEl.addEventListener("click", () => void this.submit());

    // Composer keyboard shortcuts
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
    this.contextExpanded = false;
    this.refreshContextBox();
    if (switchToCloze && this.contextText) {
      void this.switchModel("Cloze", { Text: this.contextText });
    }
  }

  refreshOnlineState(): void {
    if (!this.submitLabelEl) return;
    if (this.editingCard) {
      this.submitLabelEl.setText("Save");
    } else {
      this.submitLabelEl.setText(this.host.isAnkiOnline() ? "Add" : "Queue");
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
    this.previewToggleBtnEl?.removeClass("is-active");
    this.previewToggleBtnEl?.setAttribute("aria-pressed", "false");
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
    this.submitLabelEl.setText("Save");
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
    this.contextQuoteEl.toggleClass("is-expanded", this.contextExpanded);
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
      text: customModels.length > 0 ? `More (${customModels.length})` : "More"
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
        cls: "ad-micro-label",
        text: fieldName.toUpperCase()
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
            placeholder: ""
          })
        : group.createEl("textarea", {
            cls: "ad-textarea",
            placeholder: ""
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
    head.createSpan({ cls: "ad-micro-label", text: this.selectedModel.toUpperCase() });

    if (this.selectedModel === "Cloze" || /\{\{c\d+::/.test(primaryRaw)) {
      const revealBtn = head.createEl("button", {
        type: "button",
        cls: "ad-icon-btn",
        attr: { "aria-label": this.clozePreviewRevealed ? "Hide Cloze" : "Reveal Cloze" }
      });
      setIcon(revealBtn, this.clozePreviewRevealed ? "eye-off" : "eye");
      setTooltip(revealBtn, this.clozePreviewRevealed ? "Hide answer" : "Reveal answer");
      revealBtn.addEventListener("click", () => {
        this.clozePreviewRevealed = !this.clozePreviewRevealed;
        this.renderPreviewOrFields();
      });

      const frontFace = cardSurface.createDiv({ cls: "ad-preview-face" });
      frontFace.innerHTML = renderClozePreviewHtml(primaryRaw || "—", this.clozePreviewRevealed);
      if (secondaryRaw.trim() && this.clozePreviewRevealed) {
        const extra = cardSurface.createDiv({ cls: "ad-preview-back" });
        extra.innerHTML = markdownToAnkiHtml(secondaryRaw);
      }
    } else {
      const frontFace = cardSurface.createDiv({ cls: "ad-preview-face" });
      frontFace.innerHTML = markdownToAnkiHtml(primaryRaw || "—");
      if (secondaryRaw.trim()) {
        const backFace = cardSurface.createDiv({ cls: "ad-preview-back" });
        backFace.innerHTML = markdownToAnkiHtml(secondaryRaw);
      }
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
      this.showFeedback("success", saved.filename);
    } catch (err) {
      this.showFeedback("error", (err as Error).message);
    }
  }

  private scheduleDuplicateCheck(fieldName: string, value: string): void {
    if (this.dupTimer) clearTimeout(this.dupTimer);
    this.dupHintEl.setText("");
    if (this.editingCard || !this.host.isAnkiOnline() || value.trim().length < 5) return;

    this.dupTimer = setTimeout(async () => {
      const count = await checkDuplicateFront(this.host.getSettings().ankiConnectUrl, fieldName, value);
      this.dupHintEl.setText(count > 0 ? `Duplicate (${count})` : "");
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

      selectBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commitDeckChoice(opt.deckName);
      });

      const pinBtn = row.createEl("button", {
        type: "button",
        cls: `ad-pin-btn ${opt.isPinned ? "is-pinned" : ""}`,
        attr: { "aria-label": opt.isPinned ? `Unpin ${opt.deckName}` : `Pin ${opt.deckName}` }
      });
      setIcon(pinBtn, "star");
      setTooltip(pinBtn, opt.isPinned ? "Unpin" : "Pin");
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
      const plusIcon = createRow.createSpan({ cls: "ad-icon-inline ad-accent-icon" });
      setIcon(plusIcon, "plus");
      createRow.createSpan({
        cls: "ad-deck-path",
        text: newDeck
      });
      createRow.createSpan({ cls: "ad-deck-badge", text: "New" });
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
      this.deckInputEl.focus();
      return;
    }
    this.selectedDeck = deckName;

    const entries = Array.from(this.fieldInputs.entries());
    const primaryEntry = entries[0];
    if (!primaryEntry || !primaryEntry[1].value.trim()) {
      primaryEntry?.[1]?.focus();
      return;
    }

    const fieldsHtml: Record<string, string> = {};
    for (const [k, input] of entries) {
      fieldsHtml[k] = markdownToAnkiHtml(input.value);
    }

    const extraTags = this.tagsInputEl.value
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#+/, ""))
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

      const leaf = deckName.split("::").pop() || deckName;
      if (res.status === "updated") {
        this.showFeedback("success", `Saved · ${leaf}`);
      } else if (res.status === "added") {
        this.showFeedback("success", `Added · ${leaf}`);
      } else {
        this.showFeedback("success", `Queued · ${leaf}`);
      }

      this.opts.onSubmitted?.({
        status: res.status,
        rapidFire: !wasEditing && this.rapidFire
      });
    } catch (err) {
      this.showFeedback("error", (err as Error).message);
    } finally {
      this.submitBtnEl.disabled = false;
    }
  }

  private async resetFormState(keepDeckAndModel = false): Promise<void> {
    this.editingCard = null;
    this.queuedMediaRefs = [];
    this.previewMode = false;
    this.clozePreviewRevealed = false;
    this.previewToggleBtnEl?.removeClass("is-active");
    this.previewToggleBtnEl?.setAttribute("aria-pressed", "false");
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
    this.focusFirstField();
  }

  private showFeedback(kind: "success" | "error", message: string): void {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.feedbackEl.removeClass("is-hidden", "is-success", "is-error");
    this.feedbackEl.addClass(kind === "success" ? "is-success" : "is-error");
    this.feedbackEl.setText(message);
    if (kind === "error") {
      this.feedbackEl.focus();
    } else {
      this.feedbackTimer = setTimeout(() => this.feedbackEl.addClass("is-hidden"), 2200);
    }
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
