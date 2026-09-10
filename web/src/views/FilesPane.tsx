import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileEntry, FilesMode } from '@ide-n-dream/shared'
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
}: {
  mode: FilesMode
  files: FilesState
  changes: ChangesState
}): React.ReactElement => {
  const open = files.path === '' ? null : files.path
  const shortened = open === null ? null : open.split('/').slice(-2).join('/')
  const base = changes.changes?.base ?? null
  return (
    <div className="files__bar">
      {mode === 'files' && shortened !== null && (
        <span className="files__path" title={open ?? undefined}>
          {shortened}
        </span>
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
    </div>
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
  const [found, setFound] = useState<string[]>([])
  const searching = query.trim() !== ''
  /*
   * One nonce per thing the row can hand the keyboard to. Both are separate
   * from the tree's own `keyFocus`, which says "you moved within the list"
   * rather than "the row sent you here".
   */
  const [editorFocus, setEditorFocus] = useState<number | null>(null)
  const [searchFocus, setSearchFocus] = useState<number | null>(null)
  const { rows, open, toggleDir } = files
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
        if (live) setFound(res.paths)
      })
      .catch(() => {
        if (live) setFound([])
      })
    return () => {
      live = false
    }
  }, [files.worktreeId, mode, query, searching])

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
  wantsEditorRef.current = mode === 'files' && files.path !== '' && !searching
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
       * A flat list of paths, not a tree: these come from all over the worktree
       * and the directories between them are not what you asked about.
       */
      return (
        <div className="files__tree" ref={treeRef}>
          {found.length === 0 && <p className="files__note">No file matches.</p>}
          {found.map((path) => {
            const cut = path.lastIndexOf('/')
            return (
              <button
                key={path}
                className={path === files.path ? 'files__hit files__hit--on' : 'files__hit'}
                onClick={() => open(path)}
                title={path}
              >
                <span className="files__hit-name">{path.slice(cut + 1)}</span>
                {cut !== -1 && <span className="files__hit-dir">{path.slice(0, cut)}</span>}
              </button>
            )
          })}
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
              onSelect={changes.selectCommit}
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
        <ChangesList rows={changeRows(matchingChanges(changed, query))} path={files.path} onOpen={open} />
      </div>
    )
  }

  const content = (): React.ReactElement => {
    if (mode === 'files') {
      if (files.refusal !== null) return <p className="files__note">{files.refusal}</p>
      if (files.file === null) return <p className="files__note">Pick a file to read it here.</p>
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
    if (mode === 'changes' && files.path !== '' && selectedChange === undefined) {
      /*
       * The path is the panel's, not this mode's, so it can name a file that is
       * not in the list -- one opened clean in Files mode, or one the agent
       * committed while you were reading it. Say so, and ask git nothing.
       */
      return <p className="files__note">No uncommitted changes to this file.</p>
    }
    if (mode === 'changes' && files.path === '') {
      return <p className="files__note">Pick a changed file to read its diff.</p>
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
              // A single-line box has no use for a down-caret, so it is free to
              // mean "into the results".
              /*
               * Into the results. A single-line box has no use for a down
               * caret, so the key is free to mean this; Enter is the one that
               * says you meant the first hit, the same rule the tree keeps.
               */
              if (event.key === 'ArrowDown' || event.key === 'Enter') {
                const first = treeRef.current?.querySelector<HTMLButtonElement>('button')
                if (!first) return
                event.preventDefault()
                if (event.key === 'Enter') first.click()
                else first.focus()
              }
            }}
          />
        </div>
        {sidebar()}
      </div>

      <div className="files__file">
        {(files.error ?? changes.error) !== null && (
          <div className="files__notice">{files.error ?? changes.error}</div>
        )}

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
    </div>
  )
}
