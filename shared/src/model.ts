/** Domain model shared by server and web. Persisted shapes live here too. */

/**
 * Where a project's files and processes live.
 *
 * Only `local` is implemented. It is named now because it decides how ids are
 * derived, and worktree ids are recorded inside tmux -- so adding the remote
 * case later must not change the local derivation or every running session is
 * orphaned. See `idFor` in server/src/git/worktree.ts.
 */
export type ProjectHost = { kind: 'local' } | { kind: 'remote'; baseUrl: string; token?: string }

/** A registered git repository. Every registered project is open. */
export interface Project {
  id: string
  name: string
  host: ProjectHost
  /** Absolute path to the main repository root, on its host. */
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
  /**
   * The last thing the user asked Claude here, whitespace collapsed.
   *
   * What a worktree is *about*, which is the question a row of identical-looking
   * windows cannot otherwise answer. Read from Claude's own transcript on disk,
   * so it survives sleeping and costs nothing to produce; absent where Claude
   * has never run.
   */
  prompt?: string
}

/**
 * A piece of work parked against a worktree, and optionally queued to be typed
 * into that worktree's Claude.
 *
 * Persisted by the server rather than kept in `UiState`, because the server
 * mutates them: dispatching one deletes it, and that has to happen with no
 * browser connected. `UiState` is the client's own blob and is merged key by
 * key without validation, so a server-owned collection there would race the
 * client's next write.
 */
export interface WorktreeTodo {
  id: string
  worktreeId: string
  /** Optional label. The prompt is what actually gets sent. */
  title?: string
  /** Free text, possibly several lines. Typed into Claude verbatim. */
  prompt: string
  createdAt: number
  /**
   * When RUN NEXT was pressed; absent when it is not queued.
   *
   * This *is* the queue: a worktree's queued todos in ascending `queuedAt`
   * order, so the first one pressed is (1). A separate list of ids was the
   * obvious alternative and was rejected -- it can disagree with the todos it
   * points at, and a delete then has to touch two structures.
   */
  queuedAt?: number
  /**
   * Set and written to disk immediately *before* the first byte is typed.
   *
   * A todo found with this on startup was in flight when the process died. It
   * is never sent again: typing the same prompt twice is far worse than not
   * typing it, so the only safe reading of "we may have sent it" is "we did".
   */
  dispatchingAt?: number
  /** Why the last attempt did not finish. Shown to the human, never retried. */
  lastError?: string
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
export type PanelName = 'todo' | 'terminals' | 'git'

/** Everything needed to restore the UI exactly as the user left it. */
export interface UiState {
  /**
   * The worktrees that are awake, by id. Everything else is asleep.
   *
   * A set, not an order: a tile's place in the row comes from its project and
   * its name, so it is always where you last saw it. Nothing is hidden to make
   * room -- the row overflows and scrolls -- so this says only what is running,
   * never what happened to fit.
   *
   * Null until seeded, which is not the same as empty. Empty means every
   * worktree was put to sleep; null means this is a first run, and a worktree
   * is taken to be awake if it already has live sessions. That way the IDE can
   * be dropped on a repository with twenty worktrees and start with all twenty
   * asleep and nothing running.
   */
  awake: string[] | null
  /** Panels open per worktree, in the order they sit beside Claude. */
  panels: Record<string, PanelName[]>
  /** Selected terminal per worktree, so its panel reopens where you left it. */
  activeTerminalByWorktree: Record<string, string>
}

export const defaultUiState = (): UiState => ({
  awake: null,
  panels: {},
  activeTerminalByWorktree: {},
})

/** Full snapshot the client fetches on load and re-fetches after mutations. */
export interface AppSnapshot {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  todos: WorktreeTodo[]
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
