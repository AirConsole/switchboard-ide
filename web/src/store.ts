import { create } from 'zustand'
import type {
  AppSnapshot,
  AttentionState,
  Session,
  SessionLiveness,
  UiState,
  Worktree,
  PanelName,
} from '@ide-n-dream/shared'
import { defaultUiState } from '@ide-n-dream/shared'
import { api } from './api.js'
import { terminalSocket } from './socket.js'

const UI_CACHE_KEY = 'idn.ui'

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
 */
const migrateUi = (ui: UiState): UiState => {
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
  error: string | null
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
  error: null,

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
      const firstLoad = !get().loaded
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
        error: null,
      })
      if (firstLoad) localStorage.setItem(UI_CACHE_KEY, JSON.stringify(adopted))
    } catch (err) {
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
}))

/** Wire push updates from the server into the store. Called once at startup. */
export const bindSocketToStore = (): void => {
  terminalSocket.onSessionState((msg) => {
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
  terminalSocket.onInvalidate(() => void useStore.getState().refresh())
  terminalSocket.connect()
}
