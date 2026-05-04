export function parseFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  if (!content.startsWith('---')) {
    return { meta: {}, body: content }
  }
  const end = content.indexOf('---', 3)
  if (end === -1) {
    return { meta: {}, body: content }
  }
  const metaRaw = content.slice(3, end).trim()
  const body = content.slice(end + 3).trim()
  const meta: Record<string, string> = {}
  for (const line of metaRaw.split(/\r?\n/)) {
    const [key, ...rest] = line.split(':')
    if (!key) continue
    meta[key.trim()] = normalizeFrontMatterValue(rest.join(':'))
  }
  return { meta, body }
}

function normalizeFrontMatterValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed

  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, '\'')
  }

  return trimmed
}
