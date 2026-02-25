#!/usr/bin/env bash
# sync-docs.sh
#
# Downloads GameCI documentation pages from game.ci/docs and saves them as
# markdown files to data/docs/ for use by the help bot.
#
# This uses a simple approach: download a known list of documentation pages
# via curl and convert HTML to a readable text/markdown format. The page list
# is maintained manually — add new pages as the docs site evolves.
#
# Requires: curl, python3 (for HTML-to-text conversion)
#
# Output structure:
#   data/docs/{section}--{page-slug}.md

set -euo pipefail

# --- Configuration ---

DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/docs"
DOCS_BASE_URL="https://game.ci/docs"

# Known documentation pages to download.
# Format: "url_path|output_filename"
# Update this list when new pages are added to game.ci/docs.
PAGES=(
  # Getting Started
  "github/getting-started|github--getting-started.md"
  "github/activation|github--activation.md"

  # Builder
  "github/builder|github--builder.md"

  # Test Runner
  "github/test-runner|github--test-runner.md"

  # Returning a License
  "github/returning-a-license|github--returning-a-license.md"

  # Docker
  "docker/docker-images|docker--docker-images.md"
  "docker/versions|docker--versions.md"

  # Deployment
  "github/deployment/steam|github--deployment--steam.md"

  # Other pages (add as discovered)
  # "path/to/page|filename.md"
)

# --- Helper Functions ---

# Download a documentation page and convert to markdown.
# Usage: download_page "github/builder" "github--builder.md"
download_page() {
  local url_path="$1"
  local output_file="$2"
  local full_url="${DOCS_BASE_URL}/${url_path}"
  local output_path="${DATA_DIR}/${output_file}"

  echo "  Downloading: ${full_url}"

  # Download the HTML page
  local html
  html=$(curl -s -L --max-time 30 "${full_url}" 2>/dev/null || echo "")

  if [[ -z "$html" ]]; then
    echo "    WARNING: Failed to download ${full_url}"
    return 1
  fi

  # Convert HTML to markdown-like text using Python.
  # This is a simple extraction — it pulls text from the main content area,
  # strips HTML tags, and preserves basic structure.
  python3 -c "
import sys
import re
from html import unescape

html = sys.stdin.read()

# Try to extract the main content area (game.ci uses Docusaurus)
# Look for the article or main content div
main_match = re.search(r'<article[^>]*>(.*?)</article>', html, re.DOTALL)
if not main_match:
    main_match = re.search(r'<main[^>]*>(.*?)</main>', html, re.DOTALL)
if not main_match:
    # Fallback: use the whole body
    main_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)

if not main_match:
    print('Failed to extract content', file=sys.stderr)
    sys.exit(1)

content = main_match.group(1)

# Convert common HTML elements to markdown
# Headers
for i in range(6, 0, -1):
    content = re.sub(rf'<h{i}[^>]*>(.*?)</h{i}>', r'\\n' + '#' * i + r' \\1\\n', content, flags=re.DOTALL)

# Code blocks
content = re.sub(r'<pre[^>]*><code[^>]*class=\"[^\"]*language-(\w+)\"[^>]*>(.*?)</code></pre>',
                  r'\\n\`\`\`\\1\\n\\2\\n\`\`\`\\n', content, flags=re.DOTALL)
content = re.sub(r'<pre[^>]*><code[^>]*>(.*?)</code></pre>',
                  r'\\n\`\`\`\\n\\1\\n\`\`\`\\n', content, flags=re.DOTALL)

# Inline code
content = re.sub(r'<code[^>]*>(.*?)</code>', r'\`\\1\`', content, flags=re.DOTALL)

# Bold and italic
content = re.sub(r'<strong[^>]*>(.*?)</strong>', r'**\\1**', content, flags=re.DOTALL)
content = re.sub(r'<em[^>]*>(.*?)</em>', r'*\\1*', content, flags=re.DOTALL)

# Links
content = re.sub(r'<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>', r'[\\2](\\1)', content, flags=re.DOTALL)

# List items
content = re.sub(r'<li[^>]*>(.*?)</li>', r'- \\1', content, flags=re.DOTALL)

# Paragraphs and line breaks
content = re.sub(r'<p[^>]*>(.*?)</p>', r'\\n\\1\\n', content, flags=re.DOTALL)
content = re.sub(r'<br\s*/?>', r'\\n', content)

# Strip all remaining HTML tags
content = re.sub(r'<[^>]+>', '', content)

# Unescape HTML entities
content = unescape(content)

# Clean up whitespace
content = re.sub(r'\\n{3,}', '\\n\\n', content)
content = content.strip()

# Add a source header
source_url = '${full_url}'
print(f'---\\nsource: {source_url}\\n---\\n\\n{content}')
" <<< "$html" > "${output_path}" 2>/dev/null

  if [[ $? -eq 0 ]] && [[ -s "${output_path}" ]]; then
    local size
    size=$(wc -c < "${output_path}" | tr -d ' ')
    echo "    Saved: ${output_file} (${size} bytes)"
  else
    echo "    WARNING: Failed to process ${full_url}"
    rm -f "${output_path}"
    return 1
  fi
}

# --- Main Logic ---

echo "=== GameCI Help Bot — Documentation Sync ==="
echo "Downloading ${#PAGES[@]} documentation pages"
echo "Data directory: ${DATA_DIR}"
echo ""

mkdir -p "${DATA_DIR}"

SUCCESS=0
FAILED=0

for PAGE_ENTRY in "${PAGES[@]}"; do
  IFS='|' read -r URL_PATH OUTPUT_FILE <<< "${PAGE_ENTRY}"
  if download_page "${URL_PATH}" "${OUTPUT_FILE}"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "=== Documentation sync complete ==="
echo "  Successful: ${SUCCESS}"
echo "  Failed: ${FAILED}"
echo "  Total pages: ${#PAGES[@]}"
