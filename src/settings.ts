import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type AnkiDispatchPlugin from "./main";
import { normalizeDeckPath } from "./core";

export class AnkiDispatchSettingTab extends PluginSettingTab {
  plugin: AnkiDispatchPlugin;
  private activeTab: "settings" | "guide" = "settings";

  constructor(app: App, plugin: AnkiDispatchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ad-settings-root");

    // Top Header + 2-Tab Segmented Switch (Settings | Guide & Shortcuts)
    const topBar = containerEl.createDiv({ cls: "ad-settings-topbar" });
    topBar.createEl("h2", { cls: "ad-settings-title", text: "Anki Dispatch" });

    const nav = topBar.createDiv({ cls: "ad-settings-tabs", attr: { role: "tablist" } });
    const tabSettings = nav.createEl("button", {
      type: "button",
      cls: "ad-settings-tab",
      text: "Settings",
      attr: { role: "tab", "aria-selected": String(this.activeTab === "settings") }
    });
    const tabGuide = nav.createEl("button", {
      type: "button",
      cls: "ad-settings-tab",
      text: "Guide & Shortcuts",
      attr: { role: "tab", "aria-selected": String(this.activeTab === "guide") }
    });

    tabSettings.addEventListener("click", () => {
      this.activeTab = "settings";
      this.display();
    });
    tabGuide.addEventListener("click", () => {
      this.activeTab = "guide";
      this.display();
    });

    if (this.activeTab === "guide") {
      this.renderGuideTab(containerEl);
    } else {
      this.renderSettingsTab(containerEl);
    }
  }

  private renderSettingsTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("AnkiConnect URL")
      .setDesc("Local HTTP endpoint in Anki Desktop.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8765")
          .setValue(this.plugin.settings.ankiConnectUrl)
          .onChange(async (val) => {
            this.plugin.settings.ankiConnectUrl = val.trim() || "http://127.0.0.1:8765";
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Sync")
          .setCta()
          .onClick(async () => {
            await this.plugin.refreshAnkiConnection(true);
          })
      );

    new Setting(containerEl)
      .setName("Capture surface")
      .setDesc("Default view opened by hotkeys and selection actions.")
      .addDropdown((dd) =>
        dd
          .addOption("modal", "Quick Modal")
          .addOption("sidebar", "Right Sidebar (Anki Studio)")
          .setValue(this.plugin.settings.defaultCaptureMode)
          .onChange(async (val) => {
            this.plugin.settings.defaultCaptureMode = val as "modal" | "sidebar";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Floating selection bar")
      .setDesc("Show [+ Card | Cloze] pill when highlighting text.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.enableFloatingSelectionBar).onChange(async (val) => {
          this.plugin.settings.enableFloatingSelectionBar = val;
          if (!val) this.plugin.hideFloatingSelectionPill();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Fallback deck")
      .setDesc("Default deck when no note or folder deck is remembered.")
      .addText((text) =>
        text
          .setPlaceholder("Default")
          .setValue(this.plugin.settings.defaultDeck)
          .onChange(async (val) => {
            this.plugin.settings.defaultDeck = normalizeDeckPath(val) || "Default";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Obsidian source link")
      .setDesc("Append a subtle backlink to the note on the back of Anki cards.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.appendObsidianBacklink).onChange(async (val) => {
          this.plugin.settings.appendObsidianBacklink = val;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { cls: "ad-settings-subhead", text: "Folder → Deck Rules" });

    const rulesWrap = containerEl.createDiv({ cls: "ad-rules-list" });
    this.plugin.settings.folderDeckRules.forEach((rule, idx) => {
      new Setting(rulesWrap)
        .setName(`${rule.folderPrefix}  →  ${rule.deckName}`)
        .addExtraButton((btn) =>
          btn
            .setIcon("trash-2")
            .setTooltip("Remove")
            .onClick(async () => {
              this.plugin.settings.folderDeckRules.splice(idx, 1);
              await this.plugin.saveSettings();
              this.display();
            })
        );
    });

    let newFolder = "";
    let newDeck = "";
    new Setting(containerEl)
      .setName("New rule")
      .addText((t) =>
        t.setPlaceholder("Folder (e.g. CS/Systems)").onChange((v) => {
          newFolder = v.trim().replace(/^\/+|\/+$/g, "");
        })
      )
      .addText((t) =>
        t.setPlaceholder("Deck (e.g. CS::Systems)").onChange((v) => {
          newDeck = normalizeDeckPath(v);
        })
      )
      .addButton((b) =>
        b.setButtonText("Add").onClick(async () => {
          if (!newFolder || !newDeck) {
            new Notice("Enter both folder and deck.");
            return;
          }
          this.plugin.settings.folderDeckRules.push({ folderPrefix: newFolder, deckName: newDeck });
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  private renderGuideTab(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: "ad-guide-wrap" });

    // 1. AnkiConnect One-Time Setup Card
    const setupCard = wrap.createDiv({ cls: "ad-guide-card" });
    const setupHead = setupCard.createDiv({ cls: "ad-guide-card-head" });
    setupHead.createSpan({ cls: "ad-micro-label", text: "ANKICONNECT SETUP" });

    const copyBtn = setupHead.createEl("button", {
      type: "button",
      cls: "ad-btn ad-btn-ghost ad-btn-xs"
    });
    const copyIcon = copyBtn.createSpan({ cls: "ad-icon-inline" });
    setIcon(copyIcon, "copy");
    copyBtn.createSpan({ text: "Copy 2055492159" });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText("2055492159");
      new Notice("Copied AnkiConnect code: 2055492159");
    });

    setupCard.createEl("p", {
      cls: "ad-guide-p",
      text: "In Anki Desktop: Tools → Add-ons → Get Add-ons → enter 2055492159 → restart Anki."
    });

    // 2. Keyboard Shortcuts Table
    const kbCard = wrap.createDiv({ cls: "ad-guide-card" });
    kbCard.createDiv({ cls: "ad-micro-label", text: "KEYBOARD SHORTCUTS" });
    const kbTable = kbCard.createEl("table", { cls: "ad-guide-table" });
    const shortcuts: Array<[string, string]> = [
      ["Mod + Shift + A", "Open Quick Dispatch (with highlighted selection)"],
      ["Mod + Enter", "Submit card (stays open when Repeat is active)"],
      ["Mod + Shift + C", "Wrap selection in next Cloze {{c1::...}}, {{c2::...}}"],
      ["Mod + Alt + Shift + C", "Wrap selection reusing current Cloze index"],
      ["↑ / ↓ / Enter / Esc", "Navigate & pick decks in Fuzzy Deck Combobox"]
    ];
    const kbBody = kbTable.createEl("tbody");
    for (const [keys, desc] of shortcuts) {
      const tr = kbBody.createEl("tr");
      const tdKey = tr.createEl("td");
      tdKey.createEl("kbd", { text: keys });
      tr.createEl("td", { text: desc });
    }

    // 3. Syntax & Routing Reference
    const synCard = wrap.createDiv({ cls: "ad-guide-card" });
    synCard.createDiv({ cls: "ad-micro-label", text: "SYNTAX & ROUTING" });
    const synTable = synCard.createEl("table", { cls: "ad-guide-table" });
    const rules: Array<[string, string]> = [
      ["Parent::Child::New", "Typing a non-existent path creates the subdeck in Anki automatically"],
      ["$x^2$ / $$...$$", "Converted to Anki MathJax \\(...\\) and \\[...\\]"],
      ["`code` / ```lang", "Converted to inline <code> and <pre><code> blocks"],
      ["Ctrl / Cmd + V", "Pastes clipboard images directly into Anki media"],
      ["anki_note_id", "Tiny YAML frontmatter key linking the note to Anki without cluttering prose"]
    ];
    const synBody = synTable.createEl("tbody");
    for (const [token, desc] of rules) {
      const tr = synBody.createEl("tr");
      const tdTok = tr.createEl("td");
      tdTok.createEl("code", { text: token });
      tr.createEl("td", { text: desc });
    }

    // 4. Active Recall Best Practice & Offline Queue Note
    const noteCard = wrap.createDiv({ cls: "ad-guide-card" });
    noteCard.createDiv({ cls: "ad-micro-label", text: "WORKFLOW & OFFLINE QUEUE" });
    noteCard.createEl("p", {
      cls: "ad-guide-p",
      text: "Highlighted passages appear as a compact quote strip so you formulate atomic prompts in your own words (Wozniak's Minimum Information Principle) while keeping your Markdown note 100% pure."
    });
    noteCard.createEl("p", {
      cls: "ad-guide-p",
      text: "When Anki Desktop is closed, cards queue locally (images stored outside data.json) and auto-flush + purge back to 0 bytes as soon as Anki reconnects."
    });
  }
}
