import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, Notice, DropdownComponent } from 'obsidian';
import { RelatedNotesView, VIEW_TYPE_RELATED_NOTES } from './view';
import { SemanticSearchService } from './semantic_search';
import { OllamaConfig, ModelBenchmarkResult } from './ollama_client';

interface RelatedNotesSettings {
    ollamaUrl: string;
    ollamaModel: string;
    vectorFormat: 'json' | 'binary';
    lastIndexedDate?: number;
    lastIndexedModel?: string;
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
                    this.settings.lastIndexedModel = this.settings.ollamaModel;
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
                const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED_NOTES)[0]?.view;
                if (view instanceof RelatedNotesView) {
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

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function buildProgressText(count: number, total: number, throughput: number): string {
    const throughputStr = throughput > 0 ? ` — ${throughput.toLocaleString()} tok/s (est.)` : '';
    return `Indexing: ${count} / ${total}${throughputStr}`;
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

        // If vectors are still loading, re-render once they're ready
        if (!this.plugin.searchService.isVectorsLoaded) {
            this.plugin.searchService.onVectorsLoaded = () => {
                this.plugin.searchService.onVectorsLoaded = null;
                this.display();
            };
        }

        // Index Statistics Section
        containerEl.createEl('h2', { text: 'Index Statistics' });

        const statsContainer = containerEl.createDiv({ cls: 'index-stats-container' });

        // Calculate stats
        const totalFiles = this.plugin.app.vault.getMarkdownFiles().length;
        // Only count vectors that correspond to existing files
        const currentFilePaths = new Set(this.plugin.app.vault.getMarkdownFiles().map(f => f.path));
        const indexedFiles = this.plugin.searchService.vectors.filter(v => currentFilePaths.has(v.path)).length;
        const missingFiles = totalFiles - indexedFiles;
        const lastIndexed = this.plugin.settings.lastIndexedDate
            ? new Date(this.plugin.settings.lastIndexedDate).toLocaleString()
            : 'Never';
        const status = this.plugin.searchService.isIndexing ? 'Indexing...' : 'Idle';

        // Display stats
        statsContainer.createEl('p', { text: `Status: ${status}` });
        statsContainer.createEl('p', { text: `Indexed Notes: ${indexedFiles} / ${totalFiles}`, cls: 'index-stats-indexed-count' });
        statsContainer.createEl('p', { text: `Missing from Index: ${missingFiles}`, cls: 'index-stats-missing-count' });
        statsContainer.createEl('p', { text: `Last Indexed: ${lastIndexed}` });

        const indexedModel = this.plugin.settings.lastIndexedModel;
        const currentModel = this.plugin.settings.ollamaModel;
        if (indexedModel && indexedModel !== currentModel && indexedFiles > 0) {
            const mismatchEl = statsContainer.createEl('p', {
                text: `⚠️ Index was built with "${indexedModel}" but current model is "${currentModel}". Results will be meaningless until you re-index.`,
                attr: { style: 'color: var(--text-error); font-weight: 500;' }
            });
        }

        const failedFiles = this.plugin.searchService.lastFailedFiles;
        if (failedFiles.length > 0) {
            statsContainer.createEl('p', { text: `Failed to index (${failedFiles.length}):`, attr: { style: 'color: var(--text-error); margin-bottom: 2px;' } });
            const failedList = statsContainer.createEl('ul', { attr: { style: 'margin: 0 0 8px 1.2em; font-size: 0.85em;' } });
            for (const { path, reason } of failedFiles) {
                const item = failedList.createEl('li');
                item.createEl('span', { text: path });
                item.createEl('span', { text: ` — ${reason}`, attr: { style: 'color: var(--text-muted);' } });
            }
        }

        const dbSizeEl = statsContainer.createEl('p', { text: 'Index Size: ...' });
        this.plugin.searchService.getDatabaseSize().then(size => {
            dbSizeEl.textContent = size !== null ? `Index Size: ${formatBytes(size)}` : 'Index Size: No index file';
        });

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
                            this.plugin.settings.lastIndexedModel = this.plugin.settings.ollamaModel;
                            await this.plugin.saveSettings();
                            const failed = this.plugin.searchService.lastFailedFiles.length;
                            new Notice(failed > 0 ? `Indexing complete (${failed} file${failed === 1 ? '' : 's'} failed — see stats panel)` : 'Indexing complete!');
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
            const currentThroughput = this.plugin.searchService.currentThroughput;
            progressText.textContent = buildProgressText(this.plugin.searchService.currentProgress, this.plugin.searchService.totalFiles, currentThroughput);

            // Subscribe to updates
            this.plugin.searchService.onIndexingProgress = (count, total, throughput) => {
                progressBar.value = count;
                progressBar.max = total;
                progressText.textContent = buildProgressText(count, total, throughput);

                // Also update stats if they exist
                const statsEl = containerEl.querySelector('.index-stats-indexed-count');
                if (statsEl) {
                    statsEl.textContent = `Indexed Notes: ${count} / ${total}`;
                }
                const missingEl = containerEl.querySelector('.index-stats-missing-count');
                if (missingEl) {
                    missingEl.textContent = `Missing from Index: ${total - count}`;
                }
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

        // Benchmark panel — shown below the model dropdown
        const benchmarkPanel = containerEl.createDiv({ cls: 'model-benchmark-panel' });
        benchmarkPanel.style.cssText = 'margin: 4px 0 16px 0; padding: 10px 12px; background: var(--background-secondary); border-radius: 6px; font-size: 0.85em; display: none;';

        const renderBenchmark = (result: ModelBenchmarkResult | null, loading: boolean) => {
            benchmarkPanel.empty();
            benchmarkPanel.style.display = 'block';
            if (loading) {
                benchmarkPanel.createEl('span', { text: 'Analyzing model…', attr: { style: 'color: var(--text-muted);' } });
                return;
            }
            if (!result || !result.supported) {
                benchmarkPanel.createEl('span', { text: '⚠️ This model does not support embeddings.', attr: { style: 'color: var(--text-error);' } });
                return;
            }

            const score = result.discriminationScore;
            let quality: string, qualityColor: string;
            if (score >= 0.28) { quality = 'Excellent'; qualityColor = 'var(--color-green)'; }
            else if (score >= 0.18) { quality = 'Good'; qualityColor = 'var(--color-green)'; }
            else if (score >= 0.07) { quality = 'Fair'; qualityColor = 'var(--text-warning, orange)'; }
            else { quality = 'Poor'; qualityColor = 'var(--text-error)'; }

            const speedLabel = result.msPerEmbed < 300 ? 'Fast' : result.msPerEmbed < 1000 ? 'Moderate' : 'Slow';

            const grid = benchmarkPanel.createDiv({ attr: { style: 'display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; align-items: baseline;' } });
            const add = (label: string, value: string, color?: string) => {
                grid.createEl('span', { text: label, attr: { style: 'color: var(--text-muted);' } });
                grid.createEl('span', { text: value, attr: { style: color ? `color: ${color}; font-weight: 500;` : '' } });
            };
            add('Embedding size:', `${result.dimension.toLocaleString()} dimensions`);
            add('Speed:', `${speedLabel} (~${Math.round(result.msPerEmbed)}ms/note)`);
            add('Relatedness quality:', `${quality} (score: ${score.toFixed(3)})`, qualityColor);

            const hint = benchmarkPanel.createEl('p', { attr: { style: 'margin: 6px 0 0; color: var(--text-muted); font-style: italic;' } });
            if (score < 0.07) {
                hint.textContent = 'This model may struggle to distinguish related notes from unrelated ones. Try a different embedding model.';
            } else if (score < 0.18) {
                hint.textContent = 'Decent results expected, though a higher-dimensional model may improve accuracy.';
            } else {
                hint.textContent = 'This model should find meaningful connections between your notes.';
            }
        };

        let modelDropdown: DropdownComponent | null = null;
        const modelSetting = new Setting(containerEl)
            .setName('Embedding Model')
            .setDesc('Fetching available models from Ollama...')
            .addDropdown(dropdown => {
                modelDropdown = dropdown;
                dropdown.addOption(this.plugin.settings.ollamaModel, this.plugin.settings.ollamaModel);
                dropdown.setValue(this.plugin.settings.ollamaModel);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.ollamaModel = value;
                    this.plugin.searchService.updateModel(value);
                    await this.plugin.saveSettings();
                    modelSetting.setDesc('Analyzing model…');
                    renderBenchmark(null, true);
                    const result = await this.plugin.searchService.ollamaClient.benchmarkModel(value);
                    renderBenchmark(result, false);
                    const indexedModel = this.plugin.settings.lastIndexedModel;
                    const hasIndex = this.plugin.searchService.vectors.length > 0;
                    if (result.supported && hasIndex && indexedModel && indexedModel !== value) {
                        modelSetting.setDesc(`⚠️ Existing index was built with "${indexedModel}" — you must re-index before results will be valid.`);
                    } else {
                        modelSetting.setDesc(result.supported ? 'Model supports embeddings. ✓' : '⚠️ Not an embedding model.');
                    }
                });
            });

        // Move benchmark panel to appear right after the model setting
        modelSetting.settingEl.insertAdjacentElement('afterend', benchmarkPanel);

        this.plugin.searchService.listModels().then(async models => {
            if (!modelDropdown) return;
            const selectEl = modelDropdown.selectEl;
            while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
            if (models.length === 0) {
                modelDropdown.addOption(this.plugin.settings.ollamaModel, this.plugin.settings.ollamaModel);
            } else {
                models.forEach(m => modelDropdown!.addOption(m, m));
                if (!models.includes(this.plugin.settings.ollamaModel)) {
                    modelDropdown.addOption(this.plugin.settings.ollamaModel, `${this.plugin.settings.ollamaModel} (current)`);
                }
            }
            modelDropdown.setValue(this.plugin.settings.ollamaModel);
            modelSetting.setDesc('Analyzing model…');
            renderBenchmark(null, true);
            const result = await this.plugin.searchService.ollamaClient.benchmarkModel();
            renderBenchmark(result, false);
            modelSetting.setDesc(result.supported
                ? 'Model supports embeddings. ✓'
                : models.length === 0
                    ? 'No models found — make sure Ollama is running at the configured URL.'
                    : '⚠️ This model does not support embeddings. Choose an embedding model (e.g. nomic-embed-text).');
        }).catch(() => {
            if (!modelDropdown) return;
            modelSetting.setDesc('Could not fetch models — check the Ollama URL above.');
            benchmarkPanel.style.display = 'none';
            modelDropdown.addOption(this.plugin.settings.ollamaModel, this.plugin.settings.ollamaModel);
            modelDropdown.setValue(this.plugin.settings.ollamaModel);
        });

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
