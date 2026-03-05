import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { getConfig, getValue } from '../config'
import { REPO_ROOT } from '../utils/paths'
import { ensureDir } from '../utils/fs'

interface VectorBakeOptions {
  docsOnly?: boolean
  query?: string
  clean?: boolean
}

const VECTOR_BAKE_SCRIPT = String.raw`import glob
import json
import os
import sys

try:
    from llama_index.core import Document, Settings, StorageContext, VectorStoreIndex
    from llama_index.core.node_parser import SentenceSplitter
except ImportError as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    sys.exit(1)

try:
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
except ImportError:
    HuggingFaceEmbedding = None

REPO_DIR = os.environ.get("REPO_DIR", ".")
VECTOR_DIR = os.environ.get("VECTOR_DIR", "data/vector-store")
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "gameci-docs")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "local:BAAI/bge-small-en-v1.5")
MODE = os.environ.get("MODE", "all")

Settings.chunk_size = 2000
Settings.chunk_overlap = 200
Settings.llm = None

if HuggingFaceEmbedding:
    model_name = EMBEDDING_MODEL.split(":", 1)[1] if EMBEDDING_MODEL.startswith("local:") else EMBEDDING_MODEL
    try:
        Settings.embed_model = HuggingFaceEmbedding(model_name=model_name)
    except Exception as exc:
        print(f"WARNING: Unable to load embedding model: {exc}", file=sys.stderr)
else:
    print("Using default LlamaIndex embedding model (HuggingFaceEmbedding not available)", file=sys.stderr)

documents = []

docs_dir = os.path.join(REPO_DIR, "data", "docs")
if os.path.isdir(docs_dir):
    doc_files = sorted(glob.glob(os.path.join(docs_dir, "*.md")))
    for filepath in doc_files:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        source = ""
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                frontmatter = content[3:end].strip()
                content = content[end + 3:].strip()
                for line in frontmatter.splitlines():
                    if line.startswith("source:"):
                        source = line.split(":", 1)[1].strip()
        if len(content) < 20:
            continue
        documents.append(Document(
            text=content,
            metadata={
                "source": os.path.basename(filepath),
                "type": "docs",
                "url": source,
            },
        ))
    print(f"  Documentation: {len(doc_files)} pages loaded")

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
                title = ""
                if content.startswith("---"):
                    end = content.find("---", 3)
                    if end != -1:
                        frontmatter = content[3:end]
                        for line in frontmatter.splitlines():
                            if line.strip().startswith("title:"):
                                title = line.split(":", 1)[1].strip().strip('"')
                        content = content[end + 3:].strip()
                text_value = f"{title}\n\n{content}" if title else content
                if len(text_value) < 20:
                    continue
                issue_count += 1
                documents.append(Document(
                    text=text_value,
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

print(f"Building vector index for {len(documents)} documents (mode: {MODE})...")
node_parser = SentenceSplitter(chunk_size=2000, chunk_overlap=200)
index = VectorStoreIndex.from_documents(
    documents,
    transformations=[node_parser],
    show_progress=True,
)
index.storage_context.persist(persist_dir=VECTOR_DIR)
print(f"Vector store built: {len(documents)} documents indexed.")
print(f"Persisted to: {VECTOR_DIR}")

`

async function detectPython(): Promise<string> {
  const candidates = ['python3', 'python']
  for (const candidate of candidates) {
    try {
      const proc = spawn(candidate, ['--version'], { stdio: 'ignore' })
      const [code] = (await once(proc, 'exit')) as [number, string | null]
      if (code === 0) {
        return candidate
      }
    } catch {
      // try next
    }
  }
  throw new Error('Python 3 is required to build the vector store.')
}

async function ensureLlamaIndex(python: string): Promise<void> {
  try {
    const probe = spawn(python, ['-c', 'import llama_index'], { stdio: 'ignore' })
    const [code] = (await once(probe, 'exit')) as [number, string | null]
    if (code === 0) {
      return
    }
  } catch {
    // fallthrough to install
  }
  const installer = spawn(python, ['-m', 'pip', 'install', 'llama-index'], { stdio: 'inherit' })
  const [installCode] = (await once(installer, 'exit')) as [number, string | null]
  if (installCode !== 0) {
    throw new Error('Failed to install llama-index. Please run `python -m pip install llama-index` manually.')
  }
}

export async function vectorBake(options: VectorBakeOptions = {}): Promise<void> {
  const config = await getConfig()
  const vectorConfig = (getValue(config, ['vector_search'], {}) as Record<string, unknown>)
  const embeddingModel = (vectorConfig['embedding_model'] as string) ?? 'local:BAAI/bge-small-en-v1.5'
  const collectionName = (vectorConfig['collection_name'] as string) ?? 'gameci-docs'
  const persistDirValue = (vectorConfig['persist_directory'] as string) ?? 'data/vector-store'
  const persistDir = join(REPO_ROOT, persistDirValue)
  await ensureDir(persistDir)

  const python = await detectPython()
  await ensureLlamaIndex(python)

  if (options.clean) {
    const rm = await import('node:fs/promises').then((mod) => mod.rm)
    await rm(persistDir, { recursive: true, force: true })
  }
  const mode = options.docsOnly ? 'docs' : 'all'
  const env = Object.assign({}, process.env, {
    REPO_DIR: REPO_ROOT,
    VECTOR_DIR: persistDir,
    EMBEDDING_MODEL: embeddingModel,
    COLLECTION_NAME: collectionName,
    MODE: mode,
    QUERY: options.query ?? '',
  })

  const proc = spawn(python, ['-'], { cwd: REPO_ROOT, env, stdio: ['pipe', 'inherit', 'inherit'] })
  proc.stdin.end(VECTOR_BAKE_SCRIPT)
  const [code] = (await once(proc, 'exit')) as [number, string | null]
  if (code !== 0) {
    throw new Error('vector-bake script failed; check the logs above for details.')
  }
}
