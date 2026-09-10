import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Commit, FileChange, FilesMode, WorktreeChanges } from '@ide-n-dream/shared'
import { api } from '../api.js'

/**
 * A diff big enough to be a rendering problem is truncated rather than allowed
 * to lock the tab up: one DOM node per line stops being free somewhere around
 * here, and nobody reads the four-thousandth line of a patch in a side panel.
 */
const MAX_DIFF_LINES = 3000

/**
 * How often an open panel re-reads git for itself.
 *
 * It has to, because no cheap signal notices the commonest thing an agent does.
 * The server pushes when a worktree's dirty count or HEAD moves, and neither
 * changes when a file already in the list is edited again -- so the panel sat
 * showing a patch that was minutes out of date while the count beside it stayed
 * correct, which read as "the chip updates and the view does not".
 *
 * Only a panel actually on screen polls, so the cost is proportional to what is
 * being watched rather than to how many worktrees exist. Results are compared
 * before they are stored, so an unchanged patch re-renders nothing and cannot
 * throw away your scroll position.
 */
const POLL_MS = 3000

/**
 * How far each level of a tree is indented, in px.
 *
 * Lives here rather than in the panel shell only because the import has to run
 * one way: the shell composes these lists, so it reads this and not the other
 * way about. Both trees indent alike, which is the point.
 */
export const INDENT = 11

/**
 * Filtering the two lists this pane already holds.
 *
 * Unlike Files mode, which has to ask the server because the tree only holds
 * what you expanded, these arrive whole -- a worktree's changes and its commits
 * are both short by nature. So they filter in place, with no round trip.
 *
 * Case-insensitive substring, matching the server's own rule for filenames, so
 * one box means one thing in all three modes.
 */
export const matchingChanges = (changes: FileChange[], query: string): FileChange[] => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return changes
  return changes.filter(
    (change) =>
      change.path.toLowerCase().includes(needle) ||
      (change.from ?? '').toLowerCase().includes(needle),
  )
}

/** A commit matches on what you can see of it, plus its full hash. */
export const matchingCommits = (commits: Commit[], query: string): Commit[] => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return commits
  return commits.filter(
    (commit) =>
      commit.subject.toLowerCase().includes(needle) ||
      commit.author.toLowerCase().includes(needle) ||
      commit.hash.toLowerCase().startsWith(needle),
  )
}

/** One row of the changed-files tree. */
export interface ChangeRow {
  /** The file, or the deepest directory of a folded chain. */
  path: string
  /** What the row shows: one segment, or a chain like `web/src/views`. */
  label: string
  kind: 'dir' | 'file'
  depth: number
  /** Files only: git's own two-letter code, kept verbatim. */
  status?: string
}

interface TrieNode {
  name: string
  children: Map<string, TrieNode>
  change?: FileChange
}

/**
 * The changed files as rows, with single-child directory chains folded up.
 *
 * Five files changed four levels down would otherwise spend eleven rows to show
 * five, most of them on directories with one child and nothing to choose. A
 * folded chain says the same thing in one row, and leaves the grouping intact
 * where several files really did change in one place.
 *
 * Directories are ordered before files and then by name, which is the order the
 * server already applies to a real directory listing -- so this tree and the one
 * in Files mode never disagree about where a name sits.
 */
export const changeRows = (uncommitted: FileChange[]): ChangeRow[] => {
  const root: TrieNode = { name: '', children: new Map() }
  for (const change of uncommitted) {
    let at = root
    const parts = change.path.split('/')
    parts.forEach((part, index) => {
      let next = at.children.get(part)
      if (!next) {
        next = { name: part, children: new Map() }
        at.children.set(part, next)
      }
      if (index === parts.length - 1) next.change = change
      at = next
    })
  }

  const ordered = (node: TrieNode): TrieNode[] =>
    [...node.children.values()].sort((a, b) => {
      const aDir = a.change === undefined
      const bDir = b.change === undefined
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  const rows: ChangeRow[] = []
  const emit = (node: TrieNode, prefix: string, depth: number): void => {
    /*
     * Folded here rather than while descending, which is what makes the root's
     * own chain fall out with no special case: a repository whose every change
     * is under `web/src` opens with `web/src` as one row at depth zero.
     */
    let label = node.name
    let path = prefix === '' ? node.name : `${prefix}/${node.name}`
    let current = node
    while (current.change === undefined && current.children.size === 1) {
      const only = [...current.children.values()][0]
      if (!only || only.change !== undefined) break
      label = `${label}/${only.name}`
      path = `${path}/${only.name}`
      current = only
    }
    rows.push(
      current.change === undefined
        ? { path, label, kind: 'dir', depth }
        : { path, label, kind: 'file', depth, status: current.change.status },
    )
    for (const child of ordered(current)) emit(child, path, depth + 1)
  }
  for (const child of ordered(root)) emit(child, '', 0)
  return rows
}

export interface ChangesState {
  changes: WorktreeChanges | null
  patch: string | null
  error: string | null
  /**
   * The commit whose patch is shown. Owned by the row, not by this hook.
   *
   * It moved out when the panel stopped always showing a content pane: whether
   * a commit is open decides how wide the tile is, and only the row lays out
   * the row. It is still not persisted -- a rebase, an amend or a squash makes
   * a stored hash name nothing at all.
   */
  commit: string | null
  selectCommit: (hash: string | null) => void
  reload: () => void
}

/**
 * A worktree's changes, and the patch for whatever is selected.
 *
 * Re-reads whenever `revision` changes -- the worktree's dirty count and HEAD,
 * which the server already tracks and pushes. Both are needed: an edit moves the
 * dirty count, and a commit from a clean tree moves only HEAD.
 *
 * Inert while `enabled` is false, which is also how the panel avoids doing two
 * jobs at once: only one of this hook and `useFilesState` is enabled at a time,
 * so an open panel polls for the mode you are actually looking at.
 */
export const useChangesState = (opts: {
  worktreeId: string
  revision: string
  enabled: boolean
  /** The open file, shared with Files mode. `''` for none. */
  path: string
  /** Which face is showing: only `commits` diffs a commit. */
  mode: FilesMode
  /** The open commit, held by the row because it decides the tile's width. */
  commit: string | null
  onSelectCommit: (hash: string | null) => void
}): ChangesState => {
  const { worktreeId, revision, enabled, path, mode, commit, onSelectCommit } = opts
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // Only while the panel is on screen; see the note on POLL_MS.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, reload])

  /*
   * `enabled` is in this dependency array on purpose, and must stay there: it is
   * what makes switching back to this mode re-read at once rather than showing
   * the last poll's answer until the next one. Hoisting the guard out would put
   * a three-second window of stale git behind every mode switch.
   */
  useEffect(() => {
    if (!enabled) return
    let live = true
    void api
      .changes(worktreeId)
      .then((next) => {
        if (!live) return
        setChanges((prev) =>
          prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
        )
        setError(null)
      })
      .catch((err: unknown) => {
        if (!live) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [worktreeId, revision, nonce, enabled])

  /*
   * A hash that no longer names a commit closes the pane.
   *
   * Nothing auto-selects any more: the panel opens its content pane when you
   * pick something, so choosing for you would open it on arrival and the tile
   * would never be seen at its narrow width. This is the other half of that --
   * an amend or a rebase leaves a selection pointing at nothing, and an open
   * pane showing no patch is worse than the tree it came from.
   *
   * The file selection is still not touched here: it belongs to the panel as a
   * whole, and moving it from inside an effect would change what the editor
   * shows without anyone having clicked.
   */
  const selectRef = useRef(onSelectCommit)
  selectRef.current = onSelectCommit
  useEffect(() => {
    if (changes === null || commit === null) return
    if (changes.commits.some((c) => c.hash === commit)) return
    // Through a ref, so the row's per-tile arrow -- a fresh identity on every
    // render -- does not put this effect in every render's way.
    selectRef.current(null)
  }, [changes, commit])

  useEffect(() => {
    if (!enabled) return
    /*
     * What the diff is of, derived rather than stored. `untracked` and `from`
     * live on the FileChange, so looking the path up here is what keeps a
     * second copy of them from existing to disagree with git.
     */
    const change = mode === 'changes' ? changes?.uncommitted.find((c) => c.path === path) : undefined
    const what =
      mode === 'commits'
        ? commit === null
          ? null
          : { commit }
        : change === undefined
          ? null
          : { file: change.path, untracked: change.status === '??', from: change.from }
    if (what === null) {
      setPatch(null)
      return
    }
    let live = true
    void api
      .diff(worktreeId, what)
      .then((res) => {
        // Reference equality is what stops the diff re-rendering every poll,
        // which would also reset the scroll position under the reader.
        if (live) setPatch((prev) => (prev === res.patch ? prev : res.patch))
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [worktreeId, path, commit, mode, changes, revision, nonce, enabled])

  return { changes, patch, error, commit, selectCommit: onSelectCommit, reload }
}

/**
 * One file's worth of a patch: what it is, and its hunks.
 *
 * Split up because a raw patch spends four or five lines per file saying things
 * the reader can already see -- `diff --git`, the blob hashes, and the a/ and
 * b/ paths repeated -- and in a column 80 characters wide that is most of a
 * screenful of noise before the first change. All of it collapses to the one
 * fact worth keeping: which file this is.
 */
interface DiffFile {
  /** The path, or `old → new` for a rename. */
  label: string
  /** Set when the file is not simply modified: new, deleted, renamed, binary. */
  note: string | null
  /** Hunk headers and content, with the file headers dropped. */
  lines: string[]
}

const strip = (path: string): string => path.replace(/^[ab]\//, '')

/**
 * Split a patch into files, keeping the hunks and discarding the headers.
 *
 * Everything between a `diff --git` and that file's first `@@` is header: that
 * is also what makes the +/- classification below safe, since inside a hunk a
 * leading dash is content, not a marker.
 */
export const parsePatch = (patch: string): DiffFile[] => {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let inHunk = false
  let from: string | null = null

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      file = { label: '', note: null, lines: [] }
      files.push(file)
      inHunk = false
      from = null
      continue
    }
    if (file === null) continue

    if (line.startsWith('@@')) inHunk = true
    if (inHunk) {
      file.lines.push(line)
      continue
    }

    // Still in the header block: read what it says, then throw it away.
    if (line.startsWith('--- ')) {
      const path = line.slice(4)
      if (path !== '/dev/null') from = strip(path)
    } else if (line.startsWith('+++ ')) {
      const path = line.slice(4)
      if (path !== '/dev/null') file.label = strip(path)
      else if (from !== null) file.label = from
    } else if (line.startsWith('new file')) {
      file.note = 'new'
    } else if (line.startsWith('deleted file')) {
      file.note = 'deleted'
    } else if (line.startsWith('rename from ')) {
      from = line.slice('rename from '.length)
      file.note = 'renamed'
    } else if (line.startsWith('rename to ')) {
      file.label = `${from ?? ''} → ${line.slice('rename to '.length)}`
    } else if (line.startsWith('Binary files')) {
      file.note = 'binary'
    }
  }
  return files.filter((f) => f.label !== '' || f.lines.length > 0)
}

/**
 * Colour a hunk line.
 *
 * Only ever called with lines from inside a hunk, which is what makes a leading
 * dash unambiguous: `--- a/x` never reaches here, so `--- x` can be read as a
 * deleted line whose content begins with two dashes.
 */
const lineClass = (line: string): string => {
  if (line.startsWith('@@')) return 'diffline diffline--hunk'
  // "\ No newline at end of file" is git talking, not file content.
  if (line.startsWith('\\')) return 'diffline diffline--meta'
  if (line.startsWith('+')) return 'diffline diffline--add'
  if (line.startsWith('-')) return 'diffline diffline--del'
  return 'diffline'
}

/**
 * The patch, one file at a time.
 *
 * `showFiles` names each file, which is what a commit needs -- it can touch any
 * number of them and the hunks alone do not say which is which. A single
 * selected file names itself in the list beside this, so it is left unlabelled;
 * the exception is a file with no hunks at all, a pure rename, which would
 * otherwise render as nothing.
 */
export const Diff = ({ patch, showFiles }: { patch: string; showFiles: boolean }): React.ReactElement => {
  const files = useMemo(() => parsePatch(patch), [patch])
  const total = files.reduce((n, f) => n + f.lines.length, 0)

  if (files.length === 0 || (total === 0 && files.every((f) => f.note === null))) {
    return <p className="git__empty">No textual difference.</p>
  }

  let budget = MAX_DIFF_LINES
  return (
    <div className="diff">
      {files.map((file) => {
        const lines = file.lines.slice(0, Math.max(0, budget))
        budget -= lines.length
        return (
          <div className="diff__file" key={`${file.label}${file.lines.length}`}>
            {(showFiles || files.length > 1 || file.lines.length === 0) && (
              <div className="diff__name">
                <span className="diff__path">{file.label}</span>
                {file.note !== null && <span className="diff__note">{file.note}</span>}
              </div>
            )}
            {lines.map((line, index) => (
              // Index keys: this is a rendered text buffer, never reordered.
              <div key={index} className={lineClass(line)}>
                {line === '' ? ' ' : line}
              </div>
            ))}
          </div>
        )
      })}
      {total > MAX_DIFF_LINES && (
        <div className="diffline diffline--meta">
          … {total - MAX_DIFF_LINES} more lines. Read this one in a terminal.
        </div>
      )}
    </div>
  )
}

/**
 * The changed files, as a folded tree.
 *
 * Directory rows are labels rather than buttons: everything here is expanded
 * already, so there is nothing to collapse, and the server has no diff of a
 * directory to show. Only files are selectable, and selecting one is the same
 * act as opening it in Files mode -- it writes the panel's one path.
 */
export const ChangesList = ({
  rows,
  path,
  onOpen,
}: {
  rows: ChangeRow[]
  path: string
  onOpen: (path: string) => void
}): React.ReactElement => (
  <>
    {rows.map((row) =>
      row.kind === 'dir' ? (
        <span
          key={row.path}
          className="files__row files__row--dir"
          style={{ paddingLeft: 6 + row.depth * INDENT }}
          title={row.path}
        >
          <span className="files__name">{row.label}</span>
        </span>
      ) : (
        <button
          key={row.path}
          className={row.path === path ? 'files__row files__row--on' : 'files__row'}
          style={{ paddingLeft: 6 + row.depth * INDENT }}
          onClick={() => onOpen(row.path)}
          title={row.path}
        >
          <span className="files__name">{row.label}</span>
          {/* git's own two-letter code, index then worktree. */}
          <span className="files__status">{row.status?.replace(/ /g, '·')}</span>
        </button>
      ),
    )}
  </>
)

/**
 * The commits this worktree has that its base does not, or -- where that
 * question has no answer -- what has happened here lately.
 */
export const CommitsList = ({
  commits,
  scope,
  selected,
  onSelect,
}: {
  commits: Commit[]
  scope: 'ahead' | 'recent'
  selected: string | null
  onSelect: (hash: string) => void
}): React.ReactElement => (
  <>
    {commits.map((commit) => (
      <button
        key={commit.hash}
        className={commit.hash === selected ? 'files__commit files__commit--on' : 'files__commit'}
        onClick={() => onSelect(commit.hash)}
        title={`${commit.hash}\n${commit.author}\n${new Date(commit.at).toLocaleString()}`}
      >
        <span className="files__hash">{commit.short}</span>
        <span className="files__subject">{commit.subject}</span>
      </button>
    ))}
    {commits.length === 0 && (
      <p className="files__note">
        {scope === 'ahead' ? 'Nothing committed here yet.' : 'No history here yet.'}
      </p>
    )}
  </>
)
