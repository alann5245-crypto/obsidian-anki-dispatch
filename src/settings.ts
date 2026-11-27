import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AnkiDispatchPlugin from "./main";
import { normalizeDeckPath } from "./core";

export class AnkiDispatchSettingTab extends PluginSettingTab {
  plugin: AnkiDispatchPlugin;

  constructor(app: App, plugin: AnkiDispatchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Anki Dispatch — Settings" });

    new Setting(containerEl)
      .setName("AnkiConnect URL")
      .setDesc("Local HTTP endpoint of the AnkiConnect add-on in Anki Desktop (default: http://127.0.0.1:8765).")
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
          .setButtonText("Test & Sync Decks")
          .setCta()
          .onClick(async () => {
            await this.plugin.refreshAnkiConnection(true);
          })
      );

    new Setting(containerEl)
      .setName("Default capture surface")
      .setDesc("Choose where the card composer opens when pressing Ctrl/Cmd+Shift+A or using the context menu.")
      .addDropdown((dd) =>
        dd
          .addOption("modal", "Quick Modal (centered popup with Ctrl/Cmd+Enter rapid-fire)")
          .addOption("sidebar", "Right Sidebar — Anki Studio (keep full note visible alongside composer)")
          .setValue(this.plugin.settings.defaultCaptureMode)
          .onChange(async (val) => {
            this.plugin.settings.defaultCaptureMode = val as "modal" | "sidebar";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Floating selection bar")
      .setDesc("Show a compact [Anki Dispatch | Cloze] pill above highlighted text (evaluated after mouse release with 0ms typing overhead).")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.enableFloatingSelectionBar).onChange(async (val) => {
          this.plugin.settings.enableFloatingSelectionBar = val;
          if (!val) this.plugin.hideFloatingSelectionPill();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Global fallback deck")
      .setDesc("Used when neither the current note nor its vault folder has a remembered deck.")
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
      .setName("Append Obsidian source link to Anki cards")
      .setDesc("Adds a subtle 'Obsidian: Note Title' deep link at the bottom of the back field so you can jump back to the exact note while reviewing in Anki.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.appendObsidianBacklink).onChange(async (val) => {
          this.plugin.settings.appendObsidianBacklink = val;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Folder-to-Deck Routing Rules (Optional)" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Automatically pre-select an Anki deck for notes inside specific vault folders (e.g. 'CS/Systems' -> 'CS::Systems'). You can always override the deck per card."
    });

    const rulesWrap = containerEl.createDiv({ cls: "ad-rules-list" });
    const renderRules = () => {
      rulesWrap.empty();
      this.plugin.settings.folderDeckRules.forEach((rule, idx) => {
        new Setting(rulesWrap)
          .setName(`${rule.folderPrefix}  →  ${rule.deckName}`)
          .addExtraButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("Delete rule")
              .onClick(async () => {
                this.plugin.settings.folderDeckRules.splice(idx, 1);
                await this.plugin.saveSettings();
                renderRules();
              })
          );
      });
    };
    renderRules();

    let newFolder = "";
    let newDeck = "";
    new Setting(containerEl)
      .setName("Add folder → deck rule")
      .addText((t) =>
        t.setPlaceholder("Vault folder (e.g. Science/Neuro)").onChange((v) => {
          newFolder = v.trim().replace(/^\/+|\/+$/g, "");
        })
      )
      .addText((t) =>
        t.setPlaceholder("Anki deck (e.g. Science::Neuro)").onChange((v) => {
          newDeck = normalizeDeckPath(v);
        })
      )
      .addButton((b) =>
        b.setButtonText("Add").onClick(async () => {
          if (!newFolder || !newDeck) {
            new Notice("Please enter both a vault folder path and an Anki deck name.");
            return;
          }
          this.plugin.settings.folderDeckRules.push({ folderPrefix: newFolder, deckName: newDeck });
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }
}
