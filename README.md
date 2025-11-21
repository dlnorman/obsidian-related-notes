# Obsidian Related Notes

A powerful Obsidian plugin that uses local AI to find and display notes semantically related to your current active note. Unlike simple tag or link matching, this plugin uses vector embeddings to understand the *meaning* of your notes.

## Features

- **🧠 Semantic Search:** Finds connections based on meaning, not just keywords.
- **🔒 Local & Private:** Uses [Ollama](https://ollama.com/) running locally on your machine. No data leaves your computer.
- **⚡ High Performance:** Supports a binary vector storage format for fast loading and low memory usage.
- **🛡️ Resilient Indexing:**
    - **Auto-Save:** Saves progress every 10 notes.
    - **Resume Capability:** Picks up where it left off if interrupted or crashed.
    - **Cancellation:** Stop indexing anytime; progress is saved.
- **📊 Index Statistics:** View detailed stats on your index status, missing notes, and last run time.

## Prerequisites

1.  **Ollama**: You must have Ollama installed and running.
    - Download from [ollama.com](https://ollama.com).
2.  **Embedding Model**: Pull a text embedding model. We recommend `nomic-embed-text`.
    ```bash
    ollama pull nomic-embed-text
    ```

## Installation

### Manual Installation

1.  Create a folder named `obsidian-related-notes` inside your vault's `.obsidian/plugins/` directory.
2.  Download `main.js` and `manifest.json` from the [Latest Release](https://github.com/yourusername/obsidian-related-notes/releases/latest).
3.  Place the downloaded files into the folder you created.
4.  Reload Obsidian (or click "Reload plugins" in Settings).
5.  Enable "Related Notes" in **Settings > Community Plugins**.

### Development (Building from Source)

If you want to modify the plugin or build it yourself:

1.  Clone this repository.
2.  Run `npm install` to install dependencies.
3.  Run `npm run build` to build the plugin.
4.  Copy `main.js` and `manifest.json` to your vault's plugin folder.

## Configuration

Go to **Settings > Related Notes**:


1.  **Ollama URL:** The URL of your local Ollama instance (default: `http://localhost:11434`).
2.  **Model:** The name of the embedding model to use (default: `nomic-embed-text`).
3.  **Vector Storage Format:**
    *   **Binary (Recommended):** Faster and uses significantly less disk space.
    *   **JSON (Legacy):** Human-readable but slower and larger.
4.  **Max Related Notes:** Control how many related notes appear in the sidebar (1-20).
5.  **Debug Mode:** Enable this to see detailed logs in the developer console (useful for troubleshooting).

## Features & Resilience

*   **Smart Indexing:** Only re-indexes notes that have changed, making subsequent updates instant.
*   **Auto-Pruning:** Automatically removes deleted notes from the index to keep results clean.
*   **Content Cleaning:** Automatically strips out `dataview`, `dataviewjs`, and `excalidraw` code blocks so they don't skew your similarity results.
*   **Resilience:**
    *   **Safe Mode:** If a note fails to index (e.g., due to length), the plugin automatically retries with a smaller chunk of text.
    *   **Title-Only Mode:** As a last resort, if the content is too problematic, it indexes just the title to ensure the note is still findable.

## Troubleshooting

*   **"Ollama API error":** Ensure Ollama is running (`ollama serve`) and the model is pulled (`ollama pull nomic-embed-text`).
*   **"EOF" Errors:** This usually means the model crashed on a specific note. The plugin's new **Safe Mode** and **Title-Only Mode** should handle this automatically. Check the console (Toggle **Debug Mode** on) to see it in action.
*   **Nothing happens when clicking "Index All":** Check the console for errors. If you have a massive vault, give it a moment to start.
*   **Modified notes not updating:** The plugin checks the file's "modified time". If you just changed it, wait a few seconds or try indexing again.


