import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { SemanticSearchService } from './semantic_search';

export const VIEW_TYPE_RELATED_NOTES = 'related-notes-view';

import RelatedNotesPlugin from './main';

export class RelatedNotesView extends ItemView {
    private plugin: RelatedNotesPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: RelatedNotesPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return VIEW_TYPE_RELATED_NOTES;
    }

    getIcon() {
        return 'link';
    }

    getDisplayText() {
        return 'Related Notes';
    }

    async onOpen() {
        await this.update();
    }

    async update() {
        const container = this.contentEl;
        container.empty();

        // Add a wrapper for better styling
        const wrapper = container.createDiv({ cls: 'related-notes-container' });
        wrapper.createEl('h4', { text: 'Related Notes', cls: 'nav-file-title', attr: { style: 'margin-bottom: 10px; padding-left: 10px;' } });

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            wrapper.createEl('p', { text: 'No active file.', cls: 'related-notes-empty' });
            return;
        }

        // Show loading state
        const loadingEl = wrapper.createDiv({ cls: 'related-notes-loading' });
        loadingEl.createEl('span', { cls: 'loading-spinner' });
        loadingEl.createSpan({ text: ' Finding related notes...' });

        let related: { file: TFile; score: number; }[] = [];

        try {
            // Ensure the current note is indexed (lazy indexing)
            await this.plugin.searchService.indexNote(activeFile);



            related = this.plugin.searchService.findRelated(activeFile, this.plugin.settings.maxRelatedNotes);

            loadingEl.remove(); // Remove loading indicator

            if (related.length === 0) {
                wrapper.createEl('p', { text: 'No related notes found.', cls: 'related-notes-empty' });
                return;
            }

            // ... rest of rendering logic ...
        } catch (e) {
            loadingEl.remove();
            const errorContainer = wrapper.createDiv({ cls: 'related-notes-error-container' });
            errorContainer.createEl('p', { text: `Error: ${e.message}`, cls: 'related-notes-error' });

            const retryBtn = errorContainer.createEl('button', { text: 'Retry' });
            retryBtn.onclick = () => this.update();

            console.error('Related Notes Error:', e);
            return;
        }

        const list = wrapper.createEl('div', { cls: 'related-notes-list' });

        // Deduplicate results just in case
        const seenPaths = new Set<string>();

        for (const item of related) {
            if (seenPaths.has(item.file.path)) continue;
            seenPaths.add(item.file.path);

            const itemDiv = list.createDiv({ cls: 'related-note-item nav-file-title' });
            const link = itemDiv.createEl('div', {
                text: item.file.basename,
                cls: 'nav-file-title-content'
            });

            // Add score as a small badge or text
            itemDiv.createEl('span', {
                text: `${Math.round(item.score * 100)}%`,
                cls: 'related-note-score',
                attr: { style: 'margin-left: auto; color: var(--text-muted); font-size: 0.8em;' }
            });

            itemDiv.addEventListener('click', (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(item.file.path, '', false);
            });

            // Add hover effect
            itemDiv.addEventListener('mouseenter', () => {
                itemDiv.addClass('is-active');
            });
            itemDiv.addEventListener('mouseleave', () => {
                itemDiv.removeClass('is-active');
            });
        }
    }

    async onClose() {
        // Nothing to clean up.
    }
}
