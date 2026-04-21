import { requestUrl, RequestUrlParam } from 'obsidian';

export interface OllamaEmbeddingResponse {
    embedding: number[];
}

export interface OpenAIEmbeddingResponse {
    data: { embedding: number[]; index: number }[];
}

export interface OllamaConfig {
    baseUrl: string;
    model: string;
    apiType?: 'ollama' | 'openai';
}

export interface ModelBenchmarkResult {
    supported: boolean;
    dimension: number;
    msPerEmbed: number;
    discriminationScore: number; // within-topic sim minus cross-topic sim; higher = better
}

export class OllamaClient {
    private config: OllamaConfig;
    private debugMode: boolean;

    constructor(config: OllamaConfig, debugMode: boolean = false) {
        this.config = config;
        this.debugMode = debugMode;
    }

    setDebugMode(debugMode: boolean) {
        this.debugMode = debugMode;
    }

    updateModel(model: string) {
        this.config.model = model;
    }

    updateApiType(apiType: 'ollama' | 'openai') {
        this.config.apiType = apiType;
    }

    updateBaseUrl(baseUrl: string) {
        this.config.baseUrl = baseUrl;
    }

    private async generateEmbeddingOpenAI(text: string, retries: number): Promise<number[]> {
        const url = `${this.config.baseUrl}/v1/embeddings`;
        for (let attempt = 0; attempt <= retries; attempt++) {
            let response;
            try {
                response = await requestUrl({
                    url,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: this.config.model, input: text }),
                    throw: false,
                });
            } catch (error) {
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
                    continue;
                }
                throw new Error(`Failed to connect to OpenAI-compatible server: ${error.message}`);
            }
            if (response.status !== 200) {
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
                    continue;
                }
                throw new Error(`OpenAI-compatible API error: ${response.status} - ${response.text}`);
            }
            const data = response.json as OpenAIEmbeddingResponse;
            if (!data.data?.[0]?.embedding || !Array.isArray(data.data[0].embedding)) {
                throw new Error('Invalid embedding response from OpenAI-compatible API');
            }
            return data.data[0].embedding;
        }
        throw new Error('Failed to generate embedding after all retries');
    }

    async generateEmbedding(text: string, title?: string, retries: number = 3): Promise<number[]> {
        // Sanitize text to remove null bytes and other non-printable characters
        const sanitizedText = this.sanitizeText(text);

        // Truncate text to prevent overly long inputs (max ~8000 tokens ≈ 32000 chars)
        const maxLength = 32000;
        const truncatedText = sanitizedText.length > maxLength ? sanitizedText.substring(0, maxLength) : sanitizedText;

        if (this.config.apiType === 'openai') {
            return this.generateEmbeddingOpenAI(truncatedText, retries);
        }

        const url = `${this.config.baseUrl}/api/embeddings`;

        for (let attempt = 0; attempt <= retries; attempt++) {
            let response;
            try {
                response = await requestUrl({
                    url: url,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: this.config.model,
                        prompt: truncatedText,
                    }),
                    throw: false, // Don't throw on non-200 status
                });
            } catch (error) {
                console.error(`Request failed completely (attempt ${attempt + 1}/${retries + 1}):`, error);
                if (attempt < retries) {
                    const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
                    console.log(`Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                console.error('Text length:', text.length, 'Truncated to:', truncatedText.length);
                console.error('Model:', this.config.model);
                console.error('URL:', url);
                throw new Error(`Failed to connect to Ollama after ${retries + 1} attempts: ${error.message}`);
            }

            if (response.status !== 200) {
                const errorText = response.text;
                if (this.debugMode) console.error(`Ollama API error (attempt ${attempt + 1}/${retries + 1}):`, errorText);

                // Check if it's a transient error (EOF, connection issues)
                if (errorText.includes('EOF') || errorText.includes('connection')) {
                    if (attempt < retries) {
                        const delay = Math.pow(2, attempt) * 1000;
                        if (this.debugMode) console.log(`Transient error detected. Retrying in ${delay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    } else {
                        // Final attempt failed with EOF. Try "Safe Mode" - drastically reduced context.
                        if (this.debugMode) console.log('Persistent EOF error. Attempting Safe Mode (reduced context)...');
                        try {
                            const safeLength = 2000; // Reduced to 2000 chars
                            const safeText = sanitizedText.substring(0, safeLength);
                            const safeResponse = await requestUrl({
                                url: url,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    model: this.config.model,
                                    prompt: safeText,
                                }),
                                throw: false
                            });

                            if (safeResponse.status === 200) {
                                const data = safeResponse.json as OllamaEmbeddingResponse;
                                if (data.embedding && Array.isArray(data.embedding)) {
                                    if (this.debugMode) console.log('Safe Mode succeeded!');
                                    return data.embedding;
                                }
                            } else {
                                if (this.debugMode) console.error(`Safe Mode failed with status ${safeResponse.status}: ${safeResponse.text}`);
                            }
                        } catch (safeError) {
                            if (this.debugMode) console.error('Safe Mode exception:', safeError);
                        }

                        // If Safe Mode failed and we have a title, try "Title Only Mode"
                        if (title) {
                            if (this.debugMode) console.log(`Safe Mode failed. Attempting Title Only Mode for "${title}"...`);
                            try {
                                const titleResponse = await requestUrl({
                                    url: url,
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        model: this.config.model,
                                        prompt: `Note title: ${title}`,
                                    }),
                                    throw: false
                                });

                                if (titleResponse.status === 200) {
                                    const data = titleResponse.json as OllamaEmbeddingResponse;
                                    if (data.embedding && Array.isArray(data.embedding)) {
                                        if (this.debugMode) console.log('Title Only Mode succeeded!');
                                        return data.embedding;
                                    }
                                } else {
                                    if (this.debugMode) console.error(`Title Only Mode failed with status ${titleResponse.status}: ${titleResponse.text}`);
                                }
                            } catch (titleError) {
                                if (this.debugMode) console.error('Title Only Mode exception:', titleError);
                            }
                        }
                    }
                }

                if (this.debugMode) {
                    console.error('Response status:', response.status);
                    console.error('Response headers:', response.headers);
                }
                throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
            }

            const data = response.json as OllamaEmbeddingResponse;
            if (!data.embedding || !Array.isArray(data.embedding)) {
                console.error('Invalid response format:', data);
                throw new Error('Invalid embedding response from Ollama');
            }

            return data.embedding;
        }

        throw new Error('Failed to generate embedding after all retries');
    }

    async benchmarkModel(model?: string): Promise<ModelBenchmarkResult> {
        const targetModel = model ?? this.config.model;

        // Five test sentences: two tech (A), two cooking (B), one finance (C)
        // A well-discriminating model should cluster A together and B together,
        // but keep A and B far apart.
        const sentences = [
            'Machine learning models use gradient descent to optimize neural networks.',
            'Deep learning requires large datasets and significant computational resources.',
            'The pasta was perfectly al dente with a rich homemade tomato sauce.',
            'Sautéing garlic in olive oil creates a wonderful aromatic base for sauces.',
            'The quarterly earnings report showed a 15% increase in revenue.',
        ];

        const embeddings: number[][] = [];
        const start = Date.now();

        for (const sentence of sentences) {
            try {
                let embedding: number[];
                if (this.config.apiType === 'openai') {
                    const url = `${this.config.baseUrl}/v1/embeddings`;
                    const response = await requestUrl({
                        url,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: targetModel, input: sentence }),
                        throw: false,
                    });
                    if (response.status !== 200) {
                        console.error(`[related-notes] benchmark: HTTP ${response.status} from ${url}`, response.text);
                        return { dimension: 0, msPerEmbed: 0, discriminationScore: 0, supported: false };
                    }
                    const data = response.json as OpenAIEmbeddingResponse;
                    if (!data.data?.[0]?.embedding || data.data[0].embedding.length === 0) {
                        console.error('[related-notes] benchmark: unexpected response shape', JSON.stringify(data).slice(0, 300));
                        return { dimension: 0, msPerEmbed: 0, discriminationScore: 0, supported: false };
                    }
                    embedding = data.data[0].embedding;
                } else {
                    const url = `${this.config.baseUrl}/api/embeddings`;
                    const response = await requestUrl({
                        url,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: targetModel, prompt: sentence }),
                        throw: false,
                    });
                    if (response.status !== 200) {
                        console.error(`[related-notes] benchmark: HTTP ${response.status} from ${url}`, response.text);
                        return { dimension: 0, msPerEmbed: 0, discriminationScore: 0, supported: false };
                    }
                    const data = response.json as OllamaEmbeddingResponse;
                    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
                        console.error('[related-notes] benchmark: unexpected response shape', JSON.stringify(data).slice(0, 300));
                        return { dimension: 0, msPerEmbed: 0, discriminationScore: 0, supported: false };
                    }
                    embedding = data.embedding;
                }
                embeddings.push(embedding);
            } catch (error) {
                console.error('[related-notes] benchmark: request threw', error);
                return { dimension: 0, msPerEmbed: 0, discriminationScore: 0, supported: false };
            }
        }

        const elapsed = Date.now() - start;
        const msPerEmbed = elapsed / sentences.length;
        const dimension = embeddings[0].length;

        // cosine similarity helper
        const cosineSim = (a: number[], b: number[]): number => {
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < a.length; i++) {
                dot += a[i] * b[i];
                normA += a[i] * a[i];
                normB += b[i] * b[i];
            }
            const denom = Math.sqrt(normA) * Math.sqrt(normB);
            return denom === 0 ? 0 : dot / denom;
        };

        // Within-topic similarity: (A0,A1) and (B0,B1)
        const withinTopic = (cosineSim(embeddings[0], embeddings[1]) + cosineSim(embeddings[2], embeddings[3])) / 2;
        // Cross-topic similarity: A vs B pairs
        const crossTopic = (
            cosineSim(embeddings[0], embeddings[2]) +
            cosineSim(embeddings[0], embeddings[3]) +
            cosineSim(embeddings[1], embeddings[2]) +
            cosineSim(embeddings[1], embeddings[3])
        ) / 4;

        const discriminationScore = withinTopic - crossTopic;

        return { dimension, msPerEmbed, discriminationScore, supported: true };
    }

    async testEmbeddingSupport(model?: string): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.config.baseUrl}/api/embeddings`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: model ?? this.config.model, prompt: 'test' }),
                throw: false,
            });
            if (response.status !== 200) return false;
            const data = response.json as OllamaEmbeddingResponse;
            return Array.isArray(data.embedding) && data.embedding.length > 0;
        } catch {
            return false;
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            const url = this.config.apiType === 'openai'
                ? `${this.config.baseUrl}/v1/models`
                : `${this.config.baseUrl}/api/tags`;
            const response = await requestUrl({ url, method: 'GET' });
            return response.status === 200;
        } catch (error) {
            console.error('Connection test failed:', error);
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            if (this.config.apiType === 'openai') {
                const url = `${this.config.baseUrl}/v1/models`;
                const response = await requestUrl({ url, method: 'GET' });
                if (response.status !== 200) return [];
                const data = response.json as { data?: { id: string }[] };
                return (data.data ?? []).map(m => m.id);
            } else {
                const url = `${this.config.baseUrl}/api/tags`;
                const response = await requestUrl({ url, method: 'GET' });
                if (response.status !== 200) return [];
                const data = response.json as { models?: { name: string; capabilities?: string[] }[] };
                const models = data.models ?? [];
                // If Ollama returns capability info, filter to embedding-capable models only.
                // Fall back to all models if capabilities aren't present (older Ollama versions).
                const hasCapabilityInfo = models.some(m => Array.isArray(m.capabilities));
                if (hasCapabilityInfo) {
                    return models
                        .filter(m => m.capabilities?.includes('embedding'))
                        .map(m => m.name);
                }
                return models.map(m => m.name);
            }
        } catch (error) {
            console.error('Failed to list models:', error);
            return [];
        }
    }

    private sanitizeText(text: string): string {
        // Remove null bytes and other control characters (except newlines and tabs)
        // This regex keeps printable ASCII, common accented characters, and standard whitespace
        return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }
}
