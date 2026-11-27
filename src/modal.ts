import { App, Modal, setIcon } from "obsidian";
import { CardComposer, type ComposerHostBridge } from "./composer";

export class QuickDispatchModal extends Modal {
  private host: ComposerHostBridge;
  private initialSelection: string;
  private initialClozeMode: boolean;
  private composer: CardComposer | null = null;

  constructor(
    app: App,
    host: ComposerHostBridge,
    opts?: { selection?: string; clozeMode?: boolean }
  ) {
    super(app);
    this.host = host;
    this.initialSelection = opts?.selection ?? "";
    this.initialClozeMode = Boolean(opts?.clozeMode);
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass("ad-quick-modal");
    contentEl.empty();

    const header = contentEl.createDiv({ cls: "ad-modal-head" });
    const titleWrap = header.createDiv({ cls: "ad-modal-title" });
    const iconSpan = titleWrap.createSpan({ cls: "ad-icon-inline ad-teal" });
    setIcon(iconSpan, "send");
    titleWrap.createSpan({ text: "Anki Dispatch — Quick Capture & Deck Router" });

    header.createSpan({
      cls: `ad-status-pill ${this.host.isAnkiOnline() ? "is-online" : "is-offline"}`,
      text: this.host.isAnkiOnline() ? "Anki Online" : "Offline Queue"
    });

    const body = contentEl.createDiv({ cls: "ad-modal-body" });
    this.composer = new CardComposer(body, this.host, {
      surface: "modal",
      initialContextText: this.initialSelection,
      initialClozeMode: this.initialClozeMode,
      onSubmitted: ({ rapidFire }) => {
        if (!rapidFire) this.close();
      }
    });

    await this.composer.mount();
    setTimeout(() => this.composer?.focusFirstField(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
    this.composer = null;
  }
}
