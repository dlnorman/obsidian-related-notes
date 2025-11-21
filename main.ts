import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { RelatedNotesView, VIEW_TYPE_RELATED_NOTES } from './view';
import { SemanticSearchService } from './semantic_search';
import { OllamaConfig } from './ollama_client';

interface RelatedNotesSettings {
    ollamaUrl: string;
    ollamaModel: string;
    vectorFormat: 'json' | 'binary';
    lastIndexedDate?: number;
    maxRelatedNotes: number;
    debugMode: boolean;
}

const DEFAULT_SETTINGS: RelatedNotesSettings = {
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    vectorFormat: 'json',
    maxRelatedNotes: 5,
    debugMode: false
}

export default class RelatedNotesPlugin extends Plugin {
    searchService: SemanticSearchService;
    settings: RelatedNotesSettings;

    async onload() {
        await this.loadSettings();

        const ollamaConfig: OllamaConfig = {
            baseUrl: this.settings.ollamaUrl,
            model: this.settings.ollamaModel
        };
        this.searchService = new SemanticSearchService(this.app.vault, ollamaConfig, this.settings.vectorFormat, this.settings.debugMode);

        // Load vectors in background
        this.searchService.loadVectors();

        this.addSettingTab(new RelatedNotesSettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE_RELATED_NOTES,
            (leaf) => new RelatedNotesView(leaf, this)
        );

        this.addRibbonIcon('dice', 'Find Related Notes', () => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-related-notes-view',
            name: 'Open Related Notes View',
            callback: () => {
                this.activateView();
            }
        });

        this.addCommand({
            id: 'index-all-notes',
            name: 'Index All Notes',
            callback: async () => {
                const files = this.app.vault.getMarkdownFiles();
                try {
                    await this.searchService.indexAll(files);
                    this.settings.lastIndexedDate = Date.now();
                    await this.saveSettings();
                    new Notice('Indexing complete!');
                } catch (error) {
                    new Notice(`Indexing failed: ${error.message}`);
                    console.error('Indexing error:', error);
                }
            }
        });

        this.addCommand({
            id: 'test-ollama-connection',
            name: 'Test Ollama Connection',
            callback: async () => {
                const connected = await this.searchService.testConnection();
                if (connected) {
                    new Notice('✓ Connected to Ollama');
                } else {
                    new Notice('✗ Failed to connect to Ollama. Make sure Ollama is running.');
                }
            }
        });

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', async () => {
                const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED_NOTES)[0]?.view as RelatedNotesView;
                if (view) {
                    await view.update();
                }
            })
        );
    }

    async onunload() {

    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_RELATED_NOTES);

        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0];
        } else {
            // Our view could not be found in the workspace, create a new leaf
            // in the right sidebar for it
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_RELATED_NOTES, active: true });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }
}

class RelatedNotesSettingTab extends PluginSettingTab {
    plugin: RelatedNotesPlugin;

    constructor(app: App, plugin: RelatedNotesPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Index Statistics Section
        containerEl.createEl('h2', { text: 'Index Statistics' });

        const statsContainer = containerEl.createDiv({ cls: 'index-stats-container' });

        // Calculate stats
        const totalFiles = this.plugin.app.vault.getMarkdownFiles().length;
        const indexedFiles = this.plugin.searchService.vectors.length;
        const missingFiles = totalFiles - indexedFiles;
        const lastIndexed = this.plugin.settings.lastIndexedDate
            ? new Date(this.plugin.settings.lastIndexedDate).toLocaleString()
            : 'Never';
        const status = this.plugin.searchService.isIndexing ? 'Indexing...' : 'Idle';

        // Display stats
        statsContainer.createEl('p', { text: `Status: ${status}` });
        statsContainer.createEl('p', { text: `Indexed Notes: ${indexedFiles} / ${totalFiles}`, cls: 'index-stats-indexed-count' });
        statsContainer.createEl('p', { text: `Missing from Index: ${missingFiles}` });
        statsContainer.createEl('p', { text: `Last Indexed: ${lastIndexed}` });

        // Controls
        const buttonContainer = containerEl.createDiv({ cls: 'settings-button-container' });

        new Setting(containerEl)
            .setName('Index All Notes')
            .setDesc('Generate embeddings for all notes in the vault. This may take a while.')
            .addButton(button => {
                const updateButton = () => {
                    if (this.plugin.searchService.isIndexing) {
                        button.setButtonText('Stop Indexing').setWarning();
                    } else {
                        button.setButtonText('Start Indexing').setCta();
                    }
                };
                updateButton();

                button.onClick(async () => {
                    if (this.plugin.searchService.isIndexing) {
                        this.plugin.searchService.cancelIndexing();
                        new Notice('Indexing cancelled.');
                        this.display();
                    } else {
                        const files = this.app.vault.getMarkdownFiles();
                        // Start indexing - UI updates via onIndexingProgress
                        this.plugin.searchService.indexAll(files).then(async () => {
                            this.plugin.settings.lastIndexedDate = Date.now();
                            await this.plugin.saveSettings();
                            new Notice('Indexing complete!');
                            this.display();
                        }).catch(err => {
                            if (err.message !== 'Indexing cancelled') {
                                console.error(err);
                                new Notice('Indexing failed.');
                            }
                            this.display();
                        });
                        this.display(); // Refresh to show progress bar immediately
                    }
                });
            });

        // Persistent Progress Bar
        if (this.plugin.searchService.isIndexing) {
            const progressDiv = containerEl.createDiv({ cls: 'indexing-progress' });
            progressDiv.style.marginTop = '10px';
            progressDiv.style.marginBottom = '20px';

            const progressBar = progressDiv.createEl('progress');
            progressBar.style.width = '100%';
            progressBar.value = this.plugin.searchService.currentProgress;
            progressBar.max = this.plugin.searchService.totalFiles || 100;

            const progressText = progressDiv.createEl('div');
            progressText.style.textAlign = 'center';
            progressText.style.fontSize = '0.8em';
            progressText.style.marginTop = '5px';
            progressText.textContent = `Indexing: ${this.plugin.searchService.currentProgress} / ${this.plugin.searchService.totalFiles}`;

            // Subscribe to updates
            this.plugin.searchService.onIndexingProgress = (count, total) => {
                requestAnimationFrame(() => {
                    progressBar.value = count;
                    progressBar.max = total;
                    progressText.textContent = `Indexing: ${count} / ${total}`;

                    // Also update stats if they exist
                    const statsEl = containerEl.querySelector('.index-stats-indexed-count');
                    if (statsEl) {
                        statsEl.textContent = `Indexed Notes: ${this.plugin.searchService.vectors.length} / ${total}`;
                    }
                });
            };
        } else {
            // Clear listener when not indexing
            this.plugin.searchService.onIndexingProgress = null;
        }

        new Setting(buttonContainer)
            .addButton(button => button
                .setButtonText('Refresh Stats')
                .onClick(() => {
                    this.display();
                }));

        containerEl.createEl('hr');
        containerEl.createEl('h2', { text: 'Configuration' });

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama instance (default: http://localhost:11434)')
            .addText(text => text
                .setPlaceholder('http://localhost:11434')
                .setValue(this.plugin.settings.ollamaUrl)
                .onChange(async (value) => {
                    this.plugin.settings.ollamaUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding Model')
            .setDesc('The Ollama model to use for generating embeddings (e.g. nomic-embed-text)')
            .addText(text => text
                .setPlaceholder('nomic-embed-text')
                .setValue(this.plugin.settings.ollamaModel)
                .onChange(async (value) => {
                    this.plugin.settings.ollamaModel = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Vector Storage Format')
            .setDesc('Format to use for storing vectors. Binary is faster and smaller, JSON is human-readable.')
            .addDropdown(dropdown => dropdown
                .addOption('json', 'JSON (Legacy)')
                .addOption('binary', 'Binary (Recommended)')
                .setValue(this.plugin.settings.vectorFormat)
                .onChange(async (value) => {
                    this.plugin.settings.vectorFormat = value as 'json' | 'binary';
                    this.plugin.searchService.setFormat(value as 'json' | 'binary');
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max Related Notes')
            .setDesc('Number of related notes to display (1-20)')
            .addSlider(slider => slider
                .setLimits(1, 20, 1)
                .setValue(this.plugin.settings.maxRelatedNotes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxRelatedNotes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debug Mode')
            .setDesc('Enable verbose logging for troubleshooting.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    this.plugin.searchService.setDebugMode(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Clear Index')
            .setDesc('Delete the vector index and reset progress. Use this if you want to re-index from scratch.')
            .addButton(button => button
                .setButtonText('Delete Index')
                .setWarning()
                .onClick(async () => {
                    if (confirm('Are you sure you want to delete the entire index? This cannot be undone.')) {
                        await this.plugin.searchService.clearIndex();
                        this.plugin.settings.lastIndexedDate = 0;
                        await this.plugin.saveSettings();
                        new Notice('Index deleted.');
                        this.display();
                    }
                }));


        new Setting(containerEl)
            .setName('Test Connection')
            .setDesc('Test connection to Ollama')
            .addButton(button => button
                .setButtonText('Test')
                .onClick(async () => {
                    const connected = await this.plugin.searchService.testConnection();
                    if (connected) {
                        new Notice('✓ Connected to Ollama');
                    } else {
                        new Notice('✗ Failed to connect to Ollama');
                    }
                }));
    }
}
