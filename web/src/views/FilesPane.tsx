import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileEntry } from '@ide-n-dream/shared'
import { ApiError, api } from '../api.js'
import type { EditorFile } from '../editor/CodeEditor.js'

/*
 * CodeMirror is fetched the first time a files panel actually shows a file.
 * A session that never opens one never downloads it, and `fallback={null}`
 * keeps the no-spinner rule -- the pane simply shows its ground until it lands.
 */
const CodeEditor = lazy(() => import('../editor/CodeEditor.js'))

/**
 * How often an open panel re-reads the directories it is showing.
 *
 * The same reasoning as the git panel's own poll, which its `POLL_MS` sets out:
 * the server pushes when a worktree's dirty count or HEAD moves, and neither
 * moves when a file already counted as changed is changed again -- or when an
 * agent creates a file in a directory you happen to have expanded.
 *
 * This one keeps running even while you have unsaved edits. Freezing it would
 * hide the agent adding files; only the open document freezes.
 */
const TREE_POLL_MS = 3000

/** How often the open file is checked against disk. */
const FILE_POLL_MS = 2000

/** One visible line of the tree: an entry, and how deep it sits. */
export interface TreeRow {
  /** Worktree-relative path. */
  path: string
  name: string
  kind: 'dir' | 'file'
  depth: number
  changed: boolean
  /** Directories only: whether this one is open. */
  open: boolean
}

export interface FilesState {
  /** The open file, `''` for none. */
  path: string
  rows: TreeRow[]
  /** Set before the root has been read even once, so nothing is drawn yet. */
  loading: boolean
  /** The open file as it is on disk, or null when none can be shown. */
  file: EditorFile | null
  /** Why there is no file to show: not text, too large, gone. */
  refusal: string | null
  dirty: boolean
  saving: boolean
  /** A save was refused because the file moved on disk underneath it. */
  conflict: boolean
  error: string | null
  open: (path: string) => void
  toggleDir: (dir: string) => void
  edited: (text: string) => void
  draft: () => string | null
  save: () => void
  overwrite: () => void
  revert: () => void
}

/** The directory a path is in, `''` at the root. */
const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

const joinPath = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

/** Every directory above a path, roots first. */
export const ancestorsOf = (path: string): string[] => {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/**
 * The tree, flattened to the rows actually on screen.
 *
 * Recursive over what is expanded rather than over the filesystem: an
 * unexpanded directory contributes one row and nothing is known about its
 * contents until it is opened, which is what keeps a repository of any size to
 * the handful of listings the reader has actually asked for.
 */
const flatten = (
  dir: string,
  depth: number,
  listings: Record<string, FileEntry[]>,
  expanded: Set<string>,
  out: TreeRow[],
): void => {
  for (const entry of listings[dir] ?? []) {
    const path = joinPath(dir, entry.name)
    const open = entry.kind === 'dir' && expanded.has(path)
    out.push({
      path,
      name: entry.name,
      kind: entry.kind,
      depth,
      changed: entry.changed === true,
      open,
    })
    if (open) flatten(path, depth + 1, listings, expanded, out)
  }
}

/**
 * A worktree's files: the tree, and the file it has open.
 *
 * Inert while `enabled` is false, for the reason `useGitState` is: the hook is
 * called for every tile whether or not its panel is open, and without this
 * every tile on screen would read directories to fill a panel nobody asked for.
 */
export const useFilesState = (opts: {
  worktreeId: string
  revision: string
  enabled: boolean
  /** The open file, `''` for none. */
  path: string
  /** Directories the reader has expanded. */
  expanded: string[]
  onOpen: (path: string) => void
  onToggleDir: (dir: string) => void
}): FilesState => {
  const { worktreeId, revision, enabled, path, expanded, onOpen, onToggleDir } = opts

  const [listings, setListings] = useState<Record<string, FileEntry[]>>({})
  const [file, setFile] = useState<EditorFile | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [treeNonce, setTreeNonce] = useState(0)
  const [fileNonce, setFileNonce] = useState(0)

  /*
   * The unsaved buffer lives in a ref, and only a boolean reaches state.
   *
   * If it were state, every keystroke would re-render the whole tile -- and the
   * tile holds two live terminals beside this pane. It also makes "dirty" mean
   * *the buffer differs from disk* rather than *something was typed*, so
   * undoing back to the file's own text clears it for nothing.
   */
  const draftRef = useRef<string | null>(null)
  /** The rev of what `file` holds; the stale-write guard's half of the bargain. */
  const revRef = useRef<string | null>(null)
  /** The rev the server reported when it refused a save. */
  const freshRevRef = useRef<string | null>(null)

  const filePath = path === '' ? null : path
  // The root is always read; everything else only once it has been expanded.
  const dirsKey = ['', ...expanded].join('\n')

  // Only while the panel is on screen; see TREE_POLL_MS.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setTreeNonce((n) => n + 1), TREE_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled])

  /*
   * Read the root and every expanded directory.
   *
   * Results are compared before they are stored, so a directory that has not
   * changed re-renders nothing and cannot throw away the tree's scroll position
   * -- the same discipline the git panel keeps with its patch.
   */
  useEffect(() => {
    if (!enabled) return
    let live = true
    for (const dir of dirsKey.split('\n')) {
      void api
        .tree(worktreeId, dir)
        .then((listing) => {
          if (!live) return
          setListings((previous) => {
            const had = previous[dir]
            if (had !== undefined && JSON.stringify(had) === JSON.stringify(listing.entries)) {
              return previous
            }
            return { ...previous, [dir]: listing.entries }
          })
        })
        .catch((err: unknown) => {
          if (!live) return
          /*
           * A stored path can name a directory that is gone -- the agent deleted
           * it, or this is a reload onto a different branch. Forget it rather
           * than showing an error about a path nobody chose; the root failing is
           * a real error and does get shown.
           */
          if (err instanceof ApiError && err.status === 404 && dir !== '') {
            setListings((previous) => {
              if (previous[dir] === undefined) return previous
              const next = { ...previous }
              delete next[dir]
              return next
            })
            onToggleDir(dir)
            return
          }
          setError(err instanceof Error ? err.message : String(err))
        })
    }
    return () => {
      live = false
    }
  }, [worktreeId, dirsKey, revision, treeNonce, enabled, onToggleDir])

  /*
   * The open file, and the poll that follows it.
   *
   * One request does both jobs: the rev already held goes up as `ifNotRev`, and
   * a file that has not moved costs the server a single stat and comes back as
   * `unchanged`. Skipped entirely while there are unsaved edits -- the document
   * you are editing must not be rewritten underneath you.
   */
  useEffect(() => {
    if (!enabled || filePath === null) {
      if (filePath === null) {
        setFile(null)
        setRefusal(null)
        revRef.current = null
      }
      return
    }
    let live = true
    const read = (): void => {
      if (draftRef.current !== null) return
      void api
        .readFile(worktreeId, filePath, revRef.current ?? undefined)
        .then((result) => {
          if (!live) return
          if ('unchanged' in result) return
          revRef.current = result.rev
          if (result.binary === true) {
            setFile(null)
            setRefusal('This is not a text file.')
            return
          }
          if (result.tooLarge === true) {
            setFile(null)
            setRefusal(`${Math.round(result.size / 1024)} KB — too large to open here.`)
            return
          }
          if (result.text === undefined) return
          const text = result.text
          setRefusal(null)
          setFile((previous) =>
            previous !== null && previous.path === result.path && previous.text === text
              ? previous
              : { path: result.path, text },
          )
        })
        .catch((err: unknown) => {
          if (!live) return
          if (err instanceof ApiError && err.status === 404) {
            onOpen('')
            return
          }
          setError(err instanceof Error ? err.message : String(err))
        })
    }
    read()
    const timer = setInterval(read, FILE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [worktreeId, filePath, revision, fileNonce, enabled, onOpen])

  // A different file starts with a clean slate; the old draft belonged to the
  // old file and there is nowhere sensible to put it.
  useEffect(() => {
    draftRef.current = null
    freshRevRef.current = null
    setDirty(false)
    setConflict(false)
  }, [filePath])

  /*
   * What is on disk, read by `edited` below without being a dependency of it: a
   * new callback identity on every poll would rebuild the editor's listener for
   * nothing.
   */
  const lastDiskRef = useRef<string | null>(null)
  lastDiskRef.current = file?.text ?? null

  const edited = useCallback((text: string): void => {
    const clean = text === lastDiskRef.current
    draftRef.current = clean ? null : text
    setDirty((was) => (was === !clean ? was : !clean))
  }, [])

  const draft = useCallback((): string | null => draftRef.current, [])

  const put = useCallback(
    (ifRev: string): void => {
      const text = draftRef.current
      if (text === null || filePath === null) return
      setSaving(true)
      void api
        .writeFile(worktreeId, { path: filePath, text, ifRev })
        .then((saved) => {
          revRef.current = saved.rev
          freshRevRef.current = null
          draftRef.current = null
          setDirty(false)
          setConflict(false)
          setError(null)
          // The editor already holds this text, so the follow-up produces no
          // edit and the cursor does not move.
          setFile({ path: saved.path, text })
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.code === 'stale-file') {
            const rev = err.details['rev']
            freshRevRef.current = typeof rev === 'string' ? rev : null
            setConflict(true)
            return
          }
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => setSaving(false))
    },
    [worktreeId, filePath],
  )

  const save = useCallback((): void => {
    if (revRef.current !== null) put(revRef.current)
  }, [put])

  /*
   * Overwrite deliberately: the same save again, against the rev the server
   * named when it refused. Not an unconditional write -- if the file has moved
   * *again* in the meantime this is refused again, which is right.
   */
  const overwrite = useCallback((): void => {
    const rev = freshRevRef.current
    if (rev !== null) put(rev)
  }, [put])

  const revert = useCallback((): void => {
    draftRef.current = null
    freshRevRef.current = null
    setDirty(false)
    setConflict(false)
    // A new identity for the same file, so the editor takes the disk text back.
    setFile((previous) => (previous === null ? previous : { ...previous }))
    setFileNonce((n) => n + 1)
  }, [])

  const rows: TreeRow[] = []
  flatten('', 0, listings, new Set(expanded), rows)

  return {
    path,
    rows,
    loading: listings[''] === undefined,
    file,
    refusal,
    dirty,
    saving,
    conflict,
    error,
    open: onOpen,
    toggleDir: onToggleDir,
    edited,
    draft,
    save,
    overwrite,
    revert,
  }
}

/**
 * The panel's controls, for the worktree's bar.
 *
 * Where you are, whether it is saved, and how to save it -- in the segment
 * above the pane they act on, structured like `GitBar` beside it.
 */
export const FilesBar = ({ state }: { state: FilesState }): React.ReactElement => {
  const open = state.path === '' ? null : state.path
  const shortened = open === null ? null : open.split('/').slice(-2).join('/')
  return (
    <div className="files__bar">
      {shortened !== null && (
        <span className="files__path" title={open ?? undefined}>
          {shortened}
        </span>
      )}
      {state.dirty && <span className="files__unsaved">Unsaved</span>}
      {open !== null && (
        <button
          className="files__save"
          onClick={state.save}
          // Present whenever a file is open, so the first keystroke does not
          // shove the path sideways to make room for it.
          disabled={!state.dirty || state.saving}
          title="Save (⌘S)"
        >
          Save
        </button>
      )}
    </div>
  )
}

/** How far each level of the tree is indented, in px. */
const INDENT = 11

export interface FilesPaneProps {
  state: FilesState
  /** Whether the tile is close enough to the scrollport to build an editor. */
  near: boolean
}

/**
 * A worktree's files: a tree down the side, and the open file beside it.
 *
 * The tree is the whole navigation -- click a directory to expand it, a file to
 * read it -- and it scrolls on its own, which is also what lets a wheel over it
 * scroll the tree rather than the row of windows behind it.
 */
export const FilesPane = ({ state, near }: FilesPaneProps): React.ReactElement => {
  const treeRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const { rows, open, toggleDir } = state
  /** The row the keyboard is on. Null until the tree is used with the keyboard. */
  const [cursor, setCursor] = useState<string | null>(null)
  const [keyFocus, setKeyFocus] = useState(0)

  // The row the keyboard would act on: what it last landed on, else the open
  // file, else the first thing in the tree.
  const at = rows.findIndex((row) => row.path === (cursor ?? state.path))
  const here = at === -1 ? (rows.length > 0 ? 0 : -1) : at

  // Bring a restored file into view without touching anything else.
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [state.path])

  useLayoutEffect(() => {
    if (keyFocus > 0) selectedRef.current?.focus()
  }, [keyFocus])

  const pick = (row: TreeRow): void => {
    setCursor(row.path)
    if (row.kind === 'dir') toggleDir(row.path)
    else open(row.path)
  }

  /*
   * A tree's keys, and nothing invented: up and down through what is on screen,
   * right to open a directory, left to close it or step out to its parent.
   *
   * Moving is not opening here, unlike a click. Arrowing past twenty files
   * would otherwise read and render twenty of them; Enter is the one that says
   * you meant it.
   *
   * On the tree rather than on the document: with a dozen tiles awake, a
   * document-level arrow handler has no idea whose files it is moving.
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    /*
     * Any modifier and it is not ours -- which is what leaves Cmd+Left and
     * Cmd+Right to the row's worktree stepping while the keyboard is in the
     * tree. A file row is not a text field, so that handler is right to take
     * them there.
     */
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const row = rows[here]
    const step = (to: number): void => {
      const next = rows[Math.min(Math.max(to, 0), rows.length - 1)]
      if (next) {
        setCursor(next.path)
        setKeyFocus((n) => n + 1)
      }
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        step(here + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        step(here - 1)
        return
      case 'ArrowRight':
        if (!row) return
        event.preventDefault()
        if (row.kind === 'dir' && !row.open) {
          setKeyFocus((n) => n + 1)
          toggleDir(row.path)
        } else {
          step(here + 1)
        }
        return
      case 'ArrowLeft': {
        if (!row) return
        event.preventDefault()
        // Close an open directory; otherwise go out to the one holding this.
        if (row.kind === 'dir' && row.open) {
          setKeyFocus((n) => n + 1)
          toggleDir(row.path)
          return
        }
        const parent = parentOf(row.path)
        if (parent === '') return
        const up = rows.findIndex((r) => r.path === parent)
        if (up !== -1) step(up)
        return
      }
      case 'Enter':
      case ' ':
        if (!row) return
        event.preventDefault()
        setKeyFocus((n) => n + 1)
        pick(row)
        return
      default:
    }
  }

  /*
   * An unsaved edit is not something to unmount. Off screen or not, it is the
   * thing you are working on.
   */
  const mountEditor = near || state.dirty

  return (
    <div
      className="files"
      onKeyDown={(event) => {
        /*
         * Cmd+S with the keyboard in the tree would otherwise open the browser's
         * Save Page dialog. The editor's own binding has already prevented it
         * when the keyboard is in there.
         */
        if (event.defaultPrevented) return
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault()
          state.save()
        }
      }}
    >
      <div className="files__tree" ref={treeRef} onKeyDown={onKeyDown}>
        {/* Nothing at all while the root is being read: a local directory
            listing takes a few milliseconds, and a word that flashes for one
            frame is worse than empty space. */}
        {!state.loading && rows.length === 0 && <p className="files__note">Nothing here.</p>}
        {rows.map((row, index) => {
          const isOpenFile = row.kind === 'file' && row.path === state.path
          const onCursor = index === here
          return (
            <button
              key={row.path}
              ref={onCursor ? selectedRef : null}
              className={[
                'files__row',
                isOpenFile ? 'files__row--on' : '',
                row.changed ? 'files__row--changed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: 6 + row.depth * INDENT }}
              // Roving tabindex: Tab reaches the tree once, rather than walking
              // through two hundred files to get past it.
              tabIndex={onCursor ? 0 : -1}
              onClick={() => pick(row)}
              title={row.path}
            >
              {/* A file gets the same spacer, so names line up under the
                  directories they are in rather than by a character. */}
              <span className="files__twist" aria-hidden="true">
                {row.kind === 'dir' ? (row.open ? '▾' : '▸') : ''}
              </span>
              <span className="files__name">{row.name}</span>
            </button>
          )
        })}
      </div>

      <div className="files__file">
        {state.error !== null && <div className="files__notice">{state.error}</div>}

        {state.conflict && (
          <div className="files__notice">
            <span>This file changed on disk while you were editing it.</span>
            <span className="files__notice-actions">
              <button className="files__act" onClick={state.overwrite}>
                Overwrite
              </button>
              <button className="files__act" onClick={state.revert}>
                Discard my edits
              </button>
            </span>
          </div>
        )}

        {state.refusal !== null ? (
          <p className="files__note">{state.refusal}</p>
        ) : state.file === null ? (
          <p className="files__note">Pick a file to read it here.</p>
        ) : (
          mountEditor && (
            <Suspense fallback={null}>
              <CodeEditor
                file={state.file}
                draft={state.draft}
                onChange={state.edited}
                onSave={state.save}
              />
            </Suspense>
          )
        )}
      </div>
    </div>
  )
}
