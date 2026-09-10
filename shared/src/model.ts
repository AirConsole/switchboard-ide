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

/**
 * A project that was open and is not any more.
 *
 * Closing a project is not destructive -- nothing on disk changes, and opening
 * it again picks its worktrees and their sleeping agents back up -- so the only
 * cost of closing one is having to find the path again. This is that path,
 * remembered so the picker can offer it back.
 *
 * Only local projects have one: it is keyed by root path, which is what
 * `openProject` takes. A remote project will arrive by base URL instead.
 */
export interface RecentProject {
  /** Absolute path to the repository root, as it was registered. */
  root: string
  name: string
  /** Epoch ms it was last closed; the list is newest first. */
  closedAt: number
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
   * Commits here that the default branch does not have yet.
   *
   * The other half of "is there work in this worktree": `dirty` is work not
   * committed, this is work committed and not merged. A worktree with neither
   * has nothing of its own left in it, which is the state in which it is safe
   * to forget about.
   */
  unmerged?: number
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
 * one column wide, or two, or -- with all three open -- four. Panels are
 * per-worktree and persistent: minimizing a worktree to the top bar and bringing
 * it back restores the width it had.
 */
export type PanelName = 'todo' | 'files' | 'terminals'

/**
 * Which face of the files panel a worktree is showing.
 *
 * The panel used to be two: files, and a `git` panel beside it. They asked
 * questions about the same objects and kept two selections that drifted apart,
 * and together they cost a fifth column of the tile -- a window of 3362px to
 * see one worktree whole. One panel with three faces answers the same questions
 * from one selection, in four columns.
 */
export type FilesMode = 'changes' | 'commits' | 'files'

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
   * The file each worktree has open in its files panel, `''` for none.
   *
   * One path serves all three modes: pick a changed file and its diff opens,
   * switch to Files and the editor opens that same file. That shared selection
   * is most of the reason the two panels became one.
   *
   * Unlike the commit selection, which is deliberately *not* persisted because
   * a rebase or an amend makes a stored hash name nothing, a path is stable: a
   * file you were reading is still a file.
   */
  openPathByWorktree: Record<string, string>
  /**
   * Directories expanded in each worktree's file tree.
   *
   * Persisted because the shape you left the tree in is most of what makes it
   * usable -- a tree that collapses itself on every reload is a tree you have to
   * walk down again every time. Opening a file expands its ancestors, so a
   * restored file is always visible without this having to be derived.
   */
  expandedByWorktree: Record<string, string[]>
  /**
   * Which face of the files panel each worktree is showing.
   *
   * Persisted, on the same test as the open file rather than a different one:
   * does the fact survive the round trip. A mode does, and more surely than a
   * path -- `changes` is a meaningful answer in every worktree in every state,
   * including a clean one, so there is nothing here that can go stale. It is
   * the same kind of fact as which terminal a worktree has selected.
   *
   * Absent means `files`, and nothing is written until the switch is used.
   */
  filesModeByWorktree: Record<string, FilesMode>
  /**
   * The files each worktree has open in Files mode, oldest first.
   *
   * These are the tabs above the editor, and the list is also what says whether
   * the editor exists at all: empty means the panel is the tree alone and half
   * a spot narrower. `openPathByWorktree` names which of them is showing.
   *
   * Files mode only. Changes and Commits open one thing at a time and close it
   * by clicking it again, so there is nothing there to keep a list of -- and a
   * diff is not something you collect the way you collect the files you are
   * working in.
   */
  openFilesByWorktree: Record<string, string[]>
}

export const defaultUiState = (): UiState => ({
  awake: null,
  panels: {},
  activeTerminalByWorktree: {},
  openPathByWorktree: {},
  expandedByWorktree: {},
  filesModeByWorktree: {},
  openFilesByWorktree: {},
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
 * One directory of a worktree: exactly one level.
 *
 * One level rather than a whole tree because the tree only ever shows what you
 * have expanded, and a recursive listing of a real repository is tens of
 * thousands of entries to render a handful of rows.
 */
export interface FileListing {
  /**
   * Echoed back, so a client that has already clicked elsewhere can drop a late
   * response instead of filing it under the wrong directory. `''` is the
   * worktree root.
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
   * and the panel's Changes mode agree about the same file -- or bytes that are
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

/**
 * One of Claude's usage limits, as `/usage` reports it.
 *
 * `percent` is what is *used*, 0-100, so a bar fills as the limit runs out.
 * `resets` is Claude's own wording ("Sep 15, 9am (UTC)") rather than a parsed
 * date: it is only ever shown, and re-deriving a timestamp from it would be a
 * second place to be wrong about time zones.
 */
export interface UsageLimit {
  /** Short label for the bar: `session`, `week`, or a model's name. */
  label: string
  percent: number
  resets: string | null
}

/**
 * What `claude -p /usage` last said, and when.
 *
 * `error` set with limits still present means the last read failed and these
 * are the previous numbers; the bars can say they are stale rather than
 * vanishing, which is the more useful of the two.
 */
export interface Usage {
  limits: UsageLimit[]
  fetchedAt: number
  error?: string
}
