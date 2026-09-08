import { create } from 'zustand'
import type {
  AppSnapshot,
  AttentionState,
  Session,
  SessionLiveness,
  UiState,
  Worktree,
} from '@ide-n-dream/shared'
import { defaultUiState } from '@ide-n-dream/shared'
import { api } from './api.js'
import { terminalSocket } from './socket.js'

const UI_CACHE_KEY = 'idn.ui'

/**
 * UI state is owned by the server so the view is restored on any device, but a
 * copy is cached locally so a reload paints the right layout immediately
 * instead of flashing the default one while the snapshot is in flight.
 */
const cachedUi = (): UiState => {
  try {
    const raw = localStorage.getItem(UI_CACHE_KEY)
    if (!raw) return defaultUiState()
    return { ...defaultUiState(), ...(JSON.parse(raw) as Partial<UiState>) }
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
    next: { liveness: SessionLiveness; attention: AttentionState; lastOutputAt: number },
  ) => void
  setError: (message: string | null) => void
  worktreesForActiveProject: () => Worktree[]
  sessionsForWorktree: (worktreeId: string) => Session[]
}

let uiSaveTimer: number | null = null
/**
 * Changes waiting to be written. They accumulate rather than replace: two
 * setUi calls inside the debounce window are common (switching Terminals on
 * also selects a shell), and sending only the last one silently dropped the
 * first -- the focus mode never reached the server and did not survive a
 * reload.
 */
let pendingUiPatch: Partial<UiState> = {}

export const useStore = create<AppState>((set, get) => ({
  projects: [],
  worktrees: [],
  sessions: [],
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
      set({
        ...rest,
        ui: firstLoad ? storedUi : get().ui,
        loaded: true,
        error: null,
      })
      if (firstLoad) localStorage.setItem(UI_CACHE_KEY, JSON.stringify(storedUi))
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

  worktreesForActiveProject: () => {
    const { worktrees, ui } = get()
    if (!ui.activeProjectId) return []
    return worktrees.filter((w) => w.projectId === ui.activeProjectId)
  },

  sessionsForWorktree: (worktreeId) => get().sessions.filter((s) => s.worktreeId === worktreeId),
}))

/** Wire push updates from the server into the store. Called once at startup. */
export const bindSocketToStore = (): void => {
  terminalSocket.onSessionState((msg) => {
    useStore.getState().applySessionState(msg.sessionId, {
      liveness: msg.liveness,
      attention: msg.attention,
      lastOutputAt: msg.lastOutputAt,
    })
  })
  terminalSocket.onInvalidate(() => void useStore.getState().refresh())
  terminalSocket.connect()
}
