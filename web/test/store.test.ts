import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, UiState } from '@switchboard/shared'
import { defaultUiState } from '@switchboard/shared'

/*
 * The store talks to the server on construction of every action, so `api` is
 * replaced wholesale. Hoisted, because `vi.mock` is lifted above the imports.
 */
const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  patchUi: vi.fn(),
}))
vi.mock('../src/api.js', () => ({ api }))

const { migrateUi, useStore } = await import('../src/store.js')

const emptySnapshot = (ui: Partial<UiState> = {}): AppSnapshot => ({
  projects: [],
  worktrees: [],
  sessions: [],
  todos: [],
  ui: { ...defaultUiState(), ...ui },
})

describe('migrateUi', () => {
  const ui = (over: Partial<UiState>): UiState => ({ ...defaultUiState(), ...over })

  /** A stored panel list, which can still name a panel this build has lost. */
  const stored = (panels: Record<string, string[]>): UiState =>
    ui({ panels: panels as unknown as UiState['panels'] })

  it('leaves state that names no lost panel exactly as it is', () => {
    const before = ui({ panels: { w1: ['files', 'terminals'] } })
    expect(migrateUi(before)).toBe(before)
  })

  it('turns the old git panel into the files panel', () => {
    /*
     * A stored list still naming `git` is dropped by the row's own filter, so a
     * worktree that had only that panel open would come back with no panel at
     * all -- the Changes panel would simply cease to exist.
     */
    expect(migrateUi(stored({ w1: ['git'] })).panels).toEqual({ w1: ['files'] })
  })

  it('puts a migrated worktree into Changes mode, which is what it was', () => {
    // The panel's own default is Files, so without this a git panel would come
    // back showing the file tree.
    expect(migrateUi(stored({ w1: ['git'] })).filesModeByWorktree).toEqual({ w1: 'changes' })
  })

  it('does not overrule a mode the worktree already had', () => {
    const before = ui({
      panels: { w1: ['git'] } as unknown as UiState['panels'],
      filesModeByWorktree: { w1: 'commits' },
    })
    expect(migrateUi(before).filesModeByWorktree).toEqual({ w1: 'commits' })
  })

  it('leaves an untouched files panel on the Files default', () => {
    /*
     * This was briefly keyed on the panel instead -- any `files` panel with no
     * stored mode -- to cover a three-quarter-hour window during development.
     * The cost was permanent: every files panel whose mode had never been
     * touched would be forced into Changes and the default could never be seen.
     */
    const before = ui({ panels: { w1: ['files'], w2: ['git'] } as unknown as UiState['panels'] })
    expect(migrateUi(before).filesModeByWorktree).toEqual({ w2: 'changes' })
  })

  it('collapses a worktree that had both, keeping the newer position', () => {
    // `panesOf` keeps the newest panels when a window is too narrow for all of
    // them, so the survivor should inherit the later place.
    expect(migrateUi(stored({ w1: ['files', 'terminals', 'git'] })).panels).toEqual({
      w1: ['terminals', 'files'],
    })
  })

  it('is idempotent, because it runs on every first load and writes nothing', () => {
    const once = migrateUi(stored({ w1: ['git', 'terminals'] }))
    expect(migrateUi(once)).toBe(once)
  })
})

describe('the store', () => {
  const initial = useStore.getState()

  beforeEach(() => {
    vi.useFakeTimers()
    api.snapshot.mockReset()
    api.patchUi.mockReset().mockResolvedValue(undefined)
    localStorage.clear()
    useStore.setState({ ...initial, ui: defaultUiState(), loaded: false, adopted: false, error: null })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('adopts the server’s UI state on the first load', async () => {
    api.snapshot.mockResolvedValue(emptySnapshot({ awake: ['wt-1'] }))
    await useStore.getState().refresh()
    expect(useStore.getState().ui.awake).toEqual(['wt-1'])
    expect(useStore.getState().adopted).toBe(true)
  })

  it('ignores the server’s copy on every refresh after that', async () => {
    /*
     * The client owns UI state. Taking it on every refresh undid changes made
     * moments earlier, because writes are debounced: removing a worktree set
     * the view to the overview and immediately refreshed, and the snapshot --
     * still carrying the old view -- put you back into a different worktree.
     */
    api.snapshot.mockResolvedValue(emptySnapshot({ awake: ['wt-1'] }))
    await useStore.getState().refresh()
    useStore.getState().setUi({ awake: ['wt-2'] })
    await useStore.getState().refresh()
    expect(useStore.getState().ui.awake).toEqual(['wt-2'])
  })

  it('adopts on the first load that actually succeeds, not the first attempt', async () => {
    /*
     * `loaded` went true in the catch, so a load during a deploy left the
     * browser's cached defaults in place -- and the next click wrote them over
     * the real layout.
     */
    api.snapshot.mockRejectedValueOnce(new Error('server is restarting'))
    await useStore.getState().refresh()
    expect(useStore.getState().loaded).toBe(true)
    expect(useStore.getState().adopted).toBe(false)

    api.snapshot.mockResolvedValue(emptySnapshot({ awake: ['wt-1'] }))
    await useStore.getState().refresh()
    expect(useStore.getState().ui.awake).toEqual(['wt-1'])
  })

  it('takes the stored state over the defaults, never instead of them', async () => {
    // A stored copy can predate a field this build reads, and a missing one
    // would arrive as undefined where the code expects a record it can index.
    api.snapshot.mockResolvedValue({
      ...emptySnapshot(),
      ui: { awake: ['wt-1'] } as unknown as UiState,
    })
    await useStore.getState().refresh()
    expect(useStore.getState().ui.openFilesByWorktree).toEqual({})
  })

  it('accumulates changes made inside the debounce window', async () => {
    /*
     * Two setUi calls inside 200ms are common -- switching Terminals on also
     * selects a terminal -- and sending only the last one silently dropped the
     * first, so the mode never reached the server and did not survive a reload.
     */
    useStore.getState().setUi({ awake: ['wt-1'] })
    useStore.getState().setUi({ activeTerminalByWorktree: { 'wt-1': 's1' } })
    await vi.advanceTimersByTimeAsync(250)
    expect(api.patchUi).toHaveBeenCalledOnce()
    expect(api.patchUi).toHaveBeenCalledWith({
      awake: ['wt-1'],
      activeTerminalByWorktree: { 'wt-1': 's1' },
    })
  })

  it('does not keep sending a patch it has already sent', async () => {
    useStore.getState().setUi({ awake: ['wt-1'] })
    await vi.advanceTimersByTimeAsync(250)
    useStore.getState().setUi({ awake: ['wt-2'] })
    await vi.advanceTimersByTimeAsync(250)
    expect(api.patchUi).toHaveBeenLastCalledWith({ awake: ['wt-2'] })
  })

  it('caches the layout locally so a reload paints it without waiting', () => {
    useStore.getState().setUi({ awake: ['wt-1'] })
    expect(JSON.parse(localStorage.getItem('swb.ui') ?? '{}').awake).toEqual(['wt-1'])
  })

  it('reports a failed load rather than leaving the page blank', async () => {
    api.snapshot.mockRejectedValue(new Error('connection refused'))
    await useStore.getState().refresh()
    expect(useStore.getState().error).toBe('connection refused')
    expect(useStore.getState().loaded).toBe(true)
  })

  it('applies a pushed session state without touching the others', () => {
    useStore.setState({
      sessions: [
        { id: 's1', attention: 'idle', command: 'bash' },
        { id: 's2', attention: 'idle' },
      ] as never,
    })
    useStore.getState().applySessionState('s1', {
      liveness: 'live',
      exitStatus: null,
      attention: 'working',
      lastOutputAt: 42,
    })
    const [first, second] = useStore.getState().sessions
    expect(first?.attention).toBe('working')
    // Omitted rather than sent as undefined, so a message without a command
    // does not wipe the label the session already had.
    expect(first?.command).toBe('bash')
    expect(second?.attention).toBe('idle')
  })
})
