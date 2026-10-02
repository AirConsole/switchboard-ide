import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { FileContent } from '@switchboard/shared'
import { ApiError, api } from '../src/api.js'
import { useFilesState } from '../src/views/FilesPane.js'

/**
 * Reads that answer when the test says so, which is the whole of the bug: what
 * the panel shows between clicking a file and its read landing.
 */
const pendingReads = () => {
  const waiting: { path: string; ifNotRev?: string; answer: (text: string) => void }[] = []
  vi.spyOn(api, 'trees').mockImplementation(async (_worktree, paths) => ({
    listings: paths.map((path) => ({ path, entries: [] })),
    missing: [],
  }))
  vi.spyOn(api, 'readFile').mockImplementation(
    (_worktree, path, ifNotRev) =>
      new Promise((resolve) => {
        waiting.push({
          path,
          ...(ifNotRev === undefined ? {} : { ifNotRev }),
          answer: (text) =>
            resolve({ path, rev: `rev-${path}`, mtimeMs: 0, size: text.length, text } as FileContent),
        })
      }),
  )
  /** Answer the newest read of `path`. */
  const answer = async (path: string, text: string): Promise<void> => {
    const read = [...waiting].reverse().find((r) => r.path === path)
    if (read === undefined) throw new Error(`nothing asked for ${path}`)
    await act(async () => read.answer(text))
  }
  return { waiting, answer }
}

const noop = (_: string): void => {}

/*
 * Each callback a new arrow on every render, exactly as the row passes them:
 * that is what made every render a fresh round of reads.
 */
const open = (worktreeId: string, path: string, expanded: string[] = []) =>
  renderHook(
    (props: { path: string; tick?: number }) =>
      useFilesState({
        worktreeId,
        revision: 'r',
        enabled: true,
        path: props.path,
        expanded,
        onOpen: (p) => noop(p),
        onToggleDir: (d) => noop(d),
        onExpandDir: (d) => noop(d),
      }),
    { initialProps: { path } as { path: string; tick?: number } },
  )

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('the open file', () => {
  it('is never the file before while the next one is read', async () => {
    /*
     * Switching files showed the previous file's text under the new file's name
     * for as long as the read took, because `file` was whatever the last read
     * had answered. Now nothing is shown, and the panel says it is loading.
     */
    const reads = pendingReads()
    const { result, rerender } = open('w1', 'a.txt')
    expect(result.current.fileLoading).toBe(true)
    await reads.answer('a.txt', 'A')
    expect(result.current.file?.text).toBe('A')
    expect(result.current.fileLoading).toBe(false)

    rerender({ path: 'b.txt' })
    expect(result.current.file).toBeNull()
    expect(result.current.fileLoading).toBe(true)
    // And it does not send A's rev up as though it were B's.
    expect(reads.waiting.at(-1)).toEqual(expect.objectContaining({ path: 'b.txt' }))
    expect(reads.waiting.at(-1)?.ifNotRev).toBeUndefined()
    await reads.answer('b.txt', 'B')
    expect(result.current.file).toEqual({ path: 'b.txt', text: 'B' })
  })

  it('is read when you come back to it with unsaved edits', async () => {
    /*
     * The draft check that keeps the poll from rewriting what you are typing
     * also skipped the first read: edit B, click A, click B, and B was never
     * read, so A's text stayed on screen under B's name.
     */
    const reads = pendingReads()
    const { result, rerender } = open('w2', 'b.txt')
    await reads.answer('b.txt', 'B')
    act(() => result.current.edited('B, edited'))
    expect(result.current.dirty).toBe(true)

    rerender({ path: 'a.txt' })
    await reads.answer('a.txt', 'A')
    rerender({ path: 'b.txt' })
    await reads.answer('b.txt', 'B')
    expect(result.current.file).toEqual({ path: 'b.txt', text: 'B' })
    // The edit is still the buffer: reading the disk did not throw it away.
    expect(result.current.draft()).toBe('B, edited')
    expect(result.current.dirty).toBe(true)
  })

  it('is not read again because the row re-rendered', async () => {
    /*
     * The row passes its callbacks as inline arrows, and they were effect
     * dependencies, so every render of the row -- every socket update --
     * re-read the tree's root and the open file. Reported as a flood of
     * `/tree?path=` requests.
     */
    const reads = pendingReads()
    const { rerender } = open('w3', 'a.txt')
    await reads.answer('a.txt', 'A')
    const trees = vi.mocked(api.trees).mock.calls.length
    const files = vi.mocked(api.readFile).mock.calls.length
    for (let tick = 1; tick <= 5; tick++) rerender({ path: 'a.txt', tick })
    expect(vi.mocked(api.trees).mock.calls.length).toBe(trees)
    expect(vi.mocked(api.readFile).mock.calls.length).toBe(files)
  })
})

describe('the tree', () => {
  it('reads every directory on screen in one request, and none that are folded away', async () => {
    /*
     * It was one request per directory, and `expanded` keeps a directory whose
     * parent has been folded, so those went on being polled while drawn
     * nowhere: a dozen `/tree` requests every three seconds, measured.
     */
    pendingReads()
    open('w4', '', ['src', 'src/ui', 'docs/api'])
    await act(async () => {})
    expect(vi.mocked(api.trees).mock.calls).toEqual([['w4', ['', 'src', 'src/ui']]])
  })

  it('reads nothing while the tab is in the background', async () => {
    // Timers still run in a hidden tab, only slower: every open panel went on
    // polling for a page nobody was looking at.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const reads = pendingReads()
    open('w5', 'a.txt')
    await act(async () => {})
    expect(api.trees).not.toHaveBeenCalled()
    expect(reads.waiting).toEqual([])
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    // Coming back reads at once rather than at the next tick.
    expect(api.trees).toHaveBeenCalledTimes(1)
    expect(reads.waiting.map((read) => read.path)).toEqual(['a.txt'])
  })
})

describe('api.trees', () => {
  it('falls back to a directory at a time on a machine from before it', async () => {
    /*
     * A linked machine on an older build has no `/trees` and answers the
     * router's own 404, which carries no code. Its directories are then read
     * as they always were, and a gone one is reported the new route's way.
     */
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      const answer = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url.includes('/trees?')) return answer(404, { error: 'not found' })
      const path = new URL(url, 'http://x').searchParams.get('path')
      if (path === 'gone') return answer(404, { error: 'no such file: gone', code: 'file-missing' })
      return answer(200, { path, entries: [] })
    })
    const answer = await api.trees('w6', ['', 'src', 'gone'])
    expect(answer).toEqual({
      listings: [{ path: '', entries: [] }, { path: 'src', entries: [] }],
      missing: ['gone'],
    })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('does not fall back on a refusal that says what it is', async () => {
    // Asked once: falling back would ask again per directory and hide nothing.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'outside', code: 'path-outside-worktree' }), { status: 403 }),
    )
    await expect(api.trees('w7', ['', '../..'])).rejects.toBeInstanceOf(ApiError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('the hook itself', () => {
  it('survives being turned off and on', async () => {
    /*
     * `opts.enabled && usePageVisible()` skipped the hook whenever the panel
     * was off, and React threw on the first render that changed it -- which
     * took the whole row down in a browser, found there and not here, because
     * every test above keeps the panel on.
     */
    pendingReads()
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useFilesState({
          worktreeId: 'w8',
          revision: 'r',
          enabled: props.enabled,
          path: '',
          expanded: [],
          onOpen: noop,
          onToggleDir: noop,
          onExpandDir: noop,
        }),
      { initialProps: { enabled: true } },
    )
    expect(() => rerender({ enabled: false })).not.toThrow()
    expect(() => rerender({ enabled: true })).not.toThrow()
  })
})
