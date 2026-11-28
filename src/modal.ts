import { App, Modal } from "obsidian";
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
    header.createSpan({ cls: "ad-modal-title", text: "Anki Dispatch" });

    const status = header.createSpan({
      cls: `ad-status-chip ${this.host.isAnkiOnline() ? "is-online" : "is-offline"}`
    });
    status.createSpan({ cls: "ad-status-dot" });
    status.createSpan({ text: this.host.isAnkiOnline() ? "Online" : "Queue" });

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
