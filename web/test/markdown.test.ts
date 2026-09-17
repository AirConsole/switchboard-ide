import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Markdown } from '../src/views/Markdown.js'
import { isMarkdown } from '../src/views/FilesPane.js'

afterEach(cleanup)

/** The rendered file, plus whoever it would tell about a link. */
const draw = (
  text: string,
  path = 'a.md',
): { root: HTMLElement; onOpen: ReturnType<typeof vi.fn> } => {
  const onOpen = vi.fn()
  const { container } = render(
    createElement(Markdown, { text, path, worktreeId: 'wt-1', onOpen }),
  )
  return { root: container.firstElementChild as HTMLElement, onOpen }
}

describe('isMarkdown', () => {
  it('is the extension and nothing else', () => {
    expect(isMarkdown('CLAUDE.md')).toBe(true)
    expect(isMarkdown('web/notes.markdown')).toBe(true)
    // Case is the filesystem's business, not a different kind of file.
    expect(isMarkdown('README.MD')).toBe(true)
    expect(isMarkdown('server/src/files.ts')).toBe(false)
    expect(isMarkdown('component.mdx')).toBe(false)
    // A file whose *directory* is called `md` is not Markdown.
    expect(isMarkdown('md/notes.txt')).toBe(false)
  })
})

describe('Markdown', () => {
  it('draws the words, which are the gaps between the nodes', () => {
    /*
     * The trap this renderer is built around. `@lezer/markdown` marks up the
     * delimiters -- `**`, `` ` `` -- and leaves the words themselves as
     * unmarked space between children, so a renderer that only visited nodes
     * draws a page of correctly nested empty tags.
     */
    const { root } = draw('The **bold** and the `code` of it.\n')
    expect(root.textContent).toBe('The bold and the code of it.')
    expect(root.querySelector('strong')?.textContent).toBe('bold')
    expect(root.querySelector('code')?.textContent).toBe('code')
  })

  it('reads a heading at the level its hashes say', () => {
    const { root } = draw('### Third\n')
    expect(root.querySelector('h3')?.textContent).toBe('Third')
  })

  it("keeps a quote's own text and drops the marks it was written with", () => {
    const { root } = draw('> one\n> two\n')
    // Every `>` after the first is a QuoteMark *inside* the paragraph, so the
    // paragraph's text is the quote's words with the marks cut out of it.
    expect(root.querySelector('blockquote')?.textContent?.replace(/\s+/g, ' ')).toBe('one two')
  })

  it('keeps a column when a table cell is empty', () => {
    /*
     * Measured: `| 1 |  | 3 |` parses as cell, delimiter, delimiter, cell --
     * an empty cell produces no `TableCell` node at all. Collecting the cells
     * would put 3 in the second column and leave the table a column short.
     */
    const { root } = draw('| a | b | c |\n| - | - | - |\n| 1 |  | 3 |\n')
    const cells = [...root.querySelectorAll('tbody td')].map((cell) => cell.textContent)
    expect(cells).toEqual(['1', '', '3'])
  })

  it('reads the alignment row', () => {
    const { root } = draw('| a | b |\n| :- | --: |\n| 1 | 2 |\n')
    const cells = [...root.querySelectorAll('tbody td')] as HTMLElement[]
    expect(cells.map((cell) => cell.style.textAlign)).toEqual(['left', 'right'])
  })

  it("never hands the file's HTML to the parser", () => {
    /*
     * This origin is the one that can type into every running agent, so an
     * `onerror=` in a file an agent just wrote may not become an element. The
     * renderer builds React nodes, so there is no path by which it could --
     * this is the test that says so out loud.
     */
    const { root } = draw('<img src=x onerror="alert(1)">\n\ntext <b>bold</b>\n')
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('b')).toBeNull()
    expect(root.textContent).toContain('onerror')
    expect(root.textContent).toContain('<b>')
  })

  it('opens a link into the repository in this panel, resolved against the file', () => {
    const { root, onOpen } = draw('see [the notes](../server/CLAUDE.md)\n', 'web/notes.md')
    const link = root.querySelector('button')
    expect(link?.textContent).toBe('the notes')
    fireEvent.click(link as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('server/CLAUDE.md')
  })

  it('takes a link out to the web as a link out, in a new tab', () => {
    const { root } = draw('[home](https://example.com/x)\n')
    const link = root.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/x')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noreferrer noopener')
  })

  it('draws a link in any other scheme as its own words', () => {
    // `javascript:` is the one that matters; `data:` and `vscode:` are the same
    // decision. Nothing clickable, so there is nothing for a click to do.
    const { root } = draw('[click](javascript:alert(1))\n')
    expect(root.querySelector('a')).toBeNull()
    expect(root.querySelector('button')).toBeNull()
    expect(root.textContent).toBe('click')
  })

  it('resolves a reference link written above its definition', () => {
    const { root, onOpen } = draw('see [the notes][1]\n\n[1]: docs/x.md\n')
    fireEvent.click(root.querySelector('button') as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('docs/x.md')
  })

  it('draws an image in the worktree through /raw, and never fetches a remote one', () => {
    /*
     * A remote image is an outbound request the file chose and the reader did
     * not: opening a document would tell whoever wrote it that you opened it,
     * with room in the URL for whatever else it wanted to say.
     */
    const { root } = draw('![shot](img/shot.png)\n\n![badge](https://img.example/b.svg)\n', 'docs/a.md')
    const images = [...root.querySelectorAll('img')]
    expect(images).toHaveLength(1)
    expect(images[0]?.getAttribute('src')).toBe(
      '/api/worktrees/wt-1/raw?path=docs%2Fimg%2Fshot.png',
    )
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://img.example/b.svg')
  })

  it('ticks a task list from its marker, not from its text', () => {
    const { root } = draw('- [ ] todo\n- [x] done\n')
    const boxes = [...root.querySelectorAll('.md__check')]
    expect(boxes.map((box) => box.className.includes('md__check--on'))).toEqual([false, true])
    // The marker is punctuation: the box is what it says now.
    expect(root.textContent).not.toContain('[x]')
  })

  it('keeps a fenced block as written, and says nothing about its language', () => {
    const { root } = draw('```sh\n  two  spaces\n```\n')
    expect(root.querySelector('pre')?.textContent).toBe('  two  spaces')
    expect(root.textContent).not.toContain('sh')
  })

  it('drops a definition, which is how the link above it was written', () => {
    const { root } = draw('[a][1]\n\n[1]: https://example.com\n')
    expect(root.textContent).toBe('a')
  })
})
