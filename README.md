# open-source-assist-bot

A resource-efficient Discord bot that helps with support questions about an open-source project. It listens for mentions, filters out off-topic requests with a small local model, and calls a larger model or vector store only when needed.

## Setup

1. Copy `.env.example` to `.env` and provide your tokens.
2. Install dependencies with `npm install`.
3. Start the bot with `npm start`.

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

Run `npm run index` to fetch project content and rebuild the local database. A GitHub Action at `.github/workflows/build-index.yml` runs the same process on a self-hosted Windows runner for deployment.

## License

MIT
