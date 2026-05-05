import { request } from 'undici'
import { parse } from 'node-html-parser'
import TurndownService from 'turndown'
import { writeFile } from 'node:fs/promises'
import { ensureDir } from '../utils/fs'
import { DOCS_DATA_DIR } from '../utils/paths'
import { getConfig, getValue } from '../config'
import { join } from 'node:path'

const turndown = new TurndownService({ codeBlockStyle: 'fenced' })

async function fetchPage(page: string, baseUrl: string): Promise<void> {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const fullUrl = `${normalizedBase}/${page}`

  try {
    const url = fullUrl
    const response = await request(url, {
      headers: { 'User-Agent': 'GameCI Help Bot/TS' },
      maxRedirections: 5,
    })
    if (response.statusCode !== 200) {
      throw new Error(`Status ${response.statusCode}`)
    }
    const html = await response.body.text()
    const root = parse(html)
    const article =
      root.querySelector('article') ?? root.querySelector('main') ?? root.querySelector('.markdown')
    if (!article) {
      throw new Error('No article content found')
    }
    const markdown = turndown.turndown(article.toString()).trim()
    const output = join(DOCS_DATA_DIR, `${page.replace(/\//g, '--')}.md`)
    const text = `---
source: ${fullUrl}
---

${markdown}
`
    await ensureDir(DOCS_DATA_DIR)
    await writeFile(output, text, 'utf-8')
  } catch (error) {
    console.warn(`Failed to fetch ${fullUrl}: ${(error as Error).message}`)
  }
}

export async function syncDocs(): Promise<void> {
  const config = await getConfig()
  const baseUrl = (
    getValue(config, ['docs', 'base_url'], 'https://game.ci/docs') as string
  ).replace(/\/$/, '')
  const pages = getValue(
    config,
    ['docs', 'pages'],
    [
      'github/getting-started',
      'github/activation',
      'github/builder',
      'github/test-runner',
      'github/returning-a-license',
      'docker/docker-images',
      'docker/versions',
      'github/deployment/steam',
    ],
  ) as string[]

  await ensureDir(DOCS_DATA_DIR)
  for (const entry of pages) {
    console.log(`Fetching documentation page: ${entry}`)
    await fetchPage(entry, baseUrl)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
