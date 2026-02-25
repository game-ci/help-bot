#!/usr/bin/env bash
# vector-bake.sh
#
# Optional: Builds a vector search index from synced documentation and community
# data. This creates embeddings that can be searched alongside the text file
# approach for improved answer retrieval.
#
# Requires: python3, pip (chromadb and sentence-transformers will be installed)
#
# The vector store is persisted to data/vector-store/ and can be re-used across
# cycles without rebuilding (unless docs change).
#
# Usage:
#   bash automation/vector-bake.sh              # Bake all synced data
#   bash automation/vector-bake.sh --docs-only  # Bake only documentation
#   bash automation/vector-bake.sh --query "How do I activate a Unity license?"
#
# Environment variables:
#   VECTOR_EMBEDDING_MODEL  -- Override embedding model (default from config.json)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${REPO_DIR}/config.json"
DATA_DIR="${REPO_DIR}/data"
VECTOR_DIR="${DATA_DIR}/vector-store"

# Load config
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
  EMBEDDING_MODEL=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('vector_search', {}).get('embedding_model', 'all-MiniLM-L6-v2'))
" 2>/dev/null || echo "all-MiniLM-L6-v2")

  COLLECTION_NAME=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('vector_search', {}).get('collection_name', 'gameci-docs'))
" 2>/dev/null || echo "gameci-docs")
else
  EMBEDDING_MODEL="all-MiniLM-L6-v2"
  COLLECTION_NAME="gameci-docs"
fi

EMBEDDING_MODEL="${VECTOR_EMBEDDING_MODEL:-${EMBEDDING_MODEL}}"

# Parse arguments
MODE="all"
QUERY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --docs-only) MODE="docs"; shift ;;
    --query) QUERY="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Ensure dependencies are installed
ensure_deps() {
  echo "Checking vector search dependencies..."
  python3 -c "import chromadb; import sentence_transformers" 2>/dev/null || {
    echo "Installing chromadb and sentence-transformers..."
    pip install --quiet chromadb sentence-transformers 2>&1 || {
      echo "ERROR: Failed to install dependencies. Run:" >&2
      echo "  pip install chromadb sentence-transformers" >&2
      exit 1
    }
  }
  echo "Dependencies OK."
}

# Run the bake
bake() {
  echo "=== GameCI Help Bot -- Vector Bake ==="
  echo "Mode: ${MODE}"
  echo "Embedding model: ${EMBEDDING_MODEL}"
  echo "Collection: ${COLLECTION_NAME}"
  echo "Persist directory: ${VECTOR_DIR}"
  echo ""

  mkdir -p "${VECTOR_DIR}"

  python3 << 'PYEOF'
import os
import sys
import json
import glob

try:
    import chromadb
    from chromadb.config import Settings
    from sentence_transformers import SentenceTransformer
except ImportError as e:
    print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
    print("Run: pip install chromadb sentence-transformers", file=sys.stderr)
    sys.exit(1)

REPO_DIR = os.environ.get("REPO_DIR", ".")
VECTOR_DIR = os.environ.get("VECTOR_DIR", "data/vector-store")
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "gameci-docs")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
MODE = os.environ.get("MODE", "all")

print(f"Loading embedding model: {EMBEDDING_MODEL}...")
model = SentenceTransformer(EMBEDDING_MODEL)

print(f"Initializing ChromaDB at: {VECTOR_DIR}")
client = chromadb.Client(Settings(
    chroma_db_impl="duckdb+parquet",
    persist_directory=VECTOR_DIR,
    anonymized_telemetry=False
))

# Delete and recreate collection for fresh bake
try:
    client.delete_collection(COLLECTION_NAME)
except:
    pass
collection = client.create_collection(COLLECTION_NAME)

documents = []
metadatas = []
ids = []
doc_id = 0

# Ingest documentation pages
docs_dir = os.path.join(REPO_DIR, "data", "docs")
if os.path.isdir(docs_dir):
    for filepath in sorted(glob.glob(os.path.join(docs_dir, "*.md"))):
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        # Strip YAML frontmatter
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                frontmatter = content[3:end].strip()
                content = content[end + 3:].strip()
                # Extract source URL
                source = ""
                for line in frontmatter.split("\n"):
                    if line.startswith("source:"):
                        source = line.split(":", 1)[1].strip()

        # Chunk by sections (split on ## headers)
        chunks = []
        current = ""
        for line in content.split("\n"):
            if line.startswith("## ") and current.strip():
                chunks.append(current.strip())
                current = line + "\n"
            else:
                current += line + "\n"
        if current.strip():
            chunks.append(current.strip())

        basename = os.path.basename(filepath)
        for i, chunk in enumerate(chunks):
            if len(chunk) < 20:
                continue
            doc_id += 1
            documents.append(chunk[:2000])  # ChromaDB has size limits
            metadatas.append({
                "source": basename,
                "type": "docs",
                "chunk": i,
                "url": source if "source" in dir() else ""
            })
            ids.append(f"doc-{doc_id}")

    print(f"  Documentation: {doc_id} chunks from {len(glob.glob(os.path.join(docs_dir, '*.md')))} pages")

# Ingest GitHub issues (if not docs-only)
if MODE != "docs":
    issues_dir = os.path.join(REPO_DIR, "data", "github", "issues")
    issue_count = 0
    if os.path.isdir(issues_dir):
        for repo_dir in sorted(os.listdir(issues_dir)):
            repo_path = os.path.join(issues_dir, repo_dir)
            if not os.path.isdir(repo_path):
                continue
            for filepath in sorted(glob.glob(os.path.join(repo_path, "*.md"))):
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()

                # Extract title from frontmatter
                title = ""
                if content.startswith("---"):
                    end = content.find("---", 3)
                    if end != -1:
                        for line in content[3:end].split("\n"):
                            if line.startswith("title:"):
                                title = line.split(":", 1)[1].strip().strip('"')
                        content = content[end + 3:].strip()

                if len(content) < 20:
                    continue

                doc_id += 1
                issue_count += 1
                documents.append((title + "\n\n" + content)[:2000])
                metadatas.append({
                    "source": f"{repo_dir}/{os.path.basename(filepath)}",
                    "type": "issue",
                    "repo": repo_dir
                })
                ids.append(f"doc-{doc_id}")

    print(f"  GitHub issues: {issue_count} documents")

if not documents:
    print("No documents to index.")
    sys.exit(0)

# Generate embeddings and add to collection
print(f"Generating embeddings for {len(documents)} documents...")
embeddings = model.encode(documents, show_progress_bar=True).tolist()

# Add in batches (ChromaDB has batch size limits)
BATCH_SIZE = 100
for i in range(0, len(documents), BATCH_SIZE):
    end = min(i + BATCH_SIZE, len(documents))
    collection.add(
        documents=documents[i:end],
        embeddings=embeddings[i:end],
        metadatas=metadatas[i:end],
        ids=ids[i:end]
    )

client.persist()
print(f"Vector store built: {len(documents)} documents indexed.")
print(f"Persisted to: {VECTOR_DIR}")
PYEOF
}

# Run a query against the vector store
query() {
  echo "=== GameCI Help Bot -- Vector Search ==="
  echo "Query: ${QUERY}"
  echo ""

  QUERY="${QUERY}" python3 << 'PYEOF'
import os
import sys

try:
    import chromadb
    from chromadb.config import Settings
    from sentence_transformers import SentenceTransformer
except ImportError as e:
    print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

VECTOR_DIR = os.environ.get("VECTOR_DIR", "data/vector-store")
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "gameci-docs")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
QUERY = os.environ.get("QUERY", "")

if not QUERY:
    print("No query provided.")
    sys.exit(1)

model = SentenceTransformer(EMBEDDING_MODEL)
client = chromadb.Client(Settings(
    chroma_db_impl="duckdb+parquet",
    persist_directory=VECTOR_DIR,
    anonymized_telemetry=False
))

try:
    collection = client.get_collection(COLLECTION_NAME)
except:
    print("ERROR: Vector store not found. Run 'bash automation/vector-bake.sh' first.")
    sys.exit(1)

embedding = model.encode([QUERY]).tolist()
results = collection.query(query_embeddings=embedding, n_results=5)

print(f"Top {len(results['documents'][0])} results:\n")
for i, (doc, meta, dist) in enumerate(zip(
    results["documents"][0],
    results["metadatas"][0],
    results["distances"][0]
)):
    score = 1 - dist  # Convert distance to similarity
    print(f"--- Result {i+1} (similarity: {score:.3f}) ---")
    print(f"Source: {meta.get('source', 'unknown')} ({meta.get('type', 'unknown')})")
    print(f"Content: {doc[:300]}...")
    print()
PYEOF
}

# --- Main ---

ensure_deps

if [[ -n "$QUERY" ]]; then
  REPO_DIR="$REPO_DIR" VECTOR_DIR="$VECTOR_DIR" COLLECTION_NAME="$COLLECTION_NAME" \
    EMBEDDING_MODEL="$EMBEDDING_MODEL" QUERY="$QUERY" query
else
  REPO_DIR="$REPO_DIR" VECTOR_DIR="$VECTOR_DIR" COLLECTION_NAME="$COLLECTION_NAME" \
    EMBEDDING_MODEL="$EMBEDDING_MODEL" MODE="$MODE" bake
fi
