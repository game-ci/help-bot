#!/usr/bin/env bash
# sync-docs.sh
#
# Downloads GameCI documentation pages from game.ci/docs and saves them as
# markdown files to data/docs/ for use by the help bot.
#
# Uses curl to download HTML pages and python3 to extract content from the
# Docusaurus-based game.ci site, converting to markdown.
#
# Output structure:
#   data/docs/{section}--{page-slug}.md
#
# Requires: curl, python3

set -euo pipefail

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${REPO_DIR}/data/docs"
CONFIG_FILE="${REPO_DIR}/config.json"

# Load settings from config.json if available
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
  DOCS_BASE_URL=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('docs', {}).get('base_url', 'https://game.ci/docs'))
" 2>/dev/null || echo "https://game.ci/docs")

  CONFIG_PAGES=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
pages = cfg.get('docs', {}).get('pages', [])
for p in pages:
    # Convert url path to output filename: github/builder -> github--builder.md
    filename = p.replace('/', '--') + '.md'
    print(f'{p}|{filename}')
" 2>/dev/null || echo "")
else
  DOCS_BASE_URL="https://game.ci/docs"
  CONFIG_PAGES=""
fi

# Known documentation pages to download.
# Format: "url_path|output_filename"
# If config.json provides pages, use those; otherwise use the default list.
if [[ -n "$CONFIG_PAGES" ]]; then
  IFS=$'\n' read -r -d '' -a PAGES <<< "$CONFIG_PAGES" || true
else
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
  )
fi

# --- Helper Functions ---

# Download a documentation page and convert to markdown.
# Usage: download_page "github/builder" "github--builder.md"
download_page() {
  local url_path="$1"
  local output_file="$2"
  local full_url="${DOCS_BASE_URL}/${url_path}"
  local output_path="${DATA_DIR}/${output_file}"

  echo "  Downloading: ${full_url}"

  # Download the HTML page with a reasonable timeout and user agent
  local html
  html=$(curl -s -L --max-time 30 \
    -H "User-Agent: GameCI-HelpBot/2.0 (https://github.com/game-ci/help-bot)" \
    "${full_url}" 2>/dev/null || echo "")

  if [[ -z "$html" ]]; then
    echo "    WARNING: Failed to download ${full_url}"
    return 1
  fi

  # Check for common error pages
  if echo "$html" | grep -q "404" | head -1 && echo "$html" | grep -q "not found" | head -1; then
    echo "    WARNING: Page appears to be 404: ${full_url}"
    return 1
  fi

  # Convert HTML to markdown using Python.
  # Extracts from the Docusaurus article/main content area, converts common
  # HTML elements to markdown, and strips remaining tags.
  python3 << 'PYEOF' > "${output_path}" 2>/dev/null
import sys
import re
from html import unescape

# Read HTML from file descriptor (passed via heredoc redirection below)
import os
html_file = os.environ.get('HTML_FILE', '')
if html_file and os.path.exists(html_file):
    with open(html_file, 'r', encoding='utf-8', errors='replace') as f:
        html = f.read()
else:
    html = sys.stdin.read()

full_url = os.environ.get('FULL_URL', '')

# Try to extract the main content area (game.ci uses Docusaurus)
main_match = re.search(r'<article[^>]*>(.*?)</article>', html, re.DOTALL)
if not main_match:
    main_match = re.search(r'<main[^>]*>(.*?)</main>', html, re.DOTALL)
if not main_match:
    main_match = re.search(r'<div\s+class="[^"]*markdown[^"]*"[^>]*>(.*?)</div>', html, re.DOTALL)
if not main_match:
    main_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)

if not main_match:
    print(f'---\nsource: {full_url}\n---\n\nFailed to extract content from page.', file=sys.stderr)
    sys.exit(1)

content = main_match.group(1)

# Remove script and style tags entirely
content = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL)
content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.DOTALL)

# Remove navigation elements
content = re.sub(r'<nav[^>]*>.*?</nav>', '', content, flags=re.DOTALL)
content = re.sub(r'<footer[^>]*>.*?</footer>', '', content, flags=re.DOTALL)

# Convert common HTML elements to markdown
# Headers
for i in range(6, 0, -1):
    content = re.sub(
        rf'<h{i}[^>]*>(.*?)</h{i}>',
        lambda m, level=i: '\n' + '#' * level + ' ' + m.group(1).strip() + '\n',
        content, flags=re.DOTALL
    )

# Code blocks (pre > code with language class)
content = re.sub(
    r'<pre[^>]*><code[^>]*class="[^"]*language-(\w+)"[^>]*>(.*?)</code></pre>',
    lambda m: f'\n```{m.group(1)}\n{unescape(m.group(2)).strip()}\n```\n',
    content, flags=re.DOTALL
)
content = re.sub(
    r'<pre[^>]*><code[^>]*>(.*?)</code></pre>',
    lambda m: f'\n```\n{unescape(m.group(1)).strip()}\n```\n',
    content, flags=re.DOTALL
)

# Inline code
content = re.sub(r'<code[^>]*>(.*?)</code>', r'`\1`', content, flags=re.DOTALL)

# Bold and italic
content = re.sub(r'<strong[^>]*>(.*?)</strong>', r'**\1**', content, flags=re.DOTALL)
content = re.sub(r'<em[^>]*>(.*?)</em>', r'*\1*', content, flags=re.DOTALL)

# Links -- convert relative to absolute
def fix_link(m):
    href = m.group(1)
    text = m.group(2).strip()
    if href.startswith('/'):
        href = f'https://game.ci{href}'
    elif href.startswith('#'):
        pass  # Keep anchor links as-is
    return f'[{text}]({href})'

content = re.sub(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', fix_link, content, flags=re.DOTALL)

# List items
content = re.sub(r'<li[^>]*>(.*?)</li>', r'- \1', content, flags=re.DOTALL)

# Table handling (basic)
content = re.sub(r'<th[^>]*>(.*?)</th>', r'| \1 ', content, flags=re.DOTALL)
content = re.sub(r'<td[^>]*>(.*?)</td>', r'| \1 ', content, flags=re.DOTALL)
content = re.sub(r'<tr[^>]*>(.*?)</tr>', r'\1|\n', content, flags=re.DOTALL)

# Paragraphs and line breaks
content = re.sub(r'<p[^>]*>(.*?)</p>', r'\n\1\n', content, flags=re.DOTALL)
content = re.sub(r'<br\s*/?>', '\n', content)

# Blockquotes
content = re.sub(r'<blockquote[^>]*>(.*?)</blockquote>',
    lambda m: '\n' + '\n'.join('> ' + line for line in m.group(1).strip().split('\n')) + '\n',
    content, flags=re.DOTALL
)

# Strip all remaining HTML tags
content = re.sub(r'<[^>]+>', '', content)

# Unescape HTML entities
content = unescape(content)

# Clean up whitespace
content = re.sub(r'\n{3,}', '\n\n', content)
content = re.sub(r'[ \t]+\n', '\n', content)  # Trailing whitespace
content = content.strip()

# Add source header
print(f'---\nsource: {full_url}\n---\n\n{content}')
PYEOF

  # The python script needs the HTML and URL -- pass via temp file and env vars
  local tmpfile
  tmpfile=$(mktemp)
  echo "$html" > "$tmpfile"

  FULL_URL="${full_url}" HTML_FILE="${tmpfile}" python3 << 'PYEOF' > "${output_path}" 2>/dev/null
import sys
import re
import os
from html import unescape

html_file = os.environ.get('HTML_FILE', '')
full_url = os.environ.get('FULL_URL', '')

with open(html_file, 'r', encoding='utf-8', errors='replace') as f:
    html = f.read()

# Try to extract the main content area (game.ci uses Docusaurus)
main_match = re.search(r'<article[^>]*>(.*?)</article>', html, re.DOTALL)
if not main_match:
    main_match = re.search(r'<main[^>]*>(.*?)</main>', html, re.DOTALL)
if not main_match:
    main_match = re.search(r'<div\s+class="[^"]*markdown[^"]*"[^>]*>(.*?)</div>', html, re.DOTALL)
if not main_match:
    main_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)

if not main_match:
    print(f'---\nsource: {full_url}\n---\n\nFailed to extract content from page.')
    sys.exit(0)

content = main_match.group(1)

# Remove script, style, nav, footer tags
content = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL)
content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.DOTALL)
content = re.sub(r'<nav[^>]*>.*?</nav>', '', content, flags=re.DOTALL)
content = re.sub(r'<footer[^>]*>.*?</footer>', '', content, flags=re.DOTALL)

# Headers
for i in range(6, 0, -1):
    pattern = rf'<h{i}[^>]*>(.*?)</h{i}>'
    prefix = '#' * i
    content = re.sub(pattern, lambda m, p=prefix: f'\n{p} {m.group(1).strip()}\n', content, flags=re.DOTALL)

# Code blocks
content = re.sub(
    r'<pre[^>]*><code[^>]*class="[^"]*language-(\w+)"[^>]*>(.*?)</code></pre>',
    lambda m: f'\n```{m.group(1)}\n{unescape(m.group(2)).strip()}\n```\n',
    content, flags=re.DOTALL
)
content = re.sub(
    r'<pre[^>]*><code[^>]*>(.*?)</code></pre>',
    lambda m: f'\n```\n{unescape(m.group(1)).strip()}\n```\n',
    content, flags=re.DOTALL
)

# Inline code
content = re.sub(r'<code[^>]*>(.*?)</code>', r'`\1`', content, flags=re.DOTALL)

# Bold and italic
content = re.sub(r'<strong[^>]*>(.*?)</strong>', r'**\1**', content, flags=re.DOTALL)
content = re.sub(r'<em[^>]*>(.*?)</em>', r'*\1*', content, flags=re.DOTALL)

# Links
def fix_link(m):
    href = m.group(1)
    text = m.group(2).strip()
    if href.startswith('/'):
        href = f'https://game.ci{href}'
    return f'[{text}]({href})'
content = re.sub(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', fix_link, content, flags=re.DOTALL)

# List items
content = re.sub(r'<li[^>]*>(.*?)</li>', r'- \1', content, flags=re.DOTALL)

# Paragraphs and line breaks
content = re.sub(r'<p[^>]*>(.*?)</p>', r'\n\1\n', content, flags=re.DOTALL)
content = re.sub(r'<br\s*/?>', '\n', content)

# Strip all remaining HTML tags
content = re.sub(r'<[^>]+>', '', content)

# Unescape HTML entities
content = unescape(content)

# Clean up whitespace
content = re.sub(r'\n{3,}', '\n\n', content)
content = re.sub(r'[ \t]+\n', '\n', content)
content = content.strip()

print(f'---\nsource: {full_url}\n---\n\n{content}')
PYEOF

  rm -f "$tmpfile"

  if [[ -s "${output_path}" ]]; then
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

echo "=== GameCI Help Bot -- Documentation Sync ==="
echo "Downloading ${#PAGES[@]} documentation pages"
echo "Base URL: ${DOCS_BASE_URL}"
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
  # Small delay between downloads to be polite
  sleep 0.5
done

echo ""
echo "=== Documentation sync complete ==="
echo "  Successful: ${SUCCESS}"
echo "  Failed: ${FAILED}"
echo "  Total pages: ${#PAGES[@]}"
