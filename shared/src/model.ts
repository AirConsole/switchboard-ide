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
  attention: AttentionState
  /** Epoch ms of the last byte of output. */
  lastOutputAt: number
  createdAt: number
  /** Ready-to-paste escape hatch, e.g. `tmux -L ide-n-dream attach -t idn-V1StGXR8`. */
  attachCommand: string
}

export type ViewName = 'split' | 'detail'

/** Everything needed to restore the UI exactly as the user left it. */
export interface UiState {
  activeProjectId: string | null
  view: ViewName
  activeWorktreeId: string | null
  /** Focused session per worktree, so switching tabs returns you where you were. */
  activeSessionByWorktree: Record<string, string>
  /** Worktree tab order, by worktree id. */
  tabOrder: string[]
  /** Height of the secondary terminal strip in the detail view, in px. */
  terminalStripHeight: number
  /** Width of the (v2) side panel, in px. */
  sidePanelWidth: number
  sidePanelOpen: boolean
}

export const defaultUiState = (): UiState => ({
  activeProjectId: null,
  view: 'split',
  activeWorktreeId: null,
  activeSessionByWorktree: {},
  tabOrder: [],
  terminalStripHeight: 260,
  sidePanelWidth: 320,
  sidePanelOpen: false,
})

/** Full snapshot the client fetches on load and re-fetches after mutations. */
export interface AppSnapshot {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  ui: UiState
}
