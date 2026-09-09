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
 * one column wide, or two, or -- with all three open -- four. Panels are
 * per-worktree and persistent: minimizing a worktree to the top bar and bringing
 * it back restores the width it had.
 */
export type PanelName = 'files' | 'terminals' | 'git'

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
  /**
   * Where each worktree's files panel is standing, relative to the worktree.
   *
   * One string carries the whole panel. A trailing slash means a directory
   * opened with nothing chosen inside it, anything else names a file, and `''`
   * is the worktree root -- so the browser's columns are the path's own
   * segments, and restoring the string restores the strip and the open file
   * together. Storing the columns as well would be a second copy of one fact,
   * free to disagree with it.
   *
   * Unlike the git panel's selection, which is deliberately *not* persisted
   * because a file may have stopped differing by the time you come back, a path
   * is stable: a file you were reading is still a file.
   */
  openPathByWorktree: Record<string, string>
}

export const defaultUiState = (): UiState => ({
  awake: null,
  panels: {},
  activeTerminalByWorktree: {},
  openPathByWorktree: {},
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

/**
 * One entry in a directory of a worktree.
 *
 * A symlink is reported as whatever it points at, and is dropped entirely when
 * that is outside the worktree or missing: `dirent.isDirectory()` is false for a
 * link to a directory, so reporting the link's own kind would show a directory
 * as a file and make clicking it an error every time.
 */
export interface FileEntry {
  name: string
  kind: 'dir' | 'file'
  /**
   * The worktree has changed this, or -- for a directory -- something under it.
   *
   * Absent rather than false, because in a clean repository that would be every
   * entry, and this listing is sent on every click.
   */
  changed?: boolean
}

/**
 * One directory of a worktree: exactly one level, for one column of the browser.
 *
 * One level rather than a whole tree because the browser only ever shows the
 * path you are standing on and its siblings, and a recursive listing of a real
 * repository is tens of thousands of entries to fill a column of eight rows.
 */
export interface FileListing {
  /**
   * Echoed back, so a client that has already clicked elsewhere can drop a late
   * response instead of painting it into the wrong column. `''` is the worktree
   * root.
   */
  path: string
  entries: FileEntry[]
  /**
   * Set when the directory held more entries than the server will send.
   *
   * Rare once the ignore rules have run -- they are what remove `node_modules`
   * -- but a directory of 100k files would lock the tab up, so it is capped
   * rather than trusted.
   */
  truncated?: boolean
}

/**
 * A file's identity, for the stale-write guard. Opaque to the client.
 *
 * Deliberately not the mtime alone. `mtimeMs` is a double that rounds away
 * sub-millisecond precision, and two writes inside one millisecond are exactly
 * the case a stale-write guard exists for; the inode is in it too, because a
 * write done as write-a-temp-then-rename produces a fresh file that can
 * plausibly land on the same timestamp. Opaque so it can be strengthened later
 * without the client having to know.
 */
export type FileRev = string

/** A file's contents, or the reason there are none to show. */
export interface FileContent {
  path: string
  rev: FileRev
  /** For display only. `rev` is the identity. */
  mtimeMs: number
  size: number
  /** Absent when `binary` or `tooLarge`: there is nothing safe to edit. */
  text?: string
  /**
   * A NUL byte in the first 8000 bytes -- git's own heuristic, so this panel
   * and the git panel beside it agree about the same file -- or bytes that are
   * not valid UTF-8.
   *
   * The second half matters as much as the first: a latin-1 file contains no
   * NUL, decodes without complaint into U+FFFD, and saving it back would
   * rewrite every non-ASCII byte in it. Refusing to open it is the only safe
   * answer.
   */
  binary?: boolean
  /**
   * Over `IDN_MAX_FILE_BYTES`.
   *
   * Nothing is ever truncated: a partial buffer that reached the editor would be
   * one Cmd+S away from destroying the rest of the file.
   */
  tooLarge?: boolean
}

/**
 * The answer to the follow-poll when nothing moved: one stat, no read.
 *
 * The poll and the first read are deliberately the same request. It is not only
 * the round trip saved -- the file vanishing, growing past the cap, or ceasing
 * to be text all have to be answered somewhere, and a stat-only endpoint would
 * need its own vocabulary for every one of them.
 */
export interface FileUnchanged {
  unchanged: true
  rev: FileRev
}

/**
 * The result of a save.
 *
 * The new `rev` is not a nicety: without it the follow-poll two seconds later
 * sees the client's own write as a foreign change and announces that the file
 * moved underneath you.
 */
export interface FileSaved {
  path: string
  rev: FileRev
  mtimeMs: number
  size: number
}
