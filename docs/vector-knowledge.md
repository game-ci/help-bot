# Vector knowledge & LlamaIndex helper

Vector search is optional but offered to boost retrieval quality when you want the agent to cite cached embeddings.

## Enable vector search

1. Set `vector_search.enabled` to `true` in `config.json`.
2. Run `npm run vector-bake` to build the store (requires Python and `llama-index`).
3. The CLI automatically references `data/vector-store/` inside prompts when `vector_search.enabled` is `true`.

## Manage the store

- `npm run vector-bake` – Bake docs + GitHub issues/reviews.
- `npm run vector-bake -- --docs-only` – Bake only documentation (skip GitHub content).
- `npm run vector-bake -- --query "How do I ...?"` – Query the store and print the top similarity hits.
- `npm run vector-bake -- --clean` – Remove `data/vector-store/` and rebuild from scratch (useful after large doc changes).

The script installs `llama-index` automatically if missing. Keep Python 3.9+ available (the CLI detects `python3`/`python`, then runs the embedded bake script).
