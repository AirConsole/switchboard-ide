import { describe, expect, it } from 'vitest'
import { brokenUrlsAt, type Row } from '../src/terminal/brokenUrls.js'

/*
 * Claude Code writes its own line breaks, so a URL longer than the room left on
 * its line reaches the terminal as two unrelated lines and only the first half
 * was a link. The rows are what a builders pane 82 columns wide showed
 * (`capture-pane -e`: no soft wrap, a two-column margin on the second line).
 */
const COLS = 82
const rowsOf = (lines: string[], wrapped: number[] = []) => (y: number): Row | undefined => {
  const text = lines[y - 1]
  if (text === undefined) return undefined
  const trimmed = text.trimEnd()
  return { text: trimmed, full: trimmed.length === COLS, wrapped: wrapped.includes(y) }
}

const MEASURED = [
  '',
  "  The GitHub App's permissions page is here: https://github.com/organizations/n-dr",
  '  eam-builders/settings/apps/n-dream-builders-platform/permissions  ',
  '',
]
const WHOLE = 'https://github.com/organizations/n-dream-builders/settings/apps/n-dream-builders-platform/permissions'

describe('brokenUrlsAt', () => {
  it('joins a URL Claude Code broke across lines, from either half', () => {
    const expected = { url: WHOLE, start: { x: 46, y: 2 }, end: { x: 66, y: 3 } }
    expect(brokenUrlsAt(rowsOf(MEASURED), 2, COLS)).toEqual([expected])
    expect(brokenUrlsAt(rowsOf(MEASURED), 3, COLS)).toEqual([expected])
    expect(brokenUrlsAt(rowsOf(MEASURED), 4, COLS)).toEqual([])
  })

  it('follows a URL through several full lines and stops at its full stop', () => {
    const lines = [
      `  see ${'https://example.com/a'.padEnd(COLS - 6, 'a')}`,
      `  ${'b'.repeat(COLS - 2)}`,
      '  cccc. Then carry on.',
    ]
    const [link] = brokenUrlsAt(rowsOf(lines), 2, COLS)
    expect(link?.url).toBe(`${'https://example.com/a'.padEnd(COLS - 6, 'a')}${'b'.repeat(COLS - 2)}cccc`)
    expect(link?.end).toEqual({ x: 6, y: 3 })
  })

  it('leaves a URL the terminal soft-wrapped to the web-links addon', () => {
    const lines = ['https://accounts.google.com/o/oauth2/auth?x='.padEnd(COLS, '1'), '40559.apps.googleusercontent.com']
    expect(brokenUrlsAt(rowsOf(lines, [2]), 1, COLS)).toEqual([])
  })

  it('leaves a URL that ends before the last column alone', () => {
    const lines = ['  see https://example.com/short for it', '  next line']
    expect(brokenUrlsAt(rowsOf(lines), 1, COLS)).toEqual([])
  })
})
