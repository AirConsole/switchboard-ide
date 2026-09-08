/** Domain model shared by server and web. Persisted shapes live here too. */

/** A registered git repository. One is "active" in the UI at a time. */
export interface Project {
  id: string
  name: string
  /** Absolute path to the main repository root. */
  root: string
  /** Absolute directory that new worktrees are created under. */
  worktreeRoot: string
  /**
   * Ref that new worktrees branch from unless one is given: normally
   * `origin/<default-branch>`, or `HEAD` in a repository with no remote.
   * Derived from the repository, never persisted.
   */
  defaultBase?: string
  addedAt: number
}

/** A git worktree of a project. The main worktree is included, with `isMain`. */
export interface Worktree {
  id: string
  projectId: string
  /** Display name; for the main worktree this is the project name. */
  name: string
  branch: string | null
  /** Absolute path to the worktree directory. */
  path: string
  isMain: boolean
  /** Ref the worktree was branched from, when we created it. */
  base?: string
  /** Set when the directory or its git registration has gone missing. */
  missing?: boolean
  /** Changed tracked+untracked entries, for the tab's dirty dot. */
  dirty?: number
}

export type SessionKind = 'claude' | 'shell'

/**
 * Liveness of the underlying tmux session.
 * `dead` means the tmux session is gone; we keep the record so the UI can show
 * and clear it rather than silently resurrecting something the user killed.
 */
export type SessionLiveness = 'live' | 'dead'

/**
 * What the session wants from the human. Derived server-side; see
 * `server/src/session/attention.ts`.
 */
export type AttentionState = 'working' | 'needs-you' | 'idle'

export interface Session {
  id: string
  worktreeId: string
  kind: SessionKind
  /** tmux session name on the private socket, e.g. `idn-V1StGXR8`. */
  tmuxName: string
  title: string
  cols: number
  rows: number
  liveness: SessionLiveness
  /**
   * Exit status once `liveness` is dead: 0 for a deliberate exit, non-zero for
   * a failure, null when tmux did not report one. Lets the UI tell "you typed
   * /exit" apart from "it crashed".
   */
  exitStatus?: number | null
  attention: AttentionState
  /** Epoch ms of the last byte of output. */
  lastOutputAt: number
  createdAt: number
  /** Ready-to-paste escape hatch, e.g. `tmux -L ide-n-dream attach -t idn-V1StGXR8`. */
  attachCommand: string
}

/** Everything needed to restore the UI exactly as the user left it. */
export interface UiState {
  activeProjectId: string | null
  /** Worktree order in the top bar, by id. */
  tabOrder: string[]
  /**
   * Worktrees present only in the top bar, by id: no tile in the grid. Their
   * chip still carries state, so a minimized worktree can still call for you.
   */
  minimized: string[]
  /** The worktree whose shells tile is open, if any. */
  terminalsFor: string | null
  /**
   * What was minimized before Terminals was switched on, so switching it off
   * restores the layout instead of leaving everything collapsed.
   */
  minimizedBeforeTerminals: string[] | null
  /** Selected shell per worktree, so its shells tile reopens where you left it. */
  activeShellByWorktree: Record<string, string>
}

export const defaultUiState = (): UiState => ({
  activeProjectId: null,
  tabOrder: [],
  minimized: [],
  terminalsFor: null,
  minimizedBeforeTerminals: null,
  activeShellByWorktree: {},
})

/** Full snapshot the client fetches on load and re-fetches after mutations. */
export interface AppSnapshot {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  ui: UiState
}
