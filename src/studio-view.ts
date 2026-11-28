import { ItemView, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
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

  private statusChipEl!: HTMLButtonElement;
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

    // 1. Minimal Sticky Header
    const header = root.createDiv({ cls: "ad-studio-header" });
    header.createSpan({ cls: "ad-studio-brand", text: "Anki Studio" });

    this.statusChipEl = header.createEl("button", {
      type: "button",
      cls: "ad-status-chip",
      attr: { "aria-label": "Refresh Anki connection" }
    });
    this.statusChipEl.createSpan({ cls: "ad-status-dot" });
    this.statusLabelEl = this.statusChipEl.createSpan({ text: "···" });
    setTooltip(this.statusChipEl, "Sync decks & connection");
    this.statusChipEl.addEventListener("click", () => void this.bridge.refreshAnkiConnection());

    // 2. Single-Line Compact Queue Strip
    this.queueBannerEl = root.createDiv({ cls: "ad-queue-strip is-hidden" });
    this.queueCountEl = this.queueBannerEl.createSpan({ cls: "ad-queue-count" });
    const flushBtn = this.queueBannerEl.createEl("button", {
      type: "button",
      cls: "ad-btn ad-btn-accent ad-btn-xs",
      text: "Flush"
    });
    flushBtn.addEventListener("click", () => void this.bridge.flushOfflineQueue());

    // 3. Shared Minimal CardComposer
    const composerHostEl = root.createDiv({ cls: "ad-studio-composer-wrap" });
    this.composer = new CardComposer(composerHostEl, this.bridge, {
      surface: "sidebar",
      onSubmitted: () => {
        this.refreshStatusAndQueue();
        void this.refreshNoteCards(true);
      }
    });
    await this.composer.mount();

    // 4. Minimal CARDS (N) List
    const cardsSection = root.createDiv({ cls: "ad-cards-section" });
    const sectionHead = cardsSection.createDiv({ cls: "ad-section-head" });
    const titleWrap = sectionHead.createDiv({ cls: "ad-section-title-wrap" });
    titleWrap.createSpan({ cls: "ad-micro-label", text: "CARDS" });
    this.cardsCountEl = titleWrap.createSpan({ cls: "ad-count-badge", text: "0" });

    const reloadBtn = sectionHead.createEl("button", {
      type: "button",
      cls: "ad-icon-btn",
      attr: { "aria-label": "Refresh cards" }
    });
    setIcon(reloadBtn, "refresh-cw");
    setTooltip(reloadBtn, "Refresh");
    reloadBtn.addEventListener("click", () => void this.refreshNoteCards(true));

    this.filterInputEl = cardsSection.createEl("input", {
      type: "search",
      cls: "ad-input ad-filter-input is-hidden",
      placeholder: "Filter..."
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
    this.statusChipEl.toggleClass("is-online", online);
    this.statusChipEl.toggleClass("is-offline", !online);
    this.statusLabelEl.setText(online ? `${latency || 8}ms` : "Offline");

    const pendingCount = this.bridge.getSettings().pendingQueue.length;
    if (pendingCount > 0) {
      this.queueBannerEl.removeClass("is-hidden");
      this.queueCountEl.setText(`${pendingCount} queued`);
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
      this.renderCardsList("No active note");
      return;
    }

    try {
      this.currentCards = await this.bridge.getNoteCardsForActiveFile(forceRefresh);
      this.renderCardsList();
    } catch {
      this.currentCards = [];
      this.renderCardsList(this.bridge.isAnkiOnline() ? "Sync error" : "Anki offline");
    }
  }

  private renderCardsList(emptyLabel?: string): void {
    this.cardsListEl.empty();
    this.cardsCountEl.setText(String(this.currentCards.length));
    this.filterInputEl.toggleClass("is-hidden", this.currentCards.length < 5);

    if (this.currentCards.length === 0) {
      this.cardsListEl.createDiv({
        cls: "ad-empty-state",
        text: emptyLabel ?? "No cards"
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
      const cardEl = this.cardsListEl.createDiv({ cls: "ad-card-row" });

      const topRow = cardEl.createDiv({ cls: "ad-card-top" });
      const { leafName } = splitDeckHierarchy(card.deckName);
      topRow.createSpan({
        cls: "ad-deck-chip",
        text: leafName,
        attr: { title: card.deckName }
      });

      const btns = topRow.createDiv({ cls: "ad-card-icons" });

      const browseBtn = btns.createEl("button", {
        type: "button",
        cls: "ad-icon-btn",
        attr: { "aria-label": "Open in Anki" }
      });
      setIcon(browseBtn, "arrow-up-right");
      setTooltip(browseBtn, "Open in Anki");
      browseBtn.addEventListener("click", () => void this.bridge.openCardInAnkiBrowser(card.noteId));

      const editBtn = btns.createEl("button", {
        type: "button",
        cls: "ad-icon-btn",
        attr: { "aria-label": "Edit card" }
      });
      setIcon(editBtn, "pencil");
      setTooltip(editBtn, "Edit / Move");
      editBtn.addEventListener("click", () => {
        void this.composer?.loadCardForEdit(card);
      });

      const delBtn = btns.createEl("button", {
        type: "button",
        cls: "ad-icon-btn ad-icon-danger",
        attr: { "aria-label": "Delete card" }
      });
      setIcon(delBtn, "trash-2");
      setTooltip(delBtn, "Delete");
      delBtn.addEventListener("click", () => {
        if (delBtn.dataset.confirm === "1") {
          void this.bridge.deleteAnkiCard(card.noteId).then(() => this.refreshNoteCards(true));
        } else {
          delBtn.dataset.confirm = "1";
          delBtn.addClass("is-confirming");
          setIcon(delBtn, "check");
          setTooltip(delBtn, "Click again to confirm delete");
          setTimeout(() => {
            if (delBtn.isConnected) {
              delBtn.dataset.confirm = "0";
              delBtn.removeClass("is-confirming");
              setIcon(delBtn, "trash-2");
              setTooltip(delBtn, "Delete");
            }
          }, 2400);
        }
      });

      const fieldValues = Object.values(card.fields);
      const frontClean = ankiHtmlToEditableText(fieldValues[0] ?? "");
      const backClean = ankiHtmlToEditableText(fieldValues[1] ?? "");

      cardEl.createDiv({ cls: "ad-card-front", text: frontClean || "—" });
      if (backClean) {
        cardEl.createDiv({ cls: "ad-card-back", text: backClean });
      }
    }
  }

  async onClose(): Promise<void> {
    this.composer = null;
  }
}
