import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import { ankiHtmlToEditableText, splitDeckHierarchy, type AnkiNoteSummary } from "./core";
import { CardComposer, type ComposerHostBridge } from "./composer";

export const ANKI_STUDIO_VIEW_TYPE = "anki-dispatch-studio-view";

export interface StudioViewBridge extends ComposerHostBridge {
  getLatencyMs(): number;
  getNoteCardsForActiveFile(forceRefresh?: boolean): Promise<AnkiNoteSummary[]>;
  deleteAnkiCard(noteId: number): Promise<void>;
  openCardInAnkiBrowser(noteId: number): Promise<void>;
  flushOfflineQueue(): Promise<{ flushed: number; remaining: number }>;
  refreshAnkiConnection(): Promise<void>;
}

export class AnkiStudioView extends ItemView {
  private bridge: StudioViewBridge;
  private composer: CardComposer | null = null;

  private statusDotEl!: HTMLElement;
  private statusLabelEl!: HTMLElement;
  private queueBannerEl!: HTMLElement;
  private queueCountEl!: HTMLElement;
  private cardsCountEl!: HTMLElement;
  private cardsListEl!: HTMLElement;
  private filterInputEl!: HTMLInputElement;
  private currentCards: AnkiNoteSummary[] = [];

  constructor(leaf: WorkspaceLeaf, bridge: StudioViewBridge) {
    super(leaf);
    this.bridge = bridge;
  }

  getViewType(): string {
    return ANKI_STUDIO_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Anki Studio";
  }

  getIcon(): string {
    return "layers";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("ad-studio-root");

    // 1. Sticky Studio Header
    const header = root.createDiv({ cls: "ad-studio-header" });
    const brand = header.createDiv({ cls: "ad-studio-brand" });
    const brandIcon = brand.createSpan({ cls: "ad-icon-inline ad-teal" });
    setIcon(brandIcon, "layers");
    brand.createSpan({ text: "Anki Studio" });

    const headerRight = header.createDiv({ cls: "ad-studio-header-right" });
    const statusBtn = headerRight.createEl("button", {
      type: "button",
      cls: "ad-status-pill",
      attr: { title: "Check AnkiConnect status & refresh decks" }
    });
    this.statusDotEl = statusBtn.createSpan({ cls: "ad-status-dot" });
    this.statusLabelEl = statusBtn.createSpan({ text: "Checking..." });
    statusBtn.addEventListener("click", () => void this.bridge.refreshAnkiConnection());

    // 2. Self-Purging Offline Queue Banner
    this.queueBannerEl = root.createDiv({ cls: "ad-queue-banner is-hidden" });
    const queueInfo = this.queueBannerEl.createDiv({ cls: "ad-queue-info" });
    this.queueCountEl = queueInfo.createEl("strong");
    queueInfo.createDiv({
      cls: "ad-queue-sub",
      text: "Auto-flushes & purges to 0 bytes when Anki connects"
    });
    const flushBtn = this.queueBannerEl.createEl("button", {
      type: "button",
      cls: "ad-btn ad-btn-primary ad-btn-sm",
      text: "Flush now"
    });
    flushBtn.addEventListener("click", () => void this.bridge.flushOfflineQueue());

    // 3. Embedded Shared CardComposer
    const composerHostEl = root.createDiv({ cls: "ad-studio-composer-wrap" });
    this.composer = new CardComposer(composerHostEl, this.bridge, {
      surface: "sidebar",
      onSubmitted: () => {
        this.refreshStatusAndQueue();
        void this.refreshNoteCards(true);
      }
    });
    await this.composer.mount();

    // 4. Linked Cards of Active Note Section
    const cardsSection = root.createDiv({ cls: "ad-cards-section" });
    const sectionHead = cardsSection.createDiv({ cls: "ad-section-head" });
    const titleWrap = sectionHead.createDiv({ cls: "ad-section-title-wrap" });
    titleWrap.createSpan({ cls: "ad-section-title", text: "Cards from this note" });
    this.cardsCountEl = titleWrap.createSpan({ cls: "ad-count-pill", text: "0" });

    const reloadBtn = sectionHead.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Refresh cards for active note", title: "Refresh from AnkiConnect" }
    });
    setIcon(reloadBtn, "refresh-cw");
    reloadBtn.addEventListener("click", () => void this.refreshNoteCards(true));

    this.filterInputEl = cardsSection.createEl("input", {
      type: "search",
      cls: "ad-input ad-filter-input is-hidden",
      placeholder: "Filter cards in this note..."
    });
    this.filterInputEl.addEventListener("input", () => this.renderCardsList());

    this.cardsListEl = cardsSection.createDiv({ cls: "ad-cards-list" });

    this.refreshStatusAndQueue();
    await this.refreshNoteCards(false);
  }

  receiveSelection(selection: string, clozeMode = false): void {
    this.composer?.setReferenceContext(selection, clozeMode);
    this.composer?.focusFirstField();
  }

  triggerClozeShortcut(sameIndex = false): void {
    this.composer?.applyClozeCommand(sameIndex);
  }

  async onActiveNoteChanged(): Promise<void> {
    await this.composer?.syncDefaultDeckForActiveNote();
    await this.refreshNoteCards(false);
  }

  refreshStatusAndQueue(): void {
    if (!this.statusLabelEl) return;
    const online = this.bridge.isAnkiOnline();
    const latency = this.bridge.getLatencyMs();
    const pill = this.statusLabelEl.parentElement;
    pill?.toggleClass("is-online", online);
    pill?.toggleClass("is-offline", !online);
    this.statusLabelEl.setText(online ? `Online · ${latency || 8}ms` : "Offline · Queue");

    const pendingCount = this.bridge.getSettings().pendingQueue.length;
    if (pendingCount > 0) {
      this.queueBannerEl.removeClass("is-hidden");
      this.queueCountEl.setText(`${pendingCount} queued ${pendingCount === 1 ? "card" : "cards"}`);
    } else {
      this.queueBannerEl.addClass("is-hidden");
    }

    this.composer?.refreshOnlineState();
  }

  async refreshNoteCards(forceRefresh = false): Promise<void> {
    if (!this.cardsListEl) return;
    const activeFile = this.bridge.getActiveFile();
    if (!activeFile) {
      this.currentCards = [];
      this.renderCardsList("Open a Markdown note to create or inspect linked Anki cards.");
      return;
    }

    try {
      this.currentCards = await this.bridge.getNoteCardsForActiveFile(forceRefresh);
      this.renderCardsList();
    } catch {
      this.currentCards = [];
      this.renderCardsList(
        this.bridge.isAnkiOnline()
          ? "Could not query cards from AnkiConnect."
          : "Anki is offline — open Anki Desktop to inspect or edit existing cards for this note."
      );
    }
  }

  private renderCardsList(emptyReason?: string): void {
    this.cardsListEl.empty();
    this.cardsCountEl.setText(String(this.currentCards.length));
    this.filterInputEl.toggleClass("is-hidden", this.currentCards.length < 4);

    if (this.currentCards.length === 0) {
      this.cardsListEl.createDiv({
        cls: "ad-empty-state",
        text: emptyReason ?? "No Anki cards linked to this note yet."
      });
      return;
    }

    const q = this.filterInputEl.value.trim().toLowerCase();
    const filtered = q
      ? this.currentCards.filter((c) => {
          const joined = Object.values(c.fields).join(" ").toLowerCase() + " " + c.deckName.toLowerCase();
          return joined.includes(q);
        })
      : this.currentCards;

    for (const card of filtered) {
      const cardEl = this.cardsListEl.createDiv({ cls: "ad-card-item" });

      const topRow = cardEl.createDiv({ cls: "ad-card-top" });
      const deckBadge = topRow.createSpan({
        cls: "ad-deck-pill",
        attr: { title: card.deckName }
      });
      const { parentBreadcrumb, leafName } = splitDeckHierarchy(card.deckName);
      deckBadge.createSpan({
        cls: "ad-deck-pill-text",
        text: parentBreadcrumb ? `${parentBreadcrumb}${leafName}` : leafName
      });

      topRow.createSpan({ cls: "ad-model-tag", text: card.modelName });

      const fieldValues = Object.values(card.fields);
      const frontClean = ankiHtmlToEditableText(fieldValues[0] ?? "");
      const backClean = ankiHtmlToEditableText(fieldValues[1] ?? "");

      cardEl.createDiv({ cls: "ad-card-front", text: frontClean || "(Empty)" });
      if (backClean) {
        cardEl.createDiv({ cls: "ad-card-back", text: backClean });
      }

      const actionsRow = cardEl.createDiv({ cls: "ad-card-actions" });
      actionsRow.createSpan({ cls: "ad-card-id", text: `#${card.noteId}` });

      const btns = actionsRow.createDiv({ cls: "ad-card-btns" });

      const browseBtn = btns.createEl("button", {
        type: "button",
        cls: "ad-icon-btn",
        attr: { "aria-label": "Open card in Anki Browser", title: "Open in Anki Browser" }
      });
      setIcon(browseBtn, "external-link");
      browseBtn.addEventListener("click", () => void this.bridge.openCardInAnkiBrowser(card.noteId));

      const editBtn = btns.createEl("button", {
        type: "button",
        cls: "ad-ghost-btn",
        text: "Edit / Move"
      });
      editBtn.addEventListener("click", () => {
        void this.composer?.loadCardForEdit(card);
      });

      const delBtn = btns.createEl("button", {
        type: "button",
        cls: "ad-ghost-btn ad-danger-text",
        text: "Delete"
      });
      delBtn.addEventListener("click", () => {
        if (delBtn.dataset.confirm === "1") {
          void this.bridge.deleteAnkiCard(card.noteId).then(() => this.refreshNoteCards(true));
        } else {
          delBtn.dataset.confirm = "1";
          delBtn.setText("Confirm?");
          setTimeout(() => {
            if (delBtn.isConnected) {
              delBtn.dataset.confirm = "0";
              delBtn.setText("Delete");
            }
          }, 2600);
        }
      });
    }
  }

  async onClose(): Promise<void> {
    this.composer = null;
  }
}
