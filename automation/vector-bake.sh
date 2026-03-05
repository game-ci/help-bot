#!/usr/bin/env bash
# vector-bake.sh
#
# Optional: Builds a vector search index from synced documentation and community
# data. This creates embeddings that can be searched alongside the text file
# approach for improved answer retrieval.
#
# Requires: python3, pip (llama-index will be installed)
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
print(cfg.get('vector_search', {}).get('embedding_model', 'local:BAAI/bge-small-en-v1.5'))
" 2>/dev/null || echo "local:BAAI/bge-small-en-v1.5")

  COLLECTION_NAME=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('vector_search', {}).get('collection_name', 'gameci-docs'))
" 2>/dev/null || echo "gameci-docs")
else
  EMBEDDING_MODEL="local:BAAI/bge-small-en-v1.5"
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
  python3 -c "import llama_index" 2>/dev/null || {
    echo "Installing llama-index..."
    pip install --quiet llama-index 2>&1 || {
      echo "ERROR: Failed to install dependencies. Run:" >&2
      echo "  pip install llama-index" >&2
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
    from llama_index.core import (
        SimpleDirectoryReader,
        VectorStoreIndex,
        Document,
        StorageContext,
        Settings,
    )
    from llama_index.core.node_parser import SentenceSplitter
except ImportError as e:
    print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
    print("Run: pip install llama-index", file=sys.stderr)
    sys.exit(1)

REPO_DIR = os.environ.get("REPO_DIR", ".")
VECTOR_DIR = os.environ.get("VECTOR_DIR", "data/vector-store")
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "gameci-docs")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "local:BAAI/bge-small-en-v1.5")
MODE = os.environ.get("MODE", "all")

# Configure LlamaIndex settings
Settings.chunk_size = 2000
Settings.chunk_overlap = 200

# Set embedding model
try:
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    if EMBEDDING_MODEL.startswith("local:"):
        model_name = EMBEDDING_MODEL.split(":", 1)[1]
    else:
        model_name = EMBEDDING_MODEL
    print(f"Loading embedding model: {model_name}...")
    Settings.embed_model = HuggingFaceEmbedding(model_name=model_name)
except ImportError:
    print("Using default LlamaIndex embedding model...")

# Disable LLM (we only need embeddings for indexing)
Settings.llm = None

documents = []

# Ingest documentation pages
docs_dir = os.path.join(REPO_DIR, "data", "docs")
if os.path.isdir(docs_dir):
    doc_files = sorted(glob.glob(os.path.join(docs_dir, "*.md")))
    for filepath in doc_files:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        # Strip YAML frontmatter and extract source URL
        source = ""
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                frontmatter = content[3:end].strip()
                content = content[end + 3:].strip()
                for line in frontmatter.split("\n"):
                    if line.startswith("source:"):
                        source = line.split(":", 1)[1].strip()

        basename = os.path.basename(filepath)
        if len(content) >= 20:
            documents.append(Document(
                text=content,
                metadata={
                    "source": basename,
                    "type": "docs",
                    "url": source,
                },
            ))

    print(f"  Documentation: {len(doc_files)} pages loaded")

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

                issue_count += 1
                documents.append(Document(
                    text=(title + "\n\n" + content) if title else content,
                    metadata={
                        "source": f"{repo_dir}/{os.path.basename(filepath)}",
                        "type": "issue",
                        "repo": repo_dir,
                    },
                ))

    print(f"  GitHub issues: {issue_count} documents")

if not documents:
    print("No documents to index.")
    sys.exit(0)

# Build the index
print(f"Building vector index for {len(documents)} documents...")
node_parser = SentenceSplitter(chunk_size=2000, chunk_overlap=200)
index = VectorStoreIndex.from_documents(
    documents,
    transformations=[node_parser],
    show_progress=True,
)

# Persist to disk
index.storage_context.persist(persist_dir=VECTOR_DIR)
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
    from llama_index.core import (
        StorageContext,
        load_index_from_storage,
        Settings,
    )
except ImportError as e:
    print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

VECTOR_DIR = os.environ.get("VECTOR_DIR", "data/vector-store")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "local:BAAI/bge-small-en-v1.5")
QUERY = os.environ.get("QUERY", "")

if not QUERY:
    print("No query provided.")
    sys.exit(1)

# Configure embedding model
try:
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    if EMBEDDING_MODEL.startswith("local:"):
        model_name = EMBEDDING_MODEL.split(":", 1)[1]
    else:
        model_name = EMBEDDING_MODEL
    Settings.embed_model = HuggingFaceEmbedding(model_name=model_name)
except ImportError:
    pass

# Disable LLM (we only need retrieval, not generation)
Settings.llm = None

try:
    storage_context = StorageContext.from_defaults(persist_dir=VECTOR_DIR)
    index = load_index_from_storage(storage_context)
except Exception:
    print("ERROR: Vector store not found. Run 'bash automation/vector-bake.sh' first.")
    sys.exit(1)

retriever = index.as_retriever(similarity_top_k=5)
results = retriever.retrieve(QUERY)

print(f"Top {len(results)} results:\n")
for i, node in enumerate(results):
    score = node.score if node.score is not None else 0.0
    meta = node.metadata
    print(f"--- Result {i+1} (similarity: {score:.3f}) ---")
    print(f"Source: {meta.get('source', 'unknown')} ({meta.get('type', 'unknown')})")
    print(f"Content: {node.text[:300]}...")
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
