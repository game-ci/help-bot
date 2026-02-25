#!/usr/bin/env bash
# sync-github.sh
#
# Syncs GitHub issues and discussions from key GameCI repositories to the
# local filesystem for processing by the help bot.
#
# Uses the `gh` CLI (GitHub CLI) which must be authenticated.
#
# Output structure:
#   data/github/issues/{repo}/{number}.md       — Issues with frontmatter
#   data/github/discussions/{repo}/{number}.md   — Discussions with frontmatter
#
# Each file has YAML frontmatter with metadata (title, state, labels, author,
# dates) followed by the issue/discussion body as markdown.
#
# Optional environment variables:
#   SYNC_DAYS  — How many days back to sync updated issues (default: 7)

set -euo pipefail

# --- Configuration ---

SYNC_DAYS="${SYNC_DAYS:-7}"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/github"
ISSUES_DIR="${DATA_DIR}/issues"
DISCUSSIONS_DIR="${DATA_DIR}/discussions"

# GameCI repositories to sync
REPOS=(
  "game-ci/unity-builder"
  "game-ci/unity-test-runner"
  "game-ci/unity-actions"
  "game-ci/docker"
  "game-ci/steam-deploy"
)

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
  if date -v-${days}d +%Y-%m-%d 2>/dev/null; then
    # macOS date
    return
  fi
  # GNU date (Linux)
  date -d "${days} days ago" +%Y-%m-%d 2>/dev/null || {
    # Fallback: use python
    python3 -c "from datetime import datetime, timedelta; print((datetime.now() - timedelta(days=${days})).strftime('%Y-%m-%d'))"
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
  echo "    Fetching open issues..."
  local open_issues
  open_issues=$(gh issue list \
    --repo "${repo}" \
    --state open \
    --limit 200 \
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

  echo "$open_issues" | python3 -c "
import sys, json

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
    labels_yaml = ', '.join(labels) if labels else '[]'

    # Extract comments
    comments = issue.get('comments', []) or []
    comments_section = ''
    if comments:
        comments_section = '\n\n## Comments\n\n'
        for c in comments:
            c_author = c.get('author', {}).get('login', 'unknown') if c.get('author') else 'unknown'
            c_date = c.get('createdAt', '')
            c_body = c.get('body', '') or ''
            comments_section += f'### @{c_author} ({c_date})\n\n{c_body}\n\n---\n\n'

    # Build the markdown file with YAML frontmatter
    content = f'''---
title: \"{title.replace('\"', '\\\\\"')}\"
number: {number}
state: {state}
labels: [{labels_yaml}]
author: {author}
created: {created}
updated: {updated}
url: {url}
repo: ${repo_short}
---

{body}{comments_section}'''

    # Write to a file
    filepath = '${repo_dir}/{number}.md'.format(number=number)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
" 2>/dev/null || echo "    Warning: Failed to process some open issues"

  # Process updated issues from the REST API (includes closed issues with recent activity)
  echo "$updated_issues" | python3 -c "
import sys, json, os

issues = json.load(sys.stdin)
if not isinstance(issues, list):
    sys.exit(0)

for issue in issues:
    # Skip pull requests (the issues API includes them)
    if 'pull_request' in issue:
        continue

    number = issue.get('number', 0)
    filepath = '${repo_dir}/{number}.md'.format(number=number)

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
    labels_yaml = ', '.join(labels) if labels else '[]'

    content = f'''---
title: \"{title.replace('\"', '\\\\\"')}\"
number: {number}
state: {state}
labels: [{labels_yaml}]
author: {author}
created: {created}
updated: {updated}
url: {url}
repo: ${repo_short}
---

{body}'''

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
" 2>/dev/null || echo "    Warning: Failed to process some updated issues"

  echo "    Wrote issues to ${repo_dir}/"
  local total_files
  total_files=$(find "${repo_dir}" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  echo "    Total issue files: ${total_files}"
}

# Sync discussions for a single repository (if the repo has discussions enabled).
sync_repo_discussions() {
  local repo="$1"
  local repo_short="${repo#*/}"
  local repo_dir="${DISCUSSIONS_DIR}/${repo_short}"

  echo "  Syncing discussions..."
  mkdir -p "${repo_dir}"

  # Fetch recent discussions using GraphQL via gh api
  local discussions
  discussions=$(gh api graphql -f query='
    query {
      repository(owner: "game-ci", name: "'"${repo_short}"'") {
        discussions(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
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

    if answer:
        a_author = answer.get('author', {}).get('login', 'unknown') if answer.get('author') else 'unknown'
        a_date = answer.get('createdAt', '')
        a_body = answer.get('body', '') or ''
        comments_section += f'\n\n## Accepted Answer\n\n### @{a_author} ({a_date})\n\n{a_body}\n'

    if comments:
        comments_section += '\n\n## Comments\n\n'
        for c in comments:
            c_author = c.get('author', {}).get('login', 'unknown') if c.get('author') else 'unknown'
            c_date = c.get('createdAt', '')
            c_body = c.get('body', '') or ''
            comments_section += f'### @{c_author} ({c_date})\n\n{c_body}\n\n---\n\n'

    content = f'''---
title: \"{title.replace('\"', '\\\\\"')}\"
number: {number}
category: {category}
author: {author}
created: {created}
updated: {updated}
url: {url}
repo: ${repo_short}
---

{body}{comments_section}'''

    filepath = '${repo_dir}/{number}.md'.format(number=number)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

print(f'    Wrote {len(discussions)} discussion files to ${repo_dir}/')
" 2>/dev/null || echo "    Warning: Failed to process discussions (may not be enabled)"
}

# --- Main Logic ---

echo "=== GameCI Help Bot — GitHub Sync ==="
echo "Syncing issues updated in the last ${SYNC_DAYS} days"
echo "Data directory: ${DATA_DIR}"
echo ""

mkdir -p "${ISSUES_DIR}" "${DISCUSSIONS_DIR}"

for REPO in "${REPOS[@]}"; do
  echo ""
  echo "--- ${REPO} ---"
  sync_repo_issues "${REPO}"
  sync_repo_discussions "${REPO}"
done

echo ""
echo "=== GitHub sync complete ==="
