import { describe, expect, it } from 'vitest'

import { parseFrontMatter } from './frontmatter'

describe('parseFrontMatter', () => {
  it('returns empty meta and the input as body when there is no frontmatter', () => {
    expect(parseFrontMatter('Hello, world')).toEqual({ meta: {}, body: 'Hello, world' })
  })

  it('returns empty meta and the input when frontmatter is unterminated', () => {
    const text = '---\ntitle: hello'
    expect(parseFrontMatter(text)).toEqual({ meta: {}, body: text })
  })

  it('parses simple key/value pairs', () => {
    const text = `---\ntitle: Hello\nauthor: Alice\n---\n\nbody`
    expect(parseFrontMatter(text)).toEqual({
      meta: { title: 'Hello', author: 'Alice' },
      body: 'body',
    })
  })

  it('strips matching double quotes from values', () => {
    const text = `---\ntitle: "Hello, World"\n---\n`
    expect(parseFrontMatter(text).meta.title).toBe('Hello, World')
  })

  it('strips matching single quotes from values', () => {
    const text = `---\ntitle: 'Hello, World'\n---\n`
    expect(parseFrontMatter(text).meta.title).toBe('Hello, World')
  })

  it('preserves colons in values when the value contains a colon', () => {
    const text = `---\nurl: https://example.com/path\n---\n`
    expect(parseFrontMatter(text).meta.url).toBe('https://example.com/path')
  })

  it('separates meta from body cleanly', () => {
    const text = `---\nfoo: 1\n---\n# Heading\n\nParagraph`
    const { body } = parseFrontMatter(text)
    expect(body).toBe('# Heading\n\nParagraph')
  })

  it('skips empty lines and lines without a key', () => {
    const text = `---\nfoo: 1\n\n: nokey\nbar: 2\n---\n`
    expect(parseFrontMatter(text).meta).toEqual({ foo: '1', bar: '2' })
  })
})
