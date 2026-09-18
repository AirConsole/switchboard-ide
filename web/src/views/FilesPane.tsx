import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mediaTypeOf, type FileEntry, type FileHit, type FilesMode } from '@switchboard/shared'
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
import { useListKeys } from '../components/useListKeys.js'
import type { EditorFile } from '../editor/CodeEditor.js'

/*
 * CodeMirror is fetched the first time a files panel actually shows a file.
 * A session that never opens one never downloads it, and `fallback={null}`
 * keeps the no-spinner rule -- the pane simply shows its ground until it lands.
 */
const CodeEditor = lazy(() => import('../editor/CodeEditor.js'))

/*
 * And so is the Markdown renderer, for the same reason and with the same
 * fallback: the parser is only wanted by a panel that is actually showing a
 * rendered `.md`, which most sessions never do.
 */
const Markdown = lazy(() => import('./Markdown.js'))

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

/**
 * A file the browser draws itself.
 *
 * The bytes are not here: `url` is what an `<img>` fetches, and it carries the
 * rev, so a file the agent rewrites is a new URL and the element repaints. The
 * size is worth carrying because a picture says nothing about how big it is.
 */
export interface MediaFile {
  path: string
  /** The media type the server named, e.g. `image/png`. */
  type: string
  url: string
  /** Bytes on disk. */
  size: number
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
  /**
   * The open file as something to look at rather than edit: an image.
   *
   * Never set at the same time as `file` -- a file is one or the other -- and
   * the pane picks between them the same way it picks between either and
   * `refusal`.
   */
  media: MediaFile | null
  /** Why there is no file to show: not text, not drawable, too large, gone. */
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
  const [media, setMedia] = useState<MediaFile | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [treeNonce, setTreeNonce] = useState(0)
  const [fileNonce, setFileNonce] = useState(0)

  /*
   * The unsaved buffer is in `drafts`, outside this component, and only a
   * boolean reaches state.
   *
   * If it were state, every keystroke would re-render the whole tile -- and the
   * tile holds two live terminals beside this pane. It also makes "dirty" mean
   * *the buffer differs from disk* rather than *something was typed*, so
   * undoing back to the file's own text clears it for nothing.
   */
  const key = draftKey(worktreeId, path)
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
        setMedia(null)
        setRefusal(null)
        revRef.current = null
      }
      return
    }
    let live = true
    const read = (): void => {
      if (drafts.has(key)) return
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
            /*
             * Not text, but the browser has a renderer for it: show it instead
             * of saying there is nothing to see. `media` on the answer is the
             * server saying so -- an extension it knows how to name -- and the
             * bytes come from `/raw`, keyed by the rev this poll just read, so
             * an image the agent regenerates repaints without anything here
             * having to notice.
             */
            const type = result.media
            if (type !== undefined) {
              const url = api.rawFileUrl(worktreeId, result.path, result.rev)
              setRefusal(null)
              setMedia((previous) =>
                previous !== null && previous.url === url ? previous : {
                  path: result.path,
                  type,
                  url,
                  size: result.size,
                },
              )
              return
            }
            setMedia(null)
            setRefusal('This is not a text file.')
            return
          }
          setMedia(null)
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

  /*
   * A different file shows whatever is being held for *it*.
   *
   * It used to throw the buffer away here, on the grounds that the old draft
   * belonged to the old file and there was nowhere sensible to put it. There is
   * now: `drafts` is keyed by file, so switching away and back returns what you
   * typed, and so does closing this panel and opening it again.
   */
  useEffect(() => {
    freshRevRef.current = null
    setDirty(drafts.has(draftKey(worktreeId, filePath ?? '')))
    setConflict(false)
  }, [worktreeId, filePath])

  /*
   * What is on disk, read by `edited` below without being a dependency of it: a
   * new callback identity on every poll would rebuild the editor's listener for
   * nothing.
   */
  const lastDiskRef = useRef<string | null>(null)
  lastDiskRef.current = file?.text ?? null

  const edited = useCallback(
    (text: string): void => {
      const clean = text === lastDiskRef.current
      if (clean) drafts.delete(key)
      else drafts.set(key, text)
      setDirty((was) => (was === !clean ? was : !clean))
    },
    [key],
  )

  const draft = useCallback((): string | null => drafts.get(key) ?? null, [key])

  const put = useCallback(
    (ifRev: string): void => {
      const text = drafts.get(key) ?? null
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
          drafts.delete(draftKey(worktreeId, saved))
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
    drafts.delete(key)
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
    media,
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

/** A size a person reads, for the line under a picture. */
const fileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A file the browser draws itself, fitted to the pane.
 *
 * Scaled down and never up: `max-width`/`max-height` at 100% with
 * `object-fit: contain` leaves a 16×16 favicon at 16×16 and brings a 4000px
 * screenshot down to the pane, which is the rule the reader would state --
 * blowing an icon up to fill a column would be inventing detail that is not in
 * the file.
 *
 * The line underneath is the part a picture cannot say: its real dimensions,
 * which is how you know whether what you are looking at is the whole of it, and
 * how big the file is. It is the interface talking, so it is in the interface's
 * own face and the dim grey the tree's notes use.
 */
const MediaView = ({ media }: { media: MediaFile }): React.ReactElement => {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  // A new file, or the same one rewritten: both arrive as a new URL, and both
  // mean the dimensions on screen belong to the picture that is going away.
  useEffect(() => {
    setNatural(null)
    setFailed(false)
  }, [media.url])

  return (
    <div className="files__media">
      {failed ? (
        /*
         * The extension said the browser could draw this and it could not:
         * a `.png` that is not one, or a truncated download. Said plainly,
         * because the alternative is the browser's own broken-image glyph,
         * which reads as the panel being broken.
         */
        <p className="files__note">This file could not be shown.</p>
      ) : (
        <img
          className="files__image"
          src={media.url}
          alt={media.path}
          onLoad={(event) =>
            setNatural({
              w: event.currentTarget.naturalWidth,
              h: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(true)}
        />
      )}
      <p className="files__media-note">
        {natural === null ? '' : `${natural.w} × ${natural.h} · `}
        {fileSize(media.size)}
      </p>
    </div>
  )
}

/**
 * Download: an arrow coming down into a tray, the shape every platform uses.
 *
 * A glyph and no word, unlike Save and Preview beside it. Those two are about
 * the file you are editing and are pressed often; this one leaves the IDE
 * entirely, and the bar is budgeted to the pixel -- see the comment on Save's
 * render order.
 */
const DownloadIcon = (): React.ReactElement => (
  <svg
    className="files__icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 2.6v6.6M5.4 6.6 8 9.2l2.6-2.6" />
    <path d="M2.8 11.4v1.2a1.3 1.3 0 0 0 1.3 1.3h7.8a1.3 1.3 0 0 0 1.3-1.3v-1.2" />
  </svg>
)

/**
 * Where the bytes of a download come from, and null when there are none yet.
 *
 * Three answers, because a file in this panel is one of three things:
 *
 * - **Text** is in the browser already, so it is handed over as a blob rather
 *   than asked for a second time -- and the blob holds **what is on screen**:
 *   the draft while there is one, the file on disk otherwise. That is the rule
 *   Preview keeps, and the alternative -- downloading what you can see is not
 *   what you get -- is the kind of surprise a download cannot be taken back
 *   from.
 * - An **image** is already a URL the server serves, so the link is that one.
 * - A file the panel **would not open at all** has nothing in the browser to
 *   hand over, so the server is asked for it: `?download=1`, which streams from
 *   disk and is therefore the one route the size cap has nothing to say about.
 *   That is the case this function was extracted for -- a file too large to
 *   show, or one with no text in it, was the one kind with no way out of the
 *   IDE at all, reported as a size and nothing else.
 *
 * It is also what the bar asks whether to draw the button, rather than
 * re-deriving the same three cases as a condition: two derivations of one fact
 * agree best when there is one of them.
 */
export const downloadSource = (files: {
  worktreeId: string
  path: string
  file: EditorFile | null
  media: MediaFile | null
  refusal: string | null
  dirty: boolean
  draft: () => string | null
}): { text: string } | { url: string } | null => {
  if (files.path === '') return null
  if (files.media !== null) return { url: files.media.url }
  if (files.refusal !== null) return { url: api.downloadFileUrl(files.worktreeId, files.path) }
  // Still being read. Without this the button would offer an empty file as the
  // file, which is a download that cannot be taken back.
  const text = (files.dirty ? files.draft() : null) ?? files.file?.text
  return text === undefined ? null : { text }
}

/** Hand a URL to the browser as a file to keep, named `name`. */
const handOver = (url: string, name: string): void => {
  const link = document.createElement('a')
  link.href = url
  /*
   * The name is the anchor's, not the response's: the route sends no filename
   * in its disposition header, which is what lets this one win -- and is one
   * less thing to have to escape correctly. See the `/raw` route.
   */
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
}

/** Hand the open file to the browser, from whichever of the three sources it has. */
const downloadOpenFile = (files: FilesState): void => {
  const source = downloadSource(files)
  if (source === null) return
  const name = files.path.slice(files.path.lastIndexOf('/') + 1)
  if ('url' in source) {
    handOver(source.url, name)
    return
  }
  const url = URL.createObjectURL(new Blob([source.text], { type: 'text/plain;charset=utf-8' }))
  handOver(url, name)
  // The object URL holds the blob alive until it is let go; the click has
  // already taken what it needs by the time this runs.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
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
  markdownPreview,
  onCloseFile,
  onCollapse,
  onMarkdownPreview,
}: {
  mode: FilesMode
  files: FilesState
  changes: ChangesState
  /** The tabs, in the order they were opened. Files mode only. */
  openFiles: string[]
  /** Whether Markdown opens rendered. One switch for the whole IDE. */
  markdownPreview: boolean
  onCloseFile: (path: string) => void
  /** Put the content pane away in Changes and Commits, where there are no tabs. */
  onCollapse: () => void
  onMarkdownPreview: (on: boolean) => void
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
      {/*
       * The file itself, out of the IDE -- the text as you see it, an image, or
       * a file this panel would not open, which is the one that has no other
       * way of reaching you. See `downloadSource`, which is also what decides
       * whether there is anything to offer.
       *
       * Next to Save because it is the other thing you do to the file you have
       * open, and after it for the reason Save is before Preview: the bar clips
       * from the end, and the control that can lose work stays longest.
       */}
      {mode === 'files' && open !== null && downloadSource(files) !== null && (
        <button
          className="files__download"
          onClick={() => downloadOpenFile(files)}
          title={`Download ${open.slice(open.lastIndexOf('/') + 1)}`}
          aria-label={`Download ${open.slice(open.lastIndexOf('/') + 1)}`}
        >
          <DownloadIcon />
        </button>
      )}
      {/*
       * Rendered or raw, and it is the reader's habit rather than this file's
       * state: the flip is remembered for every Markdown file in every
       * worktree. Decided from `files.path` and not from `files.file`, which
       * is the answer to a fetch -- keying it on that would pop the button
       * into the bar a beat after the tab it belongs to.
       *
       * After Save in the render order, which is what the bar clips by: with a
       * window too narrow for both, the one that can lose work stays.
       */}
      {mode === 'files' && open !== null && isMarkdown(open) && (
        <button
          className={markdownPreview ? 'files__preview files__preview--on' : 'files__preview'}
          onClick={() => onMarkdownPreview(!markdownPreview)}
          aria-pressed={markdownPreview}
          title={
            markdownPreview
              ? 'Show the Markdown source (remembered for every file)'
              : 'Show the Markdown rendered (remembered for every file)'
          }
        >
          Preview
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

/**
 * Whether a file is Markdown, and therefore has a rendered form to show.
 *
 * The extension and nothing else. The editor decides its grammar the same way
 * -- `LanguageDescription.matchFilename` -- so the two cannot disagree about
 * what a file is, and a file with no extension is not guessed at by either.
 */
export const isMarkdown = (path: string): boolean =>
  /\.(md|markdown)$/i.test(path.slice(path.lastIndexOf('/') + 1))

/** The switch, and what each face is called. Sentence case: see the CSS. */
const MODES: readonly { mode: FilesMode; label: string }[] = [
  { mode: 'files', label: 'Files' },
  { mode: 'changes', label: 'Changes' },
  { mode: 'commits', label: 'Commits' },
]

/*
 * Unsaved buffers, by worktree and file, held outside React.
 *
 * It was a ref inside the pane, and a ref inside a pane dies with the pane --
 * so closing the panel with an edit in flight threw the edit away, which is the
 * opposite of what this file says two hundred lines down: *an unsaved edit is
 * not something to unmount; off screen or not, it is the thing you are working
 * on.* The top bar's tabs close panels now, so what used to take a deliberate
 * second click on FILES became something you could do by navigating.
 *
 * A plain Map rather than state or context, because nothing may re-render when
 * it changes: the tile around this pane holds live terminals, and a keystroke
 * that re-rendered them would be paid for at every keystroke. Entries go on
 * save, on revert, and when the text matches disk again -- so an untouched
 * worktree holds nothing, and the map is as long as the list of files you have
 * edited and not saved.
 */
const drafts = new Map<string, string>()

/** Worktree and path together; a path alone collides across worktrees. */
const draftKey = (worktreeId: string, path: string): string => `${worktreeId}\u0000${path}`

/** Whether anything is being held for this file, for callers outside the pane. */
export const hasDraft = (worktreeId: string, path: string): boolean =>
  drafts.has(draftKey(worktreeId, path))

export interface FilesPaneProps {
  /**
   * Whether this panel has something open.
   *
   * The row's answer, not this pane's. It used to be worked out in both places
   * from the same state, each with a comment saying the two must agree -- and
   * in Commits they could not, because the row read the stored hash while this
   * read `useChangesState`, whose stale check clears a selection an amend has
   * invalidated. Two derivations of one fact agree best when there is one.
   */
  contentOpen: boolean
  /**
   * Whether the tree may sit beside the file -- the row's answer, from this
   * pane's width. False means one at a time: the file, or the list.
   */
  roomForTree: boolean
  /** With no room for both, show the list rather than the file. */
  showList: boolean
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
  /** Whether a Markdown file shows rendered rather than as its source. */
  markdownPreview: boolean
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
  contentOpen,
  roomForTree,
  showList,
  onMode,
  files,
  changes,
  openFiles,
  markdownPreview,
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
  /*
   * The last editor request that has been *delivered*, so a request is handed
   * over once and not again.
   *
   * The editor and the rendered page both act on the nonce when they mount, which
   * is deliberate -- they load lazily, and arriving at a panel can land before
   * either exists. But the nonce stayed set after it had done its job, so every
   * later mount acted on it again: measured, clicking `b.txt` in the tree while
   * `README.md` was showing as a page swapped the page for an editor, and the new
   * editor took the keyboard from the row you had just clicked. The arrows then
   * moved a caret in the file, and the tree looked as though it had no keys at
   * all.
   *
   * Delivered means the keyboard is in the file, or the person has since put it
   * somewhere else in this panel -- which is also what covers a file that
   * refuses focus, so its request cannot fire later on another file's mount.
   */
  const fileRef = useRef<HTMLDivElement | null>(null)
  const [editorFocusDone, setEditorFocusDone] = useState<number | null>(null)
  const editorFocusNow = editorFocus !== editorFocusDone ? editorFocus : null
  useEffect(() => {
    if (editorFocusNow === null) return
    if (fileRef.current?.contains(document.activeElement)) setEditorFocusDone(editorFocusNow)
  })
  const settleEditorFocus = (): void => setEditorFocusDone(editorFocus)
  const { rows, open, toggleDir, expandDir } = files
  const [cursor, setCursor] = useState<string | null>(null)
  const [keyFocus, setKeyFocus] = useState(0)

  const at = rows.findIndex((row) => row.path === (cursor ?? files.path))
  const here = at === -1 ? (rows.length > 0 ? 0 : -1) : at

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [files.path])

  /*
   * A request for the tree that arrived before its row did -- the panel opening
   * onto a picture reads the tree afresh, and the row the keyboard is meant for
   * is not drawn yet. Kept until it is.
   */
  const treeFocusPending = useRef(false)
  useLayoutEffect(() => {
    if (keyFocus === 0) return
    if (selectedRef.current) selectedRef.current.focus()
    else treeFocusPending.current = true
    // Moving in the list is putting the keyboard somewhere: any request for
    // the file still waiting is answered, and must not fire later.
    setEditorFocusDone(editorFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyFocus])
  useLayoutEffect(() => {
    if (!treeFocusPending.current || !selectedRef.current) return
    treeFocusPending.current = false
    selectedRef.current.focus()
  })

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
  /*
   * With no room for both, the panel is one thing at a time.
   *
   * The file is what you opened the panel for and the tree is a list of names,
   * so the file has the pane and the tree steps aside -- `.files__file` asks
   * for 80 columns and the stylesheet used to let the *editor* give them up,
   * which on a phone left the code with a fraction of the screen. FILES brings
   * the list back (`showList`), and opening something from it hands the pane
   * back to the file.
   */
  const sideShown = roomForTree || !contentOpen || showList
  const fileShown = contentOpen && (roomForTree || !showList)

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
  /*
   * The editor, or the search box under the tree -- and where there is no tree
   * there is no box, so the file takes the keyboard whatever the mode. Without
   * that last clause, arriving at a pane too narrow for both aimed focus at an
   * input that is not rendered and left it on the document.
   */
  wantsEditorRef.current =
    !sideShown || (mode === 'files' && contentOpen && files.path !== '' && !searching)
  /*
   * Unless what is open is only to be looked at. A picture, or a Markdown file
   * shown rendered, has nothing to type into, and handing it the keyboard took
   * the keyboard off the one thing in the panel that does something with keys:
   * the tree. So arriving at one lands on its row instead, where ↑ and ↓ go on
   * to the next file -- and where the tree is not drawn, on nothing at all.
   *
   * Decided from the path, like the rest of this, and not from what the read
   * answered: `mediaTypeOf` is the server's own table, in shared/, so the
   * answer is known before the file is.
   */
  const viewOnly = (path: string): boolean =>
    path !== '' && (mediaTypeOf(path) !== undefined || (markdownPreview && isMarkdown(path)))
  const arrivalRef = useRef<'editor' | 'tree' | 'search' | 'none'>('search')
  arrivalRef.current = !wantsEditorRef.current
    ? 'search'
    : !viewOnly(files.path)
      ? 'editor'
      : sideShown
        ? 'tree'
        : 'none'
  useEffect(() => {
    if (focus === null) return
    const bump = (n: number | null): number => (n ?? 0) + 1
    switch (arrivalRef.current) {
      case 'editor':
        setEditorFocus(bump)
        return
      case 'search':
        setSearchFocus(bump)
        return
      case 'tree':
        setCursor(files.path)
        setKeyFocus((n) => n + 1)
        return
      case 'none':
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    settleEditorFocus()
    if (row.kind === 'dir') toggleDir(row.path)
    else open(row.path)
  }

  /*
   * Into the file, from the tree: open it if it is not already, and hand the
   * keyboard to it. Escape in the file comes back (see `backToList`).
   */
  const enterFile = (row: TreeRow): void => {
    setCursor(row.path)
    if (row.path !== files.path) open(row.path)
    // Nothing to go into: it opens, and the keyboard stays on its row.
    if (viewOnly(row.path)) setKeyFocus((n) => n + 1)
    else setEditorFocus((n) => (n ?? 0) + 1)
  }

  /*
   * Out of the file and onto its row in the list, which is where → or Enter
   * came from. The tree keeps its own cursor, so in Files mode the cursor is
   * moved rather than the focus alone -- a focus that disagreed with it would
   * make the next arrow step from somewhere else.
   */
  const backToList = (): void => {
    if (!sideShown) return
    if (mode === 'files' && !searching) {
      if (files.path !== '') setCursor(files.path)
      setKeyFocus((n) => n + 1)
      return
    }
    const list = treeRef.current
    list
      ?.querySelector<HTMLElement>('.files__row--on, .files__commit--on')
      ?.focus()
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
  /*
   * ← and → step between Files, Changes and Commits.
   *
   * From a list the keyboard goes with you, into the list the new mode shows --
   * onto its selected row, or its first -- so walking sideways and then down is
   * one motion. The list is often not there yet (Changes and Commits are read
   * when their mode opens), so the active tab holds the keyboard until it is,
   * and the list takes it over only if nothing else has since. From the tabs
   * themselves the keyboard stays on the tabs, the way a tab row behaves.
   */
  const modesRef = useRef<HTMLDivElement | null>(null)
  /** Where the keyboard goes once the new mode is on screen. */
  const follow = useRef<'none' | 'list' | 'tabs'>('none')
  const activeTab = (): HTMLElement | null =>
    modesRef.current?.querySelector<HTMLElement>('.files__mode--on') ?? null
  const listTarget = (): HTMLElement | null => {
    const list = treeRef.current
    return (
      list?.querySelector<HTMLElement>('.files__row--on, .files__commit--on') ??
      list?.querySelector<HTMLElement>('button.files__row, button.files__commit') ??
      null
    )
  }
  const intoList = (): void => {
    if (mode === 'files' && !searching) {
      setKeyFocus((n) => n + 1)
      return
    }
    listTarget()?.focus()
  }
  const switchMode = (step: 1 | -1, keyboard: 'list' | 'tabs'): void => {
    const at = MODES.findIndex((m) => m.mode === mode)
    const next = MODES[at + step]
    if (next === undefined) return
    follow.current = keyboard
    onMode(next.mode)
  }
  useLayoutEffect(() => {
    // The tab first either way, so the keyboard is never left on a list that
    // just went, or on the tab that stopped being the active one.
    if (follow.current === 'none') return
    activeTab()?.focus()
    if (follow.current === 'tabs') follow.current = 'none'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  useLayoutEffect(() => {
    if (follow.current !== 'list') return
    // Somebody put the keyboard somewhere else in the meantime: leave it.
    if (document.activeElement !== activeTab()) {
      follow.current = 'none'
      return
    }
    if (mode === 'files' && !searching) {
      follow.current = 'none'
      setKeyFocus((n) => n + 1)
      return
    }
    const target = listTarget()
    if (target === null) return
    follow.current = 'none'
    target.focus()
  })

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
        // Off the top of the list is the tab row above it.
        if (here <= 0) activeTab()?.focus()
        else step(here - 1)
        return
      case 'ArrowRight':
        if (!row) return
        event.preventDefault()
        if (row.kind === 'file') {
          // A file has nothing to unfold, so → goes on to the next tab, as it
          // does in the flat lists. Enter on the open file goes into it.
          switchMode(1, 'list')
        } else if (!row.open) {
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
        /*
         * Enter opens a file; Enter on the file that is already open goes into
         * it -- the editor, or nowhere for a picture or a rendered page (see
         * `enterFile`). Escape comes back.
         */
        if (event.key === 'Enter' && row.kind === 'file' && row.path === files.path && contentOpen) {
          enterFile(row)
          return
        }
        setKeyFocus((n) => n + 1)
        pick(row)
        return
      default:
    }
  }

  /*
   * The other three lists walk with the arrows too, and they get the pane's
   * own hook rather than the handler above.
   *
   * What the tree has that they do not is folding: left and right open and
   * close a directory and step out to its parent, and moving the *cursor* is
   * not opening, so its walk runs through state that the flat lists have no
   * equivalent of. A hit, a change and a commit are each one row that does one
   * thing, so focus is the whole of the selection there, and Enter is the
   * browser's own on a button -- which is `useListKeys` exactly.
   *
   * Three of the four containers looked walkable and were not: they draw the
   * same `.files__row` markup as the tree, and only the tree carried keys.
   */
  useListKeys(treeRef, {
    rows: 'button.files__row, button.files__commit',
    enabled: mode !== 'files' || searching,
  })

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
                onClick={() => {
                  pick(row)
                  /*
                   * The keyboard stays on the row you clicked, so the arrows
                   * go on from there. Said outright rather than left to the
                   * click, because Safari does not focus a button on a click.
                   */
                  setKeyFocus((n) => n + 1)
                }}
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
      /*
       * A file to look at rather than edit. Behind `near` like the editor is:
       * a tile off the side of the row should no more fetch a megabyte of
       * image than it should mount CodeMirror.
       */
      if (files.media !== null) return near ? <MediaView media={files.media} /> : <></>
      if (files.refusal !== null) return <p className="files__note">{files.refusal}</p>
      if (files.file === null) return <></>
      if (markdownPreview && isMarkdown(files.file.path)) {
        /*
         * The buffer, when there is one, and the file otherwise.
         *
         * Reading the draft here does not make this a controlled editor -- the
         * editor is not mounted -- and it is the honest answer to flipping to
         * Preview with an edit in hand: what is rendered is what you wrote.
         * `dirty` is state, so this re-renders when a draft appears or goes,
         * and nothing can be typed into a rendered page in between.
         */
        const text = (files.dirty ? files.draft() : null) ?? files.file.text
        return mountEditor ? (
          <Suspense fallback={null}>
            <Markdown
              text={text}
              path={files.file.path}
              worktreeId={files.worktreeId}
              onOpen={files.open}
              focus={editorFocusNow}
            />
          </Suspense>
        ) : (
          <></>
        )
      }
      return mountEditor ? (
        <Suspense fallback={null}>
          <CodeEditor
            file={files.file}
            draft={files.draft}
            onChange={files.edited}
            onSave={files.save}
            focus={editorFocusNow}
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
    /*
     * A commit touches any number of files and the hunks never say which.
     *
     * The scroller is the panel's, like `.files__cm` and `.files__media`: a
     * patch is as long as it is, and every other thing this slot holds brings
     * its own -- CodeMirror's, and `.md`'s -- which is how this one came to have
     * none. See `.files__diff`.
     */
    return (
      <div className="files__diff">
        <Diff patch={changes.patch} showFiles={mode === 'commits'} />
      </div>
    )
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
      {sideShown && (
      <div
        className="files__side"
        onKeyDown={(event) => {
          /*
           * The flat lists -- hits, Changes, Commits -- have no use for ← and →
           * (`useListKeys` takes them so the row does not scroll), so here they
           * are the tab row's. The tree answers them itself: it folds.
           */
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          const target = event.target as HTMLElement
          if (!treeRef.current?.contains(target)) return
          if (mode === 'files' && !searching) return
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            switchMode(event.key === 'ArrowRight' ? 1 : -1, 'list')
            return
          }
          // Off the top of the list is the tab row, as it is from the tree.
          if (event.key === 'ArrowUp' && target === treeRef.current.querySelector('button')) {
            event.preventDefault()
            activeTab()?.focus()
          }
        }}
      >
        <div
          className="files__modes"
          ref={modesRef}
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              // Taken at the ends too, or the browser scrolls the row.
              event.preventDefault()
              switchMode(event.key === 'ArrowRight' ? 1 : -1, 'tabs')
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              intoList()
            }
          }}
        >
          {MODES.map(({ mode: name, label }) => (
            <button
              key={name}
              className={name === mode ? 'files__mode files__mode--on' : 'files__mode'}
              tabIndex={name === mode ? 0 : -1}
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
      )}

      {fileShown && (
        <div
          className="files__file"
          ref={fileRef}
          onKeyDown={(event) => {
            /*
             * Escape leaves the file for its row in the list. Only if nothing
             * in the file used it first -- CodeMirror spends an Escape on
             * collapsing a selection, and says so by preventing it -- so a
             * selection is dropped first and the second press leaves.
             */
            if (event.key !== 'Escape' || event.defaultPrevented) return
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
            event.preventDefault()
            backToList()
          }}
        >
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
