import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileEntry, FileHit, FilesMode } from '@ide-n-dream/shared'
import {
  ChangesList,
  CommitsList,
  Diff,
  INDENT,
  changeRows,
  matchingChanges,
  matchingCommits,
  type ChangesState,
} from './ChangesPane.js'
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
 * The same reasoning as the changes poll, which `POLL_MS` in `ChangesPane` sets
 * out:
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
  /** Whose files these are, so the pane can search them. */
  worktreeId: string
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
  expandDir: (dir: string) => void
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

/** A search hit, or a directory on the way to one. */
interface HitRow {
  path: string
  name: string
  kind: 'dir' | 'file'
  depth: number
  /** Whether this row matched, as opposed to being a directory above one. */
  hit: boolean
  /** Directories: whether anything under it is shown here. */
  open: boolean
}

/**
 * Search hits, as a tree.
 *
 * A flat list of paths was two lines per hit -- the name, and the directory
 * under it in small type -- which is a second way of drawing the same thing the
 * tree already draws, and it read as a different panel rather than the same one
 * filtered. So the directories between the hits are drawn back in: every
 * ancestor of every hit is a row, the hits sit under them, and the shape is the
 * one the reader already knows.
 *
 * Ordered exactly as the tree is, by walking the segments: directories before
 * files at each level, then by name, and a parent always above its children.
 */
const hitRows = (hits: FileHit[]): HitRow[] => {
  const kinds = new Map<string, 'dir' | 'file'>()
  for (const hit of hits) {
    for (const dir of ancestorsOf(hit.path)) kinds.set(dir, 'dir')
    // A directory that is also an ancestor stays a directory either way.
    if (!kinds.has(hit.path)) kinds.set(hit.path, hit.kind)
  }
  const matched = new Set(hits.map((hit) => hit.path))
  const paths = [...kinds.keys()]
  const isDir = (segments: string[], upto: number): boolean =>
    segments.length > upto + 1 || kinds.get(segments.slice(0, upto + 1).join('/')) === 'dir'
  paths.sort((a, b) => {
    const left = a.split('/')
    const right = b.split('/')
    const shared = Math.min(left.length, right.length)
    for (let i = 0; i < shared; i++) {
      if (left[i] === right[i]) continue
      const leftDir = isDir(left, i)
      if (leftDir !== isDir(right, i)) return leftDir ? -1 : 1
      return (left[i] ?? '').localeCompare(right[i] ?? '')
    }
    // One is inside the other: the parent comes first.
    return left.length - right.length
  })
  return paths.map((path) => {
    const segments = path.split('/')
    const kind = kinds.get(path) ?? 'file'
    return {
      path,
      name: segments[segments.length - 1] ?? path,
      kind,
      depth: segments.length - 1,
      hit: matched.has(path),
      open: kind === 'dir' && paths.some((other) => other.startsWith(`${path}/`)),
    }
  })
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
 * Inert while `enabled` is false, for the reason `useChangesState` is: the hook is
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
  /** Open a directory and everything above it, without touching the rest. */
  onExpandDir: (dir: string) => void
}): FilesState => {
  const { worktreeId, revision, enabled, path, expanded, onOpen, onToggleDir, onExpandDir } = opts

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
  /** The file on screen right now, for callbacks that resolve later. */
  const pathRef = useRef<string | null>(filePath)
  pathRef.current = filePath
  // The root is always read; everything else only once it has been expanded.
  const dirsKey = ['', ...expanded].join('\n')
  /**
   * What is expanded right now, for the 404 path below.
   *
   * Collapsing a directory changes `dirsKey` and so tears that request down
   * before its handler runs, which is what keeps the toggle there honest today.
   * This makes it not depend on that: a toggle used to mean "collapse" is one
   * refactor away from re-expanding the directory you just closed.
   */
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

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
   * -- the same discipline the changes hook keeps with its patch.
   */
  useEffect(() => {
    if (!enabled) return
    let live = true
    for (const dir of dirsKey.split('\n')) {
      void api
        .tree(worktreeId, dir)
        .then((listing) => {
          if (!live) return
          setError(null)
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
            if (expandedRef.current.includes(dir)) onToggleDir(dir)
            return
          }
          // The root failing is a real error -- and it must not also leave the
          // tree claiming to be loading for the rest of the session, since
          // `loading` is "the root listing is missing" and nothing else ever
          // fills it in.
          if (dir === '') setListings((previous) => ({ ...previous, '': previous[''] ?? [] }))
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
          // A read that worked clears whatever the last failure said. Only the
          // save path used to do this, so one transient 404 -- an agent moving
          // a file under you -- left the red notice up for the session.
          setError(null)
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
      const saved = filePath
      setSaving(true)
      void api
        .writeFile(worktreeId, { path: filePath, text, ifRev })
        .then((result) => {
          /*
           * Only if this is still the file on screen.
           *
           * A save is a round trip, and clicking another file during it used to
           * end with A's text and A's rev installed under B's path: the poll
           * that would repair it is gated on there being no draft, and typing
           * one character created one. Saving then sent B's path with A's text
           * and A's rev, and the conflict dialog's Overwrite wrote A into B.
           */
          if (saved !== pathRef.current) return
          revRef.current = result.rev
          freshRevRef.current = null
          draftRef.current = null
          setDirty(false)
          setConflict(false)
          setError(null)
          // The editor already holds this text, so the follow-up produces no
          // edit and the cursor does not move.
          setFile({ path: result.path, text })
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
    worktreeId,
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
    expandDir: onExpandDir,
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
 * What it says depends on the mode -- where you are in Files, what the commits
 * are measured against in the other two -- but **Save is shown in every mode
 * whenever there are unsaved edits.** The buffer lives in the hook, which stays
 * mounted across a mode switch, so switching to Changes with an unsaved edit
 * would otherwise take away every way to save it while quietly keeping it.
 */
export const FilesBar = ({
  mode,
  files,
  changes,
  openFiles,
  onCloseFile,
  onCollapse,
}: {
  mode: FilesMode
  files: FilesState
  changes: ChangesState
  /** The tabs, in the order they were opened. Files mode only. */
  openFiles: string[]
  onCloseFile: (path: string) => void
  /** Put the content pane away in Changes and Commits, where there are no tabs. */
  onCollapse: () => void
}): React.ReactElement => {
  const open = files.path === '' ? null : files.path
  const base = changes.changes?.base ?? null
  const labels = fileTabLabels(openFiles)
  // In Changes it is a file, in Commits a commit, but the button does the one
  // thing either way, so there is one of it.
  const collapsible = mode === 'commits' ? changes.commit !== null : open !== null
  return (
    <div className="files__bar">
      {mode === 'files' && openFiles.length > 0 && (
        <div className="files__tabs">
          {openFiles.map((path, index) => (
            <span
              key={path}
              className={path === open ? 'termtab termtab--active' : 'termtab'}
            >
              <button className="termtab__pick" onClick={() => files.open(path)} title={path}>
                {labels[index]}
              </button>
              <button
                className="termtab__close"
                onClick={() => onCloseFile(path)}
                title={`Close ${labels[index]}`}
                aria-label={`Close ${path}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      {mode !== 'files' && base !== null && (
        <span className="files__base" title={`Commits are measured against ${base}`}>
          vs {base}
        </span>
      )}
      {mode !== 'files' && (changes.changes?.behind ?? 0) > 0 && (
        <span
          className="files__base"
          title={`${base} has ${changes.changes?.behind} commits this branch does not`}
        >
          {changes.changes?.behind} behind
        </span>
      )}
      {files.dirty && <span className="files__unsaved">Unsaved</span>}
      {(files.dirty || (mode === 'files' && open !== null)) && (
        <button
          className="files__save"
          onClick={files.save}
          disabled={!files.dirty || files.saving}
          title="Save (⌘S)"
        >
          Save
        </button>
      )}
      {mode !== 'files' && (
        <button className="files__reload" onClick={changes.reload} title="Re-read git">
          Refresh
        </button>
      )}
      {mode !== 'files' && collapsible && (
        <button
          className="files__collapse"
          onClick={onCollapse}
          title="Collapse"
          aria-label="Collapse the patch"
        >
          &raquo;
        </button>
      )}
    </div>
  )
}

/**
 * What each open file's tab says.
 *
 * The basename, and the directory above it only when two open files share one:
 * a strip of `index.ts` twice tells you nothing, and a full path costs more of
 * the bar than the panel can spare. The same rule the terminal tabs use, for
 * the same reason.
 */
export const fileTabLabels = (paths: string[]): string[] => {
  const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
  const seen = new Map<string, number>()
  for (const path of paths) seen.set(base(path), (seen.get(base(path)) ?? 0) + 1)
  return paths.map((path) =>
    (seen.get(base(path)) ?? 0) > 1 ? path.split('/').slice(-2).join('/') : base(path),
  )
}

/** The switch, and what each face is called. Sentence case: see the CSS. */
const MODES: readonly { mode: FilesMode; label: string }[] = [
  { mode: 'files', label: 'Files' },
  { mode: 'changes', label: 'Changes' },
  { mode: 'commits', label: 'Commits' },
]

export interface FilesPaneProps {
  mode: FilesMode
  onMode: (mode: FilesMode) => void
  /**
   * The row stepped into this pane. Focus the open file's editor, or the
   * search box when there is no file to put a cursor in.
   */
  focus?: number | null
  files: FilesState
  changes: ChangesState
  /** The open files, which in Files mode are what the content pane is for. */
  openFiles: string[]
  /** Named in the commits heading, so it says what the commits are on. */
  branch: string | null
  /** Whether the tile is close enough to the scrollport to build an editor. */
  near: boolean
}

/**
 * A worktree's files: a list down the side, and what is selected beside it.
 *
 * Three faces of one panel rather than two panels, because they answer
 * questions about the same objects and used to keep two selections that drifted
 * apart -- you read a patch, wanted the whole file, and went to find it again
 * next door. Here that is one click on the file already in front of you.
 */
export const FilesPane = ({
  mode,
  onMode,
  files,
  changes,
  openFiles,
  branch,
  near,
  focus = null,
}: FilesPaneProps): React.ReactElement => {
  const treeRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  /*
   * The query is the panel's, not the worktree's: it is not persisted, for the
   * reason the diff selection was not -- a stale one restored on load would
   * hide the whole tree behind a search nobody remembers making. It survives a
   * mode switch, though, because it is one box whose meaning follows the mode.
   */
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<FileHit[]>([])
  const searching = query.trim() !== ''
  /*
   * One nonce per thing the row can hand the keyboard to. Both are separate
   * from the tree's own `keyFocus`, which says "you moved within the list"
   * rather than "the row sent you here".
   */
  const [editorFocus, setEditorFocus] = useState<number | null>(null)
  const [searchFocus, setSearchFocus] = useState<number | null>(null)
  const { rows, open, toggleDir, expandDir } = files
  const [cursor, setCursor] = useState<string | null>(null)
  const [keyFocus, setKeyFocus] = useState(0)

  const at = rows.findIndex((row) => row.path === (cursor ?? files.path))
  const here = at === -1 ? (rows.length > 0 ? 0 : -1) : at

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [files.path])

  useLayoutEffect(() => {
    if (keyFocus > 0) selectedRef.current?.focus()
  }, [keyFocus])

  /*
   * Files mode searches the worktree, not the rows on screen: the tree only
   * holds what you have expanded, so filtering it could never find the file you
   * have not walked to -- which is the only kind worth searching for. The other
   * two modes already hold their whole list, so they filter in place.
   */
  useEffect(() => {
    if (mode !== 'files' || !searching) {
      setFound([])
      return
    }
    let live = true
    void api
      .find(files.worktreeId, query)
      .then((res) => {
        if (live) setFound(res.hits)
      })
      .catch(() => {
        if (live) setFound([])
      })
    return () => {
      live = false
    }
  }, [files.worktreeId, mode, query, searching])

  /**
   * Whether there is a content pane at all.
   *
   * The panel is the tree by itself until you pick something, and that is a
   * layout fact as much as a rendering one -- the row reads the same three
   * answers to decide whether this tile is one pane wide or two. Keep the two
   * in step: a pane rendered here that the row did not budget for is a squeezed
   * editor, and the reverse is a column of empty ground.
   *
   * Files counts its tabs, because closing the last one is how you put the
   * editor away; the other two count their one selection, which is what
   * clicking it again or the collapse button clears.
   */
  const contentOpen =
    mode === 'files'
      ? openFiles.length > 0
      : mode === 'commits'
        ? changes.commit !== null
        : files.path !== ''

  /*
   * Arriving from the row: the file you are reading, or the box you would type
   * into when there is no file to put a cursor in.
   *
   * Decided from `files.path`, which is UI state and true this instant, rather
   * than from `files.file`, which is the answer to a fetch. Keying it on the
   * fetch would let the search box take the keyboard, you start typing, and the
   * editor mount a beat later and take it back mid-word.
   *
   * If the target refuses -- a binary file, or one too large to open -- focus
   * stays where it was. That is survivable because the stepper listens on the
   * document: a pane that fails to take the keyboard never traps you, and the
   * next Cmd+arrow still steps.
   */
  const wantsEditorRef = useRef(false)
  wantsEditorRef.current = mode === 'files' && contentOpen && files.path !== '' && !searching
  useEffect(() => {
    if (focus === null) return
    const bump = (n: number | null): number => (n ?? 0) + 1
    if (wantsEditorRef.current) setEditorFocus(bump)
    else setSearchFocus(bump)
  }, [focus])

  useEffect(() => {
    if (searchFocus === null) return
    searchRef.current?.focus()
    // Selected, so stepping back into a pane you already searched lets you
    // retype rather than clear first.
    searchRef.current?.select()
  }, [searchFocus])

  const pick = (row: TreeRow): void => {
    setCursor(row.path)
    if (row.kind === 'dir') toggleDir(row.path)
    else open(row.path)
  }

  /*
   * Finder's keys for the full tree: up and down through what is on screen,
   * right to open a directory, left to close it or step out to its parent.
   *
   * Moving is not opening, unlike a click. Arrowing past twenty files would
   * otherwise read and render twenty of them; Enter is the one that says you
   * meant it.
   *
   * On the tree rather than on the document: with a dozen tiles awake, a
   * document-level arrow handler has no idea whose files it is moving.
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
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
  const mountEditor = near || files.dirty
  const changed = changes.changes?.uncommitted ?? []
  const selectedChange = changed.find((c) => c.path === files.path)

  const sidebar = (): React.ReactElement => {
    if (mode === 'files' && searching) {
      /*
       * The same rows the tree draws, with the directories between the hits put
       * back in -- see `hitRows`. A file opens and leaves the search up, since
       * looking at one hit is rarely looking at the last. A directory does the
       * opposite: it drops the query and unfolds itself in the real tree, which
       * is the only thing you can have meant by picking a place rather than a
       * file.
       */
      const rowsFound = hitRows(found)
      return (
        <div className="files__tree" ref={treeRef}>
          {rowsFound.length === 0 && <p className="files__note">Nothing matches.</p>}
          {rowsFound.map((row) => (
            <button
              key={row.path}
              data-kind={row.kind}
              className={[
                'files__row',
                row.path === files.path ? 'files__row--on' : '',
                // A directory on the way to a hit is scenery; the hits are what
                // you asked for, and read at full strength.
                row.hit ? 'files__row--changed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: 6 + row.depth * INDENT }}
              onClick={() => {
                if (row.kind === 'file') {
                  open(row.path)
                  return
                }
                setQuery('')
                expandDir(row.path)
              }}
              title={row.path}
            >
              <span className="files__twist" aria-hidden="true">
                {row.kind === 'dir' ? (row.open ? '▾' : '▸') : ''}
              </span>
              <span className="files__name">{row.name}</span>
            </button>
          ))}
        </div>
      )
    }
    if (mode === 'files') {
      return (
        <div className="files__tree" ref={treeRef} onKeyDown={onKeyDown}>
          {!files.loading && rows.length === 0 && <p className="files__note">Nothing here.</p>}
          {rows.map((row, index) => {
            const isOpenFile = row.kind === 'file' && row.path === files.path
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
                tabIndex={onCursor ? 0 : -1}
                onClick={() => pick(row)}
                title={row.path}
              >
                <span className="files__twist" aria-hidden="true">
                  {row.kind === 'dir' ? (row.open ? '▾' : '▸') : ''}
                </span>
                <span className="files__name">{row.name}</span>
              </button>
            )
          })}
        </div>
      )
    }
    if (mode === 'commits') {
      const list = changes.changes
      return (
        <div className="files__tree" ref={treeRef}>
          {list !== null && (
            <div className="files__heading">
              {list.commitScope === 'ahead'
                ? `${list.commits.length === 1 ? '1 commit' : `${list.commits.length} commits`}${
                    branch === null ? '' : ` on ${branch}`
                  }`
                : 'Recent commits'}
            </div>
          )}
          {list !== null && (
            <CommitsList
              commits={matchingCommits(list.commits, query)}
              scope={list.commitScope}
              selected={changes.commit}
              onSelect={(hash) => changes.selectCommit(hash === changes.commit ? null : hash)}
            />
          )}
        </div>
      )
    }
    return (
      <div className="files__tree" ref={treeRef}>
        {changed.length === 0 && changes.changes !== null && (
          <p className="files__note">Nothing changed in this worktree.</p>
        )}
        {changed.length > 0 && matchingChanges(changed, query).length === 0 && (
          <p className="files__note">No change matches.</p>
        )}
        {/* Filtered before the fold, so the rows re-fold to a shorter tree. */}
        <ChangesList
          rows={changeRows(matchingChanges(changed, query))}
          path={files.path}
          onOpen={(path) => open(path === files.path ? '' : path)}
        />
      </div>
    )
  }

  const content = (): React.ReactElement => {
    if (mode === 'files') {
      if (files.refusal !== null) return <p className="files__note">{files.refusal}</p>
      if (files.file === null) return <></>
      return mountEditor ? (
        <Suspense fallback={null}>
          <CodeEditor
            file={files.file}
            draft={files.draft}
            onChange={files.edited}
            onSave={files.save}
            focus={editorFocus}
          />
        </Suspense>
      ) : (
        <></>
      )
    }
    if (mode === 'changes' && selectedChange === undefined) {
      /*
       * The path is the panel's, not this mode's, so it can name a file that is
       * not in the list -- one opened clean in Files mode, or one the agent
       * committed while you were reading it. Say so, and ask git nothing.
       */
      return <p className="files__note">No uncommitted changes to this file.</p>
    }
    if (changes.patch === null) return <></>
    // A commit touches any number of files and the hunks never say which.
    return <Diff patch={changes.patch} showFiles={mode === 'commits'} />
  }

  return (
    <div
      className="files"
      onKeyDown={(event) => {
        /*
         * Cmd+S with the keyboard anywhere but the editor would otherwise open
         * the browser's Save Page dialog. The editor's own binding has already
         * prevented it when the keyboard is in there.
         */
        if (event.defaultPrevented) return
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault()
          files.save()
        }
      }}
    >
      <div className="files__side">
        <div className="files__modes">
          {MODES.map(({ mode: name, label }) => (
            <button
              key={name}
              className={name === mode ? 'files__mode files__mode--on' : 'files__mode'}
              onClick={() => onMode(name)}
            >
              {label}
            </button>
          ))}
        </div>
        {(files.error ?? changes.error) !== null && (
          /*
           * In the column that is always here, not in the content pane, which
           * now comes and goes: a tree that failed to read has no content pane
           * to say so in. Above the list rather than below, so it does not
           * shift the find box at the sidebar's foot. The conflict notice stays
           * beside the file, since it can only happen while one is open.
           */
          <div className="files__notice">{files.error ?? changes.error}</div>
        )}
        {sidebar()}
        <div className="files__find">
          <input
            ref={searchRef}
            className="files__search"
            value={query}
            spellCheck={false}
            placeholder={mode === 'commits' ? 'Find a commit' : 'Find a file'}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              /*
               * Plain keys only. Cmd+arrow belongs to the row and is taken in
               * the capture phase before this ever sees it.
               */
              if (event.metaKey || event.ctrlKey || event.altKey) return
              if (event.key === 'Escape') {
                event.preventDefault()
                // Clear first; a second press gives the pane back its keyboard.
                if (query !== '') setQuery('')
                else searchRef.current?.blur()
                return
              }
              /*
               * Into the results, which are above the box: a single-line field
               * has no use for a vertical caret, so the key that points at the
               * list is free to mean this. Enter is the one that says you meant
               * the first hit -- the best match, not the nearest row -- which is
               * the same rule the tree keeps.
               */
              if (event.key === 'ArrowUp' || event.key === 'Enter') {
                const list = treeRef.current
                if (!list) return
                /*
                 * Enter means the first *file*: the results are a tree now, so
                 * the topmost row is usually a directory on the way to
                 * something, and picking one clears the search rather than
                 * opening anything.
                 */
                const target =
                  event.key === 'Enter'
                    ? (list.querySelector<HTMLButtonElement>('button[data-kind="file"]') ??
                      list.querySelector<HTMLButtonElement>('button'))
                    : list.querySelector<HTMLButtonElement>('button')
                if (!target) return
                event.preventDefault()
                if (event.key === 'Enter') target.click()
                else target.focus()
              }
            }}
          />
        </div>
      </div>

      {contentOpen && (
        <div className="files__file">
          {files.conflict && (
            <div className="files__notice">
              <span>This file changed on disk while you were editing it.</span>
              <span className="files__notice-actions">
                <button className="files__act" onClick={files.overwrite}>
                  Overwrite
                </button>
                <button className="files__act" onClick={files.revert}>
                  Discard my edits
                </button>
              </span>
            </div>
          )}

          {content()}
        </div>
      )}
    </div>
  )
}
