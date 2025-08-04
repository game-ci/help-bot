# open-source-assist-bot

A resource-efficient Discord bot that helps with support questions about an open-source project. It listens for mentions, filters out off-topic requests with a small local model, and calls a larger model or vector store only when needed.

## Setup

### Requirements

- Node.js 18+ and npm
- Git
- Operating systems: Windows, macOS, or Linux for local development. The GitHub Action expects a self-hosted **Windows** runner (Server 2019 or later) with Node.js installed.
- Optional services: LM Studio or Ollama for the small LLM, an OpenAI API key for embeddings, and a Pinecone/Chroma server for vector storage.

### Steps

1. Copy `.env.example` to `.env` and provide your tokens.
2. Install dependencies with `npm install` (packages are placed in the repository's `node_modules/` folder).
3. Run `npm run index` to gather GitHub issues, docs, and code; the script is prepared to write an index to `indexer/data/` or an external store once configured.
4. Start the bot with `npm start`.

### Resource usage

The running bot is lightweight (~1 vCPU/512 MB RAM). Building the index or calling larger models can require 2+ vCPUs and 4 GB+ RAM. Hosting a local model through LM Studio or Ollama may need a GPU or at least 8 GB RAM depending on model size.

## Project Structure

```
bot/
  bot.js                # Main Discord logic
  mentionHandler.js     # Detects @bot and filters intent
  reactionHandler.js    # Tracks emoji feedback
  questionRouter.js     # Calls small LLM for scope check
  queryEngine.js        # Calls large LLM or vector store
 indexer/
    github.js             # GitHub issue & PR fetch
    site.js               # Docs site ingestion
    codebase.js           # Reads code files
    vectorStore.js        # Handles embeddings
    index.js              # Bakes content into a local database
small-llm/
    localLLM.js           # Interface to local LLM server
  ```

## Updating the knowledge base

`npm run index` invokes `indexer/index.js` to gather project content. Any generated artifacts or vector files are stored in `indexer/data/` (or whichever path your `vectorStore.js` uses).

A GitHub Action at `.github/workflows/build-index.yml` runs the same process on a self-hosted Windows runner and can deploy the resulting index in a later step.

## License

MIT
