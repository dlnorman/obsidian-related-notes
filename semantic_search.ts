import { TFile, Vault, normalizePath } from 'obsidian';
import { OllamaClient, OllamaConfig } from './ollama_client';

export interface NoteVector {
    path: string;
    embedding: number[];
    mtime: number;
}

export class SemanticSearchService {
    private ollamaClient: OllamaClient;
    public vectors: NoteVector[] = [];
    private vault: Vault;
    private vectorStorePathJson = normalizePath('.obsidian/plugins/obsidian-related-notes/vectors.json');
    private vectorStorePathBinary = normalizePath('.obsidian/plugins/obsidian-related-notes/vectors.bin');
    private format: 'json' | 'binary';
    private debugMode: boolean;

    constructor(vault: Vault, ollamaConfig: OllamaConfig, format: 'json' | 'binary' = 'json', debugMode: boolean = false) {
        this.vault = vault;
        this.ollamaClient = new OllamaClient(ollamaConfig, debugMode);
        this.format = format;
        this.debugMode = debugMode;
    }

    setFormat(format: 'json' | 'binary') {
        this.format = format;
    }

    setDebugMode(debugMode: boolean) {
        this.debugMode = debugMode;
        this.ollamaClient.setDebugMode(debugMode);
    }

    async testConnection(): Promise<boolean> {
        return await this.ollamaClient.testConnection();
    }

    async loadVectors() {
        this.vectors = [];

        // Try loading from the configured format first
        if (this.format === 'binary') {
            if (await this.vault.adapter.exists(this.vectorStorePathBinary)) {
                await this.loadVectorsBinary();
                return;
            }
            // Fallback to JSON if binary doesn't exist yet
            if (await this.vault.adapter.exists(this.vectorStorePathJson)) {
                await this.loadVectorsJson();
                // Convert to binary on next save
            }
        } else {
            if (await this.vault.adapter.exists(this.vectorStorePathJson)) {
                await this.loadVectorsJson();
            }
        }
    }

    async loadVectorsJson() {
        try {
            const content = await this.vault.adapter.read(this.vectorStorePathJson);
            this.vectors = JSON.parse(content);
            console.log(`Loaded ${this.vectors.length} vectors from JSON`);
        } catch (error) {
            console.error('Failed to load JSON vectors:', error);
            this.vectors = [];
        }
    }

    async loadVectorsBinary() {
        try {
            const buffer = await this.vault.adapter.readBinary(this.vectorStorePathBinary);
            const view = new DataView(buffer);
            let offset = 0;

            // Check magic bytes "VEC1"
            const magic = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
            offset += 4;
            if (magic !== 'VEC1') {
                throw new Error('Invalid binary vector file format');
            }

            const numVectors = view.getUint32(offset, true);
            offset += 4;
            const dimension = view.getUint32(offset, true);
            offset += 4;

            const decoder = new TextDecoder();

            for (let i = 0; i < numVectors; i++) {
                // Path length
                const pathLen = view.getUint32(offset, true);
                offset += 4;

                // Path
                const pathBytes = new Uint8Array(buffer, offset, pathLen);
                const path = decoder.decode(pathBytes);
                offset += pathLen;

                // Mtime
                const mtime = view.getFloat64(offset, true);
                offset += 8;

                // Embedding
                const embedding = new Float32Array(dimension);
                for (let j = 0; j < dimension; j++) {
                    embedding[j] = view.getFloat32(offset, true);
                    offset += 4;
                }

                this.vectors.push({
                    path,
                    mtime,
                    embedding: Array.from(embedding) // Convert back to number[] for compatibility
                });
            }
            console.log(`Loaded ${this.vectors.length} vectors from Binary`);
        } catch (error) {
            console.error('Failed to load binary vectors:', error);
            this.vectors = [];
        }
    }

    async saveVectors() {
        try {
            const dir = this.vectorStorePathJson.substring(0, this.vectorStorePathJson.lastIndexOf('/'));
            if (!(await this.vault.adapter.exists(dir))) {
                await this.vault.adapter.mkdir(dir);
            }

            if (this.format === 'binary') {
                await this.saveVectorsBinary();
            } else {
                await this.saveVectorsJson();
            }
        } catch (error) {
            console.error('Failed to save vectors:', error);
            throw error;
        }
    }

    async saveVectorsJson() {
        const data = JSON.stringify(this.vectors, null, 2);
        await this.vault.adapter.write(this.vectorStorePathJson, data);
        console.log(`Saved ${this.vectors.length} vectors to JSON`);
    }

    async saveVectorsBinary() {
        if (this.vectors.length === 0) return;

        const dimension = this.vectors[0].embedding.length;
        const encoder = new TextEncoder();

        // Calculate size
        let size = 4 + 4 + 4; // Header: Magic + Count + Dim
        const vectorData = this.vectors.map(v => {
            const pathBytes = encoder.encode(v.path);
            size += 4 + pathBytes.length + 8 + (dimension * 4); // Len + Path + Mtime + Vec
            return { ...v, pathBytes };
        });

        const buffer = new ArrayBuffer(size);
        const view = new DataView(buffer);
        let offset = 0;

        // Header
        view.setUint8(offset++, 'V'.charCodeAt(0));
        view.setUint8(offset++, 'E'.charCodeAt(0));
        view.setUint8(offset++, 'C'.charCodeAt(0));
        view.setUint8(offset++, '1'.charCodeAt(0));

        view.setUint32(offset, this.vectors.length, true);
        offset += 4;
        view.setUint32(offset, dimension, true);
        offset += 4;

        // Body
        for (const v of vectorData) {
            // Path Length
            view.setUint32(offset, v.pathBytes.length, true);
            offset += 4;

            // Path
            new Uint8Array(buffer, offset, v.pathBytes.length).set(v.pathBytes);
            offset += v.pathBytes.length;

            // Mtime
            view.setFloat64(offset, v.mtime, true);
            offset += 8;

            // Embedding
            for (let i = 0; i < dimension; i++) {
                view.setFloat32(offset, v.embedding[i], true);
                offset += 4;
            }
        }

        await this.vault.adapter.writeBinary(this.vectorStorePathBinary, buffer);
        console.log(`Saved ${this.vectors.length} vectors to Binary (${size} bytes)`);

        if (await this.vault.adapter.exists(this.vectorStorePathJson)) {
            await this.vault.adapter.remove(this.vectorStorePathJson);
            console.log('Removed legacy vectors.json file');
        }
    }

    async clearIndex() {
        this.vectors = [];
        if (await this.vault.adapter.exists(this.vectorStorePathBinary)) {
            await this.vault.adapter.remove(this.vectorStorePathBinary);
        }
        if (await this.vault.adapter.exists(this.vectorStorePathJson)) {
            await this.vault.adapter.remove(this.vectorStorePathJson);
        }
        console.log('Index cleared');
    }

    async generateEmbedding(text: string, title?: string): Promise<number[]> {
        return await this.ollamaClient.generateEmbedding(text, title);
    }

    private preprocessContent(content: string): string {
        // Remove Dataview and DataviewJS blocks
        let clean = content.replace(/```dataview[\s\S]*?```/g, '');
        clean = clean.replace(/```dataviewjs[\s\S]*?```/g, '');

        // Remove Excalidraw JSON blocks and data sections
        clean = clean.replace(/```excalidraw[\s\S]*?```/g, '');
        clean = clean.replace(/## Excalidraw Data[\s\S]*$/, ''); // Remove everything after this header

        // Remove other common generated content markers if needed

        return clean;
    }

    async indexNote(file: TFile) {
        const existingIndex = this.vectors.findIndex(v => v.path === file.path);
        const existingVector = this.vectors[existingIndex];

        // Skip if already indexed and not modified
        if (existingVector && existingVector.mtime === file.stat.mtime) {
            return;
        }

        const content = await this.vault.read(file);
        const cleanedContent = this.preprocessContent(content);
        const embedding = await this.generateEmbedding(cleanedContent, file.basename);
        if (existingIndex >= 0) {
            this.vectors[existingIndex] = {
                path: file.path,
                embedding: embedding,
                mtime: file.stat.mtime
            };
        } else {
            // Double check to prevent race conditions
            const doubleCheckIndex = this.vectors.findIndex(v => v.path === file.path);
            if (doubleCheckIndex >= 0) {
                this.vectors[doubleCheckIndex] = {
                    path: file.path,
                    embedding: embedding,
                    mtime: file.stat.mtime
                };
            } else {
                this.vectors.push({
                    path: file.path,
                    embedding: embedding,
                    mtime: file.stat.mtime
                });
            }
        }
    }


    public isIndexing = false;
    public currentProgress = 0;
    public totalFiles = 0;
    public onIndexingProgress: ((count: number, total: number) => void) | null = null;
    private abortController: AbortController | null = null;

    cancelIndexing() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            this.isIndexing = false;
            console.log('Indexing cancelled by user');
        }
    }

    async indexAll(files: TFile[]) {
        if (this.isIndexing) {
            console.log('Indexing already in progress');
            return;
        }

        this.isIndexing = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        await this.loadVectors();

        let changed = false;
        let successCount = 0;
        let errorCount = 0;
        const failedFiles: string[] = [];

        try {
            let processedCount = 0;
            this.totalFiles = files.length;

            for (const file of files) {
                processedCount++;
                this.currentProgress = processedCount;

                if (this.onIndexingProgress) this.onIndexingProgress(processedCount, files.length);

                // Yield to event loop every 5 files to allow UI updates
                if (processedCount % 5 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }

                if (signal.aborted) {
                    throw new Error('Indexing cancelled');
                }

                const existing = this.vectors.find(v => v.path === file.path);
                if (!existing || existing.mtime !== file.stat.mtime) {
                    console.log(`Indexing ${file.path}...`);
                    try {
                        await this.indexNote(file);
                        changed = true;
                        successCount++;

                        // Save periodically (every 10 notes) to prevent data loss on crash
                        if (successCount % 10 === 0) {
                            await this.saveVectors();
                        }
                    } catch (error) {
                        console.error(`Failed to index ${file.path}:`, error.message);
                        // Log the first 100 chars of the content to help debug
                        const content = await this.vault.read(file);
                        console.log(`Failed note content snippet: "${content.substring(0, 100)}..."`);
                        failedFiles.push(file.path);
                        errorCount++;
                        // Continue with next file instead of stopping
                    }
                } else {
                    if (this.debugMode) {
                        console.log(`Skipping ${file.path}: Up to date (mtime: ${existing.mtime} === ${file.stat.mtime})`);
                    }
                }
            }

            if (successCount > 0) {
                await this.saveVectors();
            }

            // Prune deleted notes
            const currentFilePaths = new Set(files.map(f => f.path));
            const initialVectorCount = this.vectors.length;
            this.vectors = this.vectors.filter(v => currentFilePaths.has(v.path));
            const prunedCount = initialVectorCount - this.vectors.length;

            if (prunedCount > 0) {
                console.log(`Pruned ${prunedCount} deleted notes from index.`);
                await this.saveVectors();
            }

            if (this.debugMode) console.log(`Indexing complete: ${successCount} succeeded, ${errorCount} failed, ${prunedCount} pruned`);
            if (failedFiles.length > 0 && this.debugMode) {
                console.log('Failed files:', failedFiles);
            }
        } catch (error) {
            if (error.message === 'Indexing cancelled') {
                if (this.debugMode) console.log('Indexing cancelled.');
                // Save progress on cancellation
                if (successCount > 0) {
                    if (this.debugMode) console.log('Saving partial progress...');
                    await this.saveVectors();
                }
            } else {
                console.error('Indexing failed:', error);
            }
        } finally {
            this.isIndexing = false;
            this.abortController = null;
        }
    }

    cosineSimilarity(a: number[], b: number[]) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    findRelated(file: TFile, topK: number = 5): { file: TFile, score: number }[] {
        const targetVector = this.vectors.find(v => v.path === file.path);
        if (!targetVector) return [];

        const scores = this.vectors
            .filter(v => v.path !== file.path)
            .map(v => ({
                path: v.path,
                score: this.cosineSimilarity(targetVector.embedding, v.embedding)
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        return scores.map(s => {
            const relatedFile = this.vault.getAbstractFileByPath(s.path);
            return relatedFile instanceof TFile ? { file: relatedFile, score: s.score } : null;
        }).filter((x): x is { file: TFile, score: number } => x !== null);
    }
}
