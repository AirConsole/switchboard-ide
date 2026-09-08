import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorktreeChanges } from '@ide-n-dream/shared'
import { api } from '../api.js'

/**
 * What the diff pane is showing: one uncommitted file, or one commit.
 *
 * Held in component state rather than in UiState. A terminal choice is worth
 * remembering because the terminal persists; a diff selection is about a file
 * that may not still differ by the time you come back, so restoring it would
 * often restore a diff of nothing.
 */
export type Selection =
  | { kind: 'file'; path: string; untracked: boolean; from?: string }
  | { kind: 'commit'; hash: string }

/**
 * A diff big enough to be a rendering problem is truncated rather than allowed
 * to lock the tab up: one DOM node per line stops being free somewhere around
 * here, and nobody reads the four-thousandth line of a patch in a side panel.
 */
const MAX_DIFF_LINES = 3000

export interface GitState {
  changes: WorktreeChanges | null
  patch: string | null
  error: string | null
  selected: Selection | null
  select: (selection: Selection) => void
  reload: () => void
}

/**
 * Load a worktree's changes, and the patch for whatever is selected.
 *
 * Re-reads whenever `revision` changes -- the worktree's dirty count and HEAD,
 * which the server already tracks and pushes. Both are needed: an edit moves the
 * dirty count, and a commit from a clean tree moves only HEAD.
 *
 * Inert while `enabled` is false. The hook has to be called for every tile
 * whether or not its git panel is open, and without this every tile on screen
 * would shell out to git on mount to fill a panel nobody asked for.
 */
export const useGitState = (
  worktreeId: string,
  revision: string,
  enabled: boolean,
): GitState => {
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return
    let live = true
    void api
      .changes(worktreeId)
      .then((next) => {
        if (!live) return
        setChanges(next)
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

  // Follow the list: pick something to show, and drop a selection whose file has
  // stopped differing rather than leaving a stale patch on screen.
  useEffect(() => {
    if (changes === null) return
    const stillThere =
      selected === null
        ? false
        : selected.kind === 'file'
          ? changes.uncommitted.some((c) => c.path === selected.path)
          : changes.commits.some((c) => c.hash === selected.hash)
    if (stillThere) return
    const file = changes.uncommitted[0]
    const commit = changes.commits[0]
    setSelected(
      file
        ? { kind: 'file', path: file.path, untracked: file.status === '??', from: file.from }
        : commit
          ? { kind: 'commit', hash: commit.hash }
          : null,
    )
  }, [changes, selected])

  useEffect(() => {
    if (!enabled) return
    if (selected === null) {
      setPatch(null)
      return
    }
    let live = true
    const what =
      selected.kind === 'file'
        ? { file: selected.path, untracked: selected.untracked, from: selected.from }
        : { commit: selected.hash }
    void api
      .diff(worktreeId, what)
      .then((res) => {
        if (live) setPatch(res.patch)
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [worktreeId, selected, revision, nonce, enabled])

  const select = useCallback((next: Selection) => setSelected(next), [])
  return { changes, patch, error, selected, select, reload }
}

/** What the comparison is, for the bar segment above the pane. */
export const GitBar = ({
  state,
}: {
  state: GitState
}): React.ReactElement => {
  const { changes } = state
  return (
    <div className="git__bar">
      {changes?.base != null && (
        <span className="git__base" title={`Commits are measured against ${changes.base}`}>
          vs {changes.base}
        </span>
      )}
      {changes != null && changes.behind > 0 && (
        <span className="git__behind" title={`${changes.base} has ${changes.behind} commits this branch does not`}>
          {changes.behind} behind
        </span>
      )}
      <button className="git__reload" onClick={state.reload} title="Re-read git">
        Refresh
      </button>
    </div>
  )
}

/**
 * Colour each patch line by what it is.
 *
 * Position matters, not just the prefix: `--- a/x` is a file header, but `--- x`
 * inside a hunk is a deleted line whose content begins with two dashes, and the
 * text alone cannot tell them apart. So everything between a `diff --git` and
 * that file's first `@@` is header, and only inside a hunk does a leading + or
 * - mean added or removed.
 */
const classifyLines = (lines: string[]): string[] => {
  let inHunk = false
  return lines.map((line) => {
    if (line.startsWith('diff --git')) {
      inHunk = false
      return 'diffline diffline--meta'
    }
    if (line.startsWith('@@')) {
      inHunk = true
      return 'diffline diffline--hunk'
    }
    if (!inHunk) return 'diffline diffline--meta'
    // "\ No newline at end of file" is git talking, not file content.
    if (line.startsWith('\\')) return 'diffline diffline--meta'
    if (line.startsWith('+')) return 'diffline diffline--add'
    if (line.startsWith('-')) return 'diffline diffline--del'
    return 'diffline'
  })
}

const Diff = ({ patch }: { patch: string }): React.ReactElement => {
  const lines = useMemo(() => {
    const all = patch.split('\n')
    const shown = all.slice(0, MAX_DIFF_LINES)
    return { shown, classes: classifyLines(shown), cut: Math.max(0, all.length - MAX_DIFF_LINES) }
  }, [patch])

  if (patch.trim() === '') {
    return <p className="git__empty">No textual difference.</p>
  }
  return (
    <div className="diff">
      {lines.shown.map((line, index) => (
        // Index keys: this is a rendered text buffer, never reordered.
        <div key={index} className={lines.classes[index]}>
          {line === '' ? ' ' : line}
        </div>
      ))}
      {lines.cut > 0 && (
        <div className="diffline diffline--meta">
          … {lines.cut} more lines. Read this one in a terminal.
        </div>
      )}
    </div>
  )
}

export interface GitPaneProps {
  state: GitState
  /** Shown in the commits heading, so it says what the commits are on. */
  branch: string | null
}

/**
 * A worktree's changes, and the patch for the one selected.
 *
 * Committed and uncommitted together, because Claude normally commits its work:
 * a panel showing only the working tree would be empty exactly when the agent
 * finished cleanly. The list is short and the patch takes the rest of the
 * height, since reading the patch is the point and the list is only how you
 * choose one.
 */
export const GitPane = ({ state, branch }: GitPaneProps): React.ReactElement => {
  const { changes, patch, error, selected, select } = state

  if (error !== null) {
    return (
      <div className="git">
        <p className="git__empty">{error}</p>
      </div>
    )
  }
  if (changes === null) {
    return (
      <div className="git">
        <p className="git__empty">Reading git…</p>
      </div>
    )
  }

  const nothing = changes.uncommitted.length === 0 && changes.commits.length === 0

  return (
    <div className="git">
      <div className="git__list">
        {nothing && <p className="git__empty">Nothing changed in this worktree.</p>}

        {changes.uncommitted.length > 0 && (
          <>
            <div className="git__heading">Uncommitted</div>
            {changes.uncommitted.map((change) => (
              <button
                key={change.path}
                className={
                  selected?.kind === 'file' && selected.path === change.path
                    ? 'git__row git__row--on'
                    : 'git__row'
                }
                onClick={() =>
                  select({
                    kind: 'file',
                    path: change.path,
                    untracked: change.status === '??',
                    from: change.from,
                  })
                }
                title={change.from ? `${change.from} → ${change.path}` : change.path}
              >
                {/* git's own two-letter code, index then worktree. */}
                <span className="git__status">{change.status.replace(/ /g, '·')}</span>
                <span className="git__path">{change.path}</span>
              </button>
            ))}
          </>
        )}

        {changes.commits.length > 0 && (
          <>
            <div className="git__heading">
              {changes.commits.length === 1 ? '1 commit' : `${changes.commits.length} commits`}
              {branch !== null && ` on ${branch}`}
            </div>
            {changes.commits.map((commit) => (
              <button
                key={commit.hash}
                className={
                  selected?.kind === 'commit' && selected.hash === commit.hash
                    ? 'git__row git__row--on'
                    : 'git__row'
                }
                onClick={() => select({ kind: 'commit', hash: commit.hash })}
                title={`${commit.hash}\n${commit.author}\n${new Date(commit.at).toLocaleString()}`}
              >
                <span className="git__status git__status--hash">{commit.short}</span>
                <span className="git__path">{commit.subject}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="git__diff">
        {patch === null ? (
          selected === null ? null : <p className="git__empty">Reading the patch…</p>
        ) : (
          <Diff patch={patch} />
        )}
      </div>
    </div>
  )
}
