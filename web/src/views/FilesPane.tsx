import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
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
 * agent creates a file in a directory you happen to be looking at.
 *
 * This one keeps running even while you have unsaved edits. Freezing it would
 * hide the agent adding files; only the open document freezes.
 */
const TREE_POLL_MS = 3000

/** How often the open file is checked against disk. See `FILE` below. */
const FILE_POLL_MS = 2000

/**
 * How long a selection has to settle before anything is fetched.
 *
 * Not cosmetic: holding Down through a forty-entry column would otherwise fire
 * forty directory reads and forty file reads, and each directory read spawns a
 * `git check-ignore`. A directory already in the cache still renders instantly,
 * so this is only ever visible on one you have never opened.
 */
const OPEN_DEBOUNCE_MS = 120

/** One column of the browser: a directory, and which child is on the path. */
export interface DirColumn {
  /** `''` for the worktree root. */
  dir: string
  /** Null until this directory has been read for the first time. */
  entries: FileEntry[] | null
  error: string | null
  /** The child of this directory that the open path goes through. */
  selected: string | null
}

export interface FilesState {
  path: string
  columns: DirColumn[]
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

/**
 * The columns a path implies.
 *
 * Column *i* lists `segments.slice(0, i)` and highlights `segments[i]`, so every
 * column on the chain carries a selection -- which is what makes the path
 * readable once the strip has been scrolled away from its root. It *is* the
 * breadcrumb. A trailing slash means a directory was opened with nothing chosen
 * inside it, and gets a column of its own with no selection.
 */
const columnsFor = (path: string): { dir: string; selected: string | null }[] => {
  const isDir = path === '' || path.endsWith('/')
  const trimmed = isDir ? path.slice(0, -1) : path
  const segments = trimmed === '' ? [] : trimmed.split('/')
  const count = isDir ? segments.length + 1 : segments.length
  return Array.from({ length: Math.max(1, count) }, (_, index) => ({
    dir: segments.slice(0, index).join('/'),
    selected: segments[index] ?? null,
  }))
}

/** The file a path names, or null when it names a directory. */
const fileOf = (path: string): string | null =>
  path === '' || path.endsWith('/') ? null : path

/**
 * A worktree's files: where the browser is standing, and the file it has open.
 *
 * Inert while `enabled` is false, for the reason `useGitState` is: the hook is
 * called for every tile whether or not its panel is open, and without this
 * every tile on screen would read directories to fill a panel nobody asked for.
 */
export const useFilesState = (
  worktreeId: string,
  revision: string,
  enabled: boolean,
  path: string,
  onOpen: (path: string) => void,
): FilesState => {
  const [listings, setListings] = useState<Record<string, FileEntry[]>>({})
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({})
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
   * undoing back to the file's own text clears it for nothing, and so does
   * typing the same edit the agent just made.
   */
  const draftRef = useRef<string | null>(null)
  /** The rev of what `file` holds; the stale-write guard's half of the bargain. */
  const revRef = useRef<string | null>(null)
  /** The rev the server reported when it refused a save. */
  const freshRevRef = useRef<string | null>(null)

  const filePath = fileOf(path)

  /*
   * Fetches follow the path at a short delay; the columns themselves do not.
   * See OPEN_DEBOUNCE_MS.
   */
  const [settled, setSettled] = useState(path)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(path), OPEN_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [path])

  const settledDirs = columnsFor(settled)
    .map((column) => column.dir)
    .join('\n')

  // Only while the panel is on screen; see TREE_POLL_MS.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setTreeNonce((n) => n + 1), TREE_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled])

  /*
   * Read every directory the browser is currently showing.
   *
   * Results are compared before they are stored, so a directory that has not
   * changed re-renders nothing and cannot throw away the column's scroll
   * position -- the same discipline the git panel keeps with its patch.
   */
  useEffect(() => {
    if (!enabled) return
    let live = true
    const dirs = settledDirs === '' ? [''] : settledDirs.split('\n')
    for (const dir of dirs) {
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
          setDirErrors((previous) => {
            if (previous[dir] === undefined) return previous
            const next = { ...previous }
            delete next[dir]
            return next
          })
        })
        .catch((err: unknown) => {
          if (!live) return
          /*
           * A stored path can name a directory that is gone -- the agent
           * deleted it, or this is a reload onto a different branch. Fall back
           * to the deepest parent that does exist rather than showing an error
           * about a path nobody chose.
           */
          if (err instanceof ApiError && err.status === 404) {
            onOpen(dir === '' ? '' : `${parentOf(dir)}/`)
            return
          }
          setDirErrors((previous) => ({
            ...previous,
            [dir]: err instanceof Error ? err.message : String(err),
          }))
        })
    }
    return () => {
      live = false
    }
  }, [worktreeId, settledDirs, revision, treeNonce, enabled, onOpen])

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
          // The file is gone: drop back to the directory it was in.
          if (err instanceof ApiError && err.status === 404) {
            onOpen(`${parentOf(filePath)}/`)
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
   * What is on disk, read by `edited` below without being a dependency of it:
   * a new callback identity on every poll would rebuild the editor's listener
   * for nothing.
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

  const columns: DirColumn[] = columnsFor(path).map((column) => ({
    dir: column.dir,
    selected: column.selected,
    entries: listings[column.dir] ?? null,
    error: dirErrors[column.dir] ?? null,
  }))

  return {
    path,
    columns,
    file,
    refusal,
    dirty,
    saving,
    conflict,
    error,
    open: onOpen,
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
  const file = fileOf(state.path)
  const shortened = file === null ? null : file.split('/').slice(-2).join('/')
  return (
    <div className="files__bar">
      {shortened !== null && (
        <span className="files__path" title={file ?? undefined}>
          {shortened}
        </span>
      )}
      {state.dirty && <span className="files__unsaved">Unsaved</span>}
      {file !== null && (
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

interface FilesColumnProps {
  column: DirColumn
  onPick: (entry: FileEntry) => void
  /** Focus the selected row when this changes; set only by the keyboard. */
  focus: number | null
}

const FilesColumn = ({ column, onPick, focus }: FilesColumnProps): React.ReactElement => {
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  // Bring the selection into its own column without touching the strip's
  // sideways offset. `nearest` makes this a no-op when it is already visible.
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [column.selected, column.entries])

  useLayoutEffect(() => {
    if (focus !== null) selectedRef.current?.focus()
  }, [focus])

  if (column.error !== null) {
    return (
      <div className="files__col">
        <p className="files__note">{column.error}</p>
      </div>
    )
  }
  return (
    <div className="files__col">
      {/* Nothing at all while it is being read: a local directory listing takes
          a few milliseconds, and a word that flashes for one frame is worse
          than empty space. */}
      {column.entries !== null && column.entries.length === 0 && (
        <p className="files__note">empty</p>
      )}
      {column.entries?.map((entry) => {
        const on = entry.name === column.selected
        return (
          <button
            key={entry.name}
            ref={on ? selectedRef : null}
            className={[
              'files__row',
              on ? 'files__row--on' : '',
              entry.changed === true ? 'files__row--changed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            // Roving tabindex: Tab reaches the strip once, rather than walking
            // through two hundred files to get past it.
            tabIndex={on ? 0 : -1}
            onClick={() => onPick(entry)}
            title={entry.name}
          >
            <span className="files__name">{entry.name}</span>
            {entry.kind === 'dir' && (
              <span className="files__into" aria-hidden="true">
                ›
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export interface FilesPaneProps {
  state: FilesState
  /** Whether the tile is close enough to the scrollport to build an editor. */
  near: boolean
}

/**
 * A worktree's files: a strip of directory columns, then the file itself.
 *
 * Columns rather than an indented tree because a pane is eighty characters wide
 * and an indented tree spends that width on depth instead of on names. It is
 * Finder's arrangement with the preview column turned ninety degrees: the strip
 * runs sideways across the top, and the file gets everything below it.
 */
export const FilesPane = ({ state, near }: FilesPaneProps): React.ReactElement => {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const shownRef = useRef(0)
  const [keyFocus, setKeyFocus] = useState<number | null>(null)
  const { columns, open } = state
  /*
   * Where the keyboard is: the deepest column carrying a selection. After a
   * step left that is the parent, after a step right the new child column, and
   * after a step down the same column -- one rule for all three.
   */
  let focused = columns.length - 1
  while (focused > 0 && columns[focused]?.selected === null) focused--

  /*
   * Reveal a newly opened column, and only then. A poll that re-renders must
   * not drag the strip back to its end while you are reading a parent column.
   */
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    if (columns.length > shownRef.current) strip.scrollLeft = strip.scrollWidth
    shownRef.current = columns.length
  }, [columns.length])

  const pick = (column: DirColumn, entry: FileEntry): void => {
    const full = joinPath(column.dir, entry.name)
    open(entry.kind === 'dir' ? `${full}/` : full)
  }

  /*
   * Finder's keys, and they mean exactly what a click means -- moving the
   * selection *is* opening, so arrowing over a directory opens its column and
   * arrowing over a file loads it. There is no second code path.
   *
   * On the strip rather than on the document: with a dozen tiles awake, a
   * document-level arrow handler has no idea whose files it is moving.
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    /*
     * Any modifier and it is not ours -- which is what leaves Cmd+Left and
     * Cmd+Right to the row's worktree stepping while the keyboard is in a
     * column. A file row is not a text field, so that handler is right to take
     * them there.
     */
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const { key } = event
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' && key !== 'ArrowRight') {
      return
    }
    // The deepest column carrying a selection is the one the keyboard is in.
    const at = focused
    const column = columns[at]
    if (!column) return

    if (key === 'ArrowLeft') {
      if (at === 0) return
      event.preventDefault()
      setKeyFocus((n) => (n ?? 0) + 1)
      // The parent, with the directory we came through still chosen in it.
      open(`${column.dir}/`)
      return
    }

    const entries = column.entries
    if (entries === null || entries.length === 0) return
    const index = entries.findIndex((entry) => entry.name === column.selected)

    if (key === 'ArrowRight') {
      const entry = entries[index]
      if (!entry) return
      // Into a directory; out to the file itself when there is nowhere deeper.
      if (entry.kind !== 'dir') return
      event.preventDefault()
      setKeyFocus((n) => (n ?? 0) + 1)
      const first = state.columns[at + 1]?.entries?.[0]
      const dir = joinPath(column.dir, entry.name)
      open(first === undefined ? `${dir}/` : joinPath(dir, first.name) + (first.kind === 'dir' ? '/' : ''))
      return
    }

    // Clamped rather than wrapping: wrapping in a long list loses your place.
    const next = entries[Math.min(Math.max(index + (key === 'ArrowDown' ? 1 : -1), 0), entries.length - 1)]
    if (!next || next.name === column.selected) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    setKeyFocus((n) => (n ?? 0) + 1)
    pick(column, next)
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
         * Cmd+S with the keyboard in a column would otherwise open the
         * browser's Save Page dialog. The editor's own binding has already
         * prevented it when the keyboard is in there.
         */
        if (event.defaultPrevented) return
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault()
          state.save()
        }
      }}
    >
      <div className="files__strip" ref={stripRef} onKeyDown={onKeyDown}>
        {columns.map((column, index) => (
          <FilesColumn
            key={column.dir}
            column={column}
            onPick={(entry) => pick(column, entry)}
            focus={index === focused ? keyFocus : null}
          />
        ))}
      </div>

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

      <div className="files__file">
        {state.refusal !== null ? (
          <p className="files__note">{state.refusal}</p>
        ) : state.file === null ? (
          <p className="files__note">Pick a file to read it here.</p>
        ) : (
          mountEditor && (
            <div className="files__editor">
              <Suspense fallback={null}>
                <CodeEditor
                  file={state.file}
                  draft={state.draft}
                  onChange={state.edited}
                  onSave={state.save}
                />
              </Suspense>
            </div>
          )
        )}
      </div>
    </div>
  )
}
