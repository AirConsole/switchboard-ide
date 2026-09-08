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
  /**
   * The commit checked out here.
   *
   * Carried so that "something changed in this worktree" can be detected when
   * the working tree was clean before and after -- an agent committing its work
   * moves HEAD and leaves `dirty` at zero, and without this that looks like
   * nothing happened.
   */
  head?: string
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
  /**
   * The command the pane is currently running (`bash`, `vim`, `npm`, ...), as
   * tmux reports it. Refreshed by the poller, and used to label a terminal with
   * what it is doing rather than an arbitrary number.
   */
  command?: string
  /** Ready-to-paste escape hatch, e.g. `tmux -L ide-n-dream attach -t idn-V1StGXR8`. */
  attachCommand: string
}

/**
 * A panel a worktree can open beside its Claude session.
 *
 * Each open panel takes another column of the worktree's tile, so a worktree is
 * one column wide, or two, or -- once files joins this union -- four. Panels are
 * per-worktree and persistent: minimizing a worktree to the top bar and bringing
 * it back restores the width it had.
 */
export type PanelName = 'terminals' | 'git'

/** Everything needed to restore the UI exactly as the user left it. */
export interface UiState {
  activeProjectId: string | null
  /** Worktree order in the top bar, by id. */
  tabOrder: string[]
  /**
   * The worktrees that have a tile, leftmost first.
   *
   * An order, not a set, because it is what the grid renders: a worktree you
   * ask for enters at the left and pushes the rest right, and whatever no
   * longer fits falls off the right and is dropped from here. Being dropped is
   * a real change of state rather than a trick of the width, so widening the
   * window does not bring it back -- you ask for it again from the top bar,
   * and it enters at the left like anything else.
   *
   * Null when nothing has been decided yet, which is not the same as empty:
   * empty means every worktree was put away, null means this is a first run and
   * the natural order should be seeded in.
   */
  shown: string[] | null
  /** Panels open per worktree, in the order they sit beside Claude. */
  panels: Record<string, PanelName[]>
  /**
   * The pane that most recently appeared because the user asked for it, keyed
   * `<worktreeId>:claude` or `<worktreeId>:<panel>`.
   *
   * There are no rows, so a narrow window pushes panes out from the right --
   * and this one, plus the rest of its worktree, is exempt. Without it, opening
   * a panel on a phone would push out the very pane you just opened.
   */
  newestPane: string | null
  /** Selected terminal per worktree, so its panel reopens where you left it. */
  activeTerminalByWorktree: Record<string, string>
}

export const defaultUiState = (): UiState => ({
  activeProjectId: null,
  tabOrder: [],
  shown: null,
  panels: {},
  newestPane: null,
  activeTerminalByWorktree: {},
})

/** Full snapshot the client fetches on load and re-fetches after mutations. */
export interface AppSnapshot {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  ui: UiState
}

/**
 * One changed file in a worktree.
 *
 * `status` is git's own two-letter code (index then worktree, `??` untracked),
 * kept verbatim rather than flattened to an enum: the pair says things a single
 * label cannot, like "staged as added, then modified again".
 */
export interface FileChange {
  path: string
  status: string
  /** Renames carry where the file came from. */
  from?: string
}

/** One commit this worktree's branch has that its base does not. */
export interface Commit {
  hash: string
  /** Abbreviated hash, as git chose to abbreviate it. */
  short: string
  subject: string
  author: string
  /** Epoch ms of the author date. */
  at: number
}

/**
 * What a worktree has done, committed and not.
 *
 * Both halves are needed to answer "what did the agent change here": Claude
 * normally commits its work, so uncommitted changes alone would be empty
 * exactly when it finished cleanly.
 */
export interface WorktreeChanges {
  worktreeId: string
  branch: string | null
  /**
   * The ref the commits are measured against, and null when there is nothing
   * sensible to compare with -- the main worktree, or a repo whose default
   * branch is the one checked out here.
   */
  base: string | null
  uncommitted: FileChange[]
  commits: Commit[]
  /**
   * What `commits` is a list of.
   *
   * `ahead` means commits this branch has that its base does not, which is the
   * question worth asking of a worktree an agent has been working in. `recent`
   * is the fallback when that list is empty -- on the base branch itself, or a
   * worktree that has not committed yet -- because a panel that answers "what
   * happened here" with nothing at all is no use. The two are labelled
   * differently, since one is this worktree's work and the other is just
   * history.
   */
  commitScope: 'ahead' | 'recent'
  /** Commits the base has that this branch does not. Context, not a warning. */
  behind: number
}
