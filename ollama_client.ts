import { requestUrl, RequestUrlParam } from 'obsidian';

export interface OllamaEmbeddingResponse {
    embedding: number[];
}

export interface OllamaConfig {
    baseUrl: string;
    model: string;
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

    async generateEmbedding(text: string, title?: string, retries: number = 3): Promise<number[]> {
        const url = `${this.config.baseUrl}/api/embeddings`;

        // Sanitize text to remove null bytes and other non-printable characters
        const sanitizedText = this.sanitizeText(text);

        // Truncate text to prevent overly long inputs (max ~8000 tokens ≈ 32000 chars)
        const maxLength = 32000;
        const truncatedText = sanitizedText.length > maxLength ? sanitizedText.substring(0, maxLength) : sanitizedText;

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

    async testConnection(): Promise<boolean> {
        try {
            const url = `${this.config.baseUrl}/api/tags`;
            const response = await requestUrl({ url, method: 'GET' });
            return response.status === 200;
        } catch (error) {
            console.error('Ollama connection test failed:', error);
            return false;
        }
    }

    private sanitizeText(text: string): string {
        // Remove null bytes and other control characters (except newlines and tabs)
        // This regex keeps printable ASCII, common accented characters, and standard whitespace
        return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }
}
