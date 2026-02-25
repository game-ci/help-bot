#!/usr/bin/env bash
# sync-github.sh
#
# Syncs GitHub issues and discussions from key GameCI repositories to the
# local filesystem for processing by the help bot.
#
# Uses the `gh` CLI (GitHub CLI) which must be authenticated.
#
# Output structure:
#   data/github/issues/{repo}/{number}.md       -- Issues with YAML frontmatter
#   data/github/discussions/{repo}/{number}.md   -- Discussions with YAML frontmatter
#
# Each file has YAML frontmatter with metadata (title, state, labels, author,
# dates) followed by the issue/discussion body as markdown.
#
# Optional environment variables:
#   SYNC_DAYS  -- How many days back to sync updated issues (default from config.json, fallback: 7)

set -euo pipefail

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${REPO_DIR}/data/github"
ISSUES_DIR="${DATA_DIR}/issues"
DISCUSSIONS_DIR="${DATA_DIR}/discussions"
CONFIG_FILE="${REPO_DIR}/config.json"

# Load settings from config.json if available
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 &>/dev/null; then
  CONFIG_SYNC_DAYS=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('github', {}).get('sync_days', 7))
" 2>/dev/null || echo "7")

  CONFIG_REPOS=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
repos = cfg.get('github', {}).get('repos', [])
print('|'.join(repos))
" 2>/dev/null || echo "")

  CONFIG_MAX_ISSUES=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('github', {}).get('max_issues_per_repo', 200))
" 2>/dev/null || echo "200")

  CONFIG_MAX_DISCUSSIONS=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
print(cfg.get('github', {}).get('max_discussions_per_repo', 50))
" 2>/dev/null || echo "50")
else
  CONFIG_SYNC_DAYS="7"
  CONFIG_REPOS=""
  CONFIG_MAX_ISSUES="200"
  CONFIG_MAX_DISCUSSIONS="50"
fi

SYNC_DAYS="${SYNC_DAYS:-${CONFIG_SYNC_DAYS}}"
MAX_ISSUES="${CONFIG_MAX_ISSUES}"
MAX_DISCUSSIONS="${CONFIG_MAX_DISCUSSIONS}"

# GameCI repositories to sync -- from config.json or fallback defaults
if [[ -n "$CONFIG_REPOS" ]]; then
  IFS='|' read -r -a REPOS <<< "$CONFIG_REPOS"
else
  REPOS=(
    "game-ci/unity-builder"
    "game-ci/unity-test-runner"
    "game-ci/unity-actions"
    "game-ci/docker"
    "game-ci/steam-deploy"
  )
fi

# --- Validation ---

if ! command -v gh &>/dev/null; then
  echo "ERROR: gh CLI is not installed. Install it from https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "ERROR: gh CLI is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

# --- Helper Functions ---

# Calculate the date N days ago in ISO format (YYYY-MM-DD)
days_ago_iso() {
  local days="$1"
  python3 -c "
from datetime import datetime, timedelta
print((datetime.now() - timedelta(days=${days})).strftime('%Y-%m-%d'))
" 2>/dev/null || {
    # Fallback for systems without python3
    if date -v-${days}d +%Y-%m-%d 2>/dev/null; then
      return
    fi
    date -d "${days} days ago" +%Y-%m-%d 2>/dev/null
  }
}

# Sync issues for a single repository.
# Fetches all open issues plus recently updated closed issues.
sync_repo_issues() {
  local repo="$1"
  local repo_short="${repo#*/}"  # e.g., "unity-builder" from "game-ci/unity-builder"
  local repo_dir="${ISSUES_DIR}/${repo_short}"
  local since_date
  since_date=$(days_ago_iso "${SYNC_DAYS}")

  echo "  Syncing issues..."
  mkdir -p "${repo_dir}"

  # Fetch open issues (these are always relevant)
  echo "    Fetching open issues (limit: ${MAX_ISSUES})..."
  local open_issues
  open_issues=$(gh issue list \
    --repo "${repo}" \
    --state open \
    --limit "${MAX_ISSUES}" \
    --json number,title,state,labels,author,createdAt,updatedAt,body,comments,url \
    2>/dev/null || echo "[]")

  # Fetch recently updated issues (includes closed ones that may have new comments)
  echo "    Fetching recently updated issues (since ${since_date})..."
  local updated_issues
  updated_issues=$(gh api \
    "repos/${repo}/issues?state=all&since=${since_date}T00:00:00Z&per_page=100&sort=updated&direction=desc" \
    2>/dev/null || echo "[]")

  # Process open issues from gh issue list (richer data with comments)
  local open_count
  open_count=$(echo "$open_issues" | python3 -c "
import sys, json
issues = json.load(sys.stdin)
print(len(issues) if isinstance(issues, list) else 0)
" 2>/dev/null || echo "0")

  echo "    Processing ${open_count} open issues..."

  echo "$open_issues" | python3 -c "
import sys, json

repo_short = '${repo_short}'
repo_dir = '${repo_dir}'

issues = json.load(sys.stdin)
if not isinstance(issues, list):
    sys.exit(0)

for issue in issues:
    number = issue.get('number', 0)
    title = issue.get('title', 'Untitled')
    state = issue.get('state', 'OPEN').upper()
    author = issue.get('author', {}).get('login', 'unknown') if issue.get('author') else 'unknown'
    created = issue.get('createdAt', '')
    updated = issue.get('updatedAt', '')
    url = issue.get('url', '')
    body = issue.get('body', '') or ''

    # Extract label names
    labels = [l.get('name', '') for l in issue.get('labels', []) if l.get('name')]
    labels_yaml = ', '.join(labels) if labels else ''

    # Extract comments
    comments = issue.get('comments', []) or []
    comment_count = len(comments)
    comments_section = ''
    if comments:
        comments_section = '\n\n## Comments\n\n'
        for c in comments:
            c_author = c.get('author', {}).get('login', 'unknown') if c.get('author') else 'unknown'
            c_date = c.get('createdAt', '')
            c_body = c.get('body', '') or ''
            comments_section += f'### @{c_author} ({c_date})\n\n{c_body}\n\n---\n\n'

    # Escape title for YAML (handle quotes and special chars)
    safe_title = title.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"')

    # Build the markdown file with YAML frontmatter
    content = f'''---
title: \"{safe_title}\"
number: {number}
state: {state}
labels: [{labels_yaml}]
author: {author}
created: {created}
updated: {updated}
url: {url}
repo: {repo_short}
comment_count: {comment_count}
---

{body}{comments_section}'''

    filepath = f'{repo_dir}/{number}.md'
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
" 2>/dev/null || echo "    Warning: Failed to process some open issues"

  # Process updated issues from the REST API (includes closed issues with recent activity)
  local updated_count
  updated_count=$(echo "$updated_issues" | python3 -c "
import sys, json
issues = json.load(sys.stdin)
count = 0
if isinstance(issues, list):
    for i in issues:
        if 'pull_request' not in i:
            count += 1
print(count)
" 2>/dev/null || echo "0")

  echo "    Processing ${updated_count} recently updated issues..."

  echo "$updated_issues" | python3 -c "
import sys, json, os

repo_short = '${repo_short}'
repo_dir = '${repo_dir}'

issues = json.load(sys.stdin)
if not isinstance(issues, list):
    sys.exit(0)

for issue in issues:
    # Skip pull requests (the issues API includes them)
    if 'pull_request' in issue:
        continue

    number = issue.get('number', 0)
    filepath = f'{repo_dir}/{number}.md'

    # Skip if already written by the open issues pass
    if os.path.exists(filepath):
        continue

    title = issue.get('title', 'Untitled')
    state = issue.get('state', 'open').upper()
    author = issue.get('user', {}).get('login', 'unknown')
    created = issue.get('created_at', '')
    updated = issue.get('updated_at', '')
    url = issue.get('html_url', '')
    body = issue.get('body', '') or ''
    labels = [l.get('name', '') for l in issue.get('labels', []) if l.get('name')]
    labels_yaml = ', '.join(labels) if labels else ''
    comment_count = issue.get('comments', 0)

    safe_title = title.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"')

    content = f'''---
title: \"{safe_title}\"
number: {number}
state: {state}
labels: [{labels_yaml}]
author: {author}
created: {created}
updated: {updated}
url: {url}
repo: {repo_short}
comment_count: {comment_count}
---

{body}'''

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
" 2>/dev/null || echo "    Warning: Failed to process some updated issues"

  local total_files
  total_files=$(find "${repo_dir}" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  echo "    Total issue files: ${total_files}"
}

# Sync discussions for a single repository (if the repo has discussions enabled).
sync_repo_discussions() {
  local repo="$1"
  local repo_short="${repo#*/}"
  local repo_dir="${DISCUSSIONS_DIR}/${repo_short}"

  echo "  Syncing discussions (limit: ${MAX_DISCUSSIONS})..."
  mkdir -p "${repo_dir}"

  # Fetch recent discussions using GraphQL via gh api
  local discussions
  discussions=$(gh api graphql -f query='
    query {
      repository(owner: "game-ci", name: "'"${repo_short}"'") {
        discussions(first: '"${MAX_DISCUSSIONS}"', orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number
            title
            body
            author { login }
            createdAt
            updatedAt
            url
            category { name }
            answer {
              body
              author { login }
              createdAt
            }
            comments(first: 10) {
              nodes {
                body
                author { login }
                createdAt
              }
            }
          }
        }
      }
    }
  ' 2>/dev/null || echo '{"data":null}')

  echo "$discussions" | python3 -c "
import sys, json

repo_short = '${repo_short}'
repo_dir = '${repo_dir}'

data = json.load(sys.stdin)
repo_data = (data.get('data') or {}).get('repository')
if not repo_data:
    print('    Discussions not enabled or no data for this repo.')
    sys.exit(0)

discussions = repo_data.get('discussions', {}).get('nodes', [])
if not discussions:
    print('    No discussions found.')
    sys.exit(0)

for d in discussions:
    number = d.get('number', 0)
    title = d.get('title', 'Untitled')
    body = d.get('body', '') or ''
    author = d.get('author', {}).get('login', 'unknown') if d.get('author') else 'unknown'
    created = d.get('createdAt', '')
    updated = d.get('updatedAt', '')
    url = d.get('url', '')
    category = d.get('category', {}).get('name', 'General') if d.get('category') else 'General'

    # Build comments section
    comments_section = ''
    comments = d.get('comments', {}).get('nodes', [])
    answer = d.get('answer')

    has_accepted_answer = answer is not None

    if answer:
        a_author = answer.get('author', {}).get('login', 'unknown') if answer.get('author') else 'unknown'
        a_date = answer.get('createdAt', '')
        a_body = answer.get('body', '') or ''
        comments_section += f'\n\n## Accepted Answer\n\n### @{a_author} ({a_date})\n\n{a_body}\n'

    comment_count = len(comments)
    if comments:
        comments_section += '\n\n## Comments\n\n'
        for c in comments:
            c_author = c.get('author', {}).get('login', 'unknown') if c.get('author') else 'unknown'
            c_date = c.get('createdAt', '')
            c_body = c.get('body', '') or ''
            comments_section += f'### @{c_author} ({c_date})\n\n{c_body}\n\n---\n\n'

    safe_title = title.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"')

    content = f'''---
title: \"{safe_title}\"
number: {number}
category: {category}
author: {author}
created: {created}
updated: {updated}
url: {url}
repo: {repo_short}
comment_count: {comment_count}
has_accepted_answer: {str(has_accepted_answer).lower()}
---

{body}{comments_section}'''

    filepath = f'{repo_dir}/{number}.md'
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

print(f'    Wrote {len(discussions)} discussion files.')
" 2>/dev/null || echo "    Warning: Failed to process discussions (may not be enabled)"
}

# --- Main Logic ---

echo "=== GameCI Help Bot -- GitHub Sync ==="
echo "Syncing issues updated in the last ${SYNC_DAYS} days"
echo "Repositories: ${REPOS[*]}"
echo "Data directory: ${DATA_DIR}"
echo ""

mkdir -p "${ISSUES_DIR}" "${DISCUSSIONS_DIR}"

TOTAL_ISSUES=0
TOTAL_DISCUSSIONS=0

for REPO in "${REPOS[@]}"; do
  echo ""
  echo "--- ${REPO} ---"
  sync_repo_issues "${REPO}"
  sync_repo_discussions "${REPO}"
done

echo ""
echo "=== GitHub sync complete ==="
# Summary: count all files
TOTAL_ISSUE_FILES=$(find "${ISSUES_DIR}" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
TOTAL_DISCUSSION_FILES=$(find "${DISCUSSIONS_DIR}" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
echo "Total issue files: ${TOTAL_ISSUE_FILES}"
echo "Total discussion files: ${TOTAL_DISCUSSION_FILES}"
