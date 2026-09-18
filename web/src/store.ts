import { create } from 'zustand'
import type {
  AppSnapshot,
  AttentionState,
  Session,
  SessionLiveness,
  UiState,
  Worktree,
  PanelName,
} from '@switchboard/shared'
import { defaultUiState } from '@switchboard/shared'
import { ApiError, api } from './api.js'
import { terminalSocket } from './socket.js'

const UI_CACHE_KEY = 'swb.ui'

/**
 * Bring a stored UiState up to the shape this build reads.
 *
 * The git panel became the files panel's Changes mode. A stored `panels` list
 * still naming `git` is dropped by the row's own PANELS filter, so a worktree
 * that had only that panel open would come back with no panel at all -- the
 * Changes panel would simply cease to exist. It becomes the `files` panel, and
 * that worktree is put into Changes mode explicitly: the panel's own default is
 * Files, so without this a git panel would come back showing the file tree,
 * which is not what it was.
 *
 * The dedupe keeps the *last* occurrence, because `panesOf` keeps the newest
 * panels when a window is too narrow for all of them: a worktree that had both
 * open should keep the position of whichever was opened later.
 *
 * Reads an untrusted shape on purpose. Once `PanelName` lost `'git'`, comparing
 * against it is a type error, and this is exactly the boundary where a value
 * from disk has not been checked yet.
 *
 * Idempotent, and writes nothing: it runs again on every first load until the
 * user next changes that worktree's panels. Delete it once no stored state
 * names `git`.
 *
 * Exported only so it can be tested: it reads a shape the type system cannot
 * describe -- `'git'` is not a `PanelName` any more -- so a test is the only
 * thing that can say it still does what it says.
 */
export const migrateUi = (ui: UiState): UiState => {
  const panels = ui.panels as unknown as Record<string, string[]>
  const migrated: Record<string, PanelName[]> = {}
  const modes = { ...ui.filesModeByWorktree }
  let moved = false
  for (const [worktreeId, list] of Object.entries(panels)) {
    const renamed = list.map((panel) => (panel === 'git' ? 'files' : panel))
    if (renamed.some((panel, index) => panel !== list[index])) moved = true
    /*
     * Only what the rename actually touched keeps Changes.
     *
     * This was briefly keyed on the panel instead -- any `files` panel with no
     * stored mode -- to cover worktrees toggled in the window between the
     * git -> files rename and the default flipping to Files. That window was
     * three quarters of an hour of development, and the cost of covering it is
     * permanent: this runs on every first load and writes nothing, so keying it
     * on the panel forces *every* files panel that has never had its mode
     * touched into Changes, and the Files default can never be seen. A panel
     * stored as `files` from before the two panels merged showed a tree and an
     * editor, which is what Files mode is, so it is also the honest answer for
     * that set.
     */
    if (renamed.some((panel, index) => panel !== list[index]) && modes[worktreeId] === undefined) {
      modes[worktreeId] = 'changes'
    }
    // Last occurrence wins, so the survivor inherits the newer position.
    const seen = renamed.filter((panel, index) => renamed.lastIndexOf(panel) === index)
    migrated[worktreeId] = seen as PanelName[]
  }
  return moved ? { ...ui, panels: migrated, filesModeByWorktree: modes } : ui
}

/**
 * UI state is owned by the server so the view is restored on any device, but a
 * copy is cached locally so a reload paints the right layout immediately
 * instead of flashing the default one while the snapshot is in flight.
 */
const cachedUi = (): UiState => {
  try {
    const raw = localStorage.getItem(UI_CACHE_KEY)
    if (!raw) return defaultUiState()
    return migrateUi({ ...defaultUiState(), ...(JSON.parse(raw) as Partial<UiState>) })
  } catch {
    return defaultUiState()
  }
}

interface AppState extends AppSnapshot {
  loaded: boolean
  /**
   * Whether this browser holds a session. `null` until the first answer.
   *
   * Separate from `error` because it is a different screen rather than a
   * failure, and separate from `loaded` because `loaded` goes true in the catch
   * too -- keying the login on `loaded` alone would fall straight through to
   * the main view with an empty row.
   */
  authed: boolean | null
  signedIn: () => void
  signOut: () => Promise<void>
  /** Whether the server's stored UI state has been taken; see refresh(). */
  adopted: boolean
  error: string | null
  /**
   * An action of yours that failed, and the window it was about.
   *
   * Kept apart from `error` because the two have opposite lives. `error` is the
   * snapshot read failing -- it says the page is out of touch, and a read that
   * works again is the whole of the answer, so it clears itself. This is a
   * thing you *did*: a terminal that would not start, a machine that answered
   * with a protocol this one does not speak. It has to survive a refresh, and
   * refreshes are constant -- every attention change on any agent brings one --
   * which is why such a message used to vanish before it could be read.
   *
   * `where` is the row key of the window it belongs to, so it can be said
   * inside that window rather than across the whole app. Null for what belongs
   * to no window.
   */
  failure: Failure | null
  refresh: () => Promise<void>
  setUi: (patch: Partial<UiState>) => void
  applySessionState: (
    sessionId: string,
    next: {
      liveness: SessionLiveness
      exitStatus: number | null
      attention: AttentionState
      lastOutputAt: number
      command?: string
    },
  ) => void
  setError: (message: string | null) => void
  setFailure: (failure: Failure | null) => void
}

/**
 * An action of yours that failed, and which window it was about.
 *
 * `update` is set when the failure is a version skew between this machine and
 * a linked one: which of the two is behind, as the key `/api/servers/:key/update`
 * takes, or null for this machine. The window saying so then offers to do it.
 */
export interface Failure {
  message: string
  where: string | null
  update?: { host: string | null }
}

let uiSaveTimer: number | null = null
/**
 * Changes waiting to be written. They accumulate rather than replace: two
 * setUi calls inside the debounce window are common (switching Terminals on
 * also selects a terminal), and sending only the last one silently dropped the
 * first -- the focus mode never reached the server and did not survive a
 * reload.
 */
let pendingUiPatch: Partial<UiState> = {}

export const useStore = create<AppState>((set, get) => ({
  projects: [],
  worktrees: [],
  sessions: [],
  todos: [],
  ui: cachedUi(),
  loaded: false,
  adopted: false,
  authed: null,
  signedIn: () => {
    set({ authed: true, error: null })
    void get().refresh()
    /*
     * Reconnected here, not left to the terminals. A mounting terminal
     * reconnects the socket as a side effect, which is why this looked fine --
     * but with every worktree asleep there is no terminal, the socket never
     * came back after signing in, and the attention broadcasts that turn a
     * window amber or green travel over it.
     */
    terminalSocket.connect()
  },
  signOut: async () => {
    try {
      await api.logout()
    } finally {
      terminalSocket.disconnect()
      set({ authed: false })
    }
  },
  error: null,
  failure: null,

  refresh: async () => {
    try {
      const { ui: storedUi, ...rest } = await api.snapshot()
      /*
       * The client owns UI state; the server stores it only so a reload can
       * restore it. So the server's copy is adopted on the first load and
       * ignored afterwards.
       *
       * Taking it on every refresh undid changes made moments earlier, because
       * writes are debounced: removing a worktree set the view to the overview
       * and then immediately refreshed, and the snapshot -- still carrying the
       * old view -- put you back in the detail view of a different worktree.
       */
      // Whether the server's UI state has ever been taken, which is not the
      // same as whether a snapshot has ever been *attempted*. Loading during a
      // deploy failed, `loaded` went true in the catch, and the reconnect that
      // followed then kept the browser's cached defaults -- and overwrote the
      // real layout with them on the first click.
      // Reaching here at all means the session was accepted.
      if (get().authed !== true) set({ authed: true })
      const firstLoad = !get().adopted
      /*
       * Over the defaults, not instead of them: the stored copy can predate a
       * field this build reads (an older server, or a hand-edited state file),
       * and a missing one would arrive as undefined where the code expects a
       * record it can index.
       */
      const adopted = migrateUi({ ...defaultUiState(), ...storedUi })
      set({
        ...rest,
        ui: firstLoad ? adopted : get().ui,
        loaded: true,
        adopted: true,
        error: null,
      })
      if (firstLoad) localStorage.setItem(UI_CACHE_KEY, JSON.stringify(adopted))
    } catch (err) {
      /*
       * A 401 is not an error, it is a different screen. Setting `error` here
       * would put "not allowed" in the top banner behind an empty row, which
       * says nothing about what to do; `authed: false` shows the login instead.
       */
      if (err instanceof ApiError && err.status === 401) {
        set({ authed: false, loaded: true })
        return
      }
      set({ error: err instanceof Error ? err.message : String(err), loaded: true })
    }
  },

  setUi: (patch) => {
    const ui = { ...get().ui, ...patch }
    set({ ui })
    localStorage.setItem(UI_CACHE_KEY, JSON.stringify(ui))
    // Debounced: rapid toggles would otherwise write on every click.
    pendingUiPatch = { ...pendingUiPatch, ...patch }
    if (uiSaveTimer !== null) window.clearTimeout(uiSaveTimer)
    uiSaveTimer = window.setTimeout(() => {
      uiSaveTimer = null
      const body = pendingUiPatch
      pendingUiPatch = {}
      void api.patchUi(body).catch(() => {})
    }, 200)
  },

  applySessionState: (sessionId, next) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...next } : s)),
    })),

  setError: (message) => set({ error: message }),
  setFailure: (failure) => set({ failure }),
}))

/** Wire push updates from the server into the store. Called once at startup. */
/**
 * Wire the socket to the store, and hand back the way to unwire it.
 *
 * The unsubscribers used to be discarded on the word that this runs once --
 * but it is called from an effect, and under StrictMode React runs those twice
 * in development, which is the mode this IDE is developed in. Every invalidate
 * then fetched the snapshot twice for the life of the page.
 */
export const bindSocketToStore = (): (() => void) => {
  // A socket that closed 4401 means the session is gone. Without this the tab
  // retried forever behind a row that never painted, with nothing said.
  terminalSocket.onUnauthorized(() => useStore.setState({ authed: false, loaded: true }))
  const offState = terminalSocket.onSessionState((msg) => {
    useStore.getState().applySessionState(msg.sessionId, {
      liveness: msg.liveness,
      exitStatus: msg.exitStatus ?? null,
      attention: msg.attention,
      lastOutputAt: msg.lastOutputAt,
      // Omitted rather than sent as undefined, so a message without it does not
      // wipe the label the session already had.
      ...(msg.command === undefined ? {} : { command: msg.command }),
    })
  })
  const offInvalidate = terminalSocket.onInvalidate(() => void useStore.getState().refresh())
  terminalSocket.connect()
  return () => {
    offState()
    offInvalidate()
  }
}
