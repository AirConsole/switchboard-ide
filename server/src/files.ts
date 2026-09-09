import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import type { BigIntStats, Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  FileContent,
  FileEntry,
  FileListing,
  FileRev,
  FileSaved,
  FileUnchanged,
} from '@ide-n-dream/shared'
import { config } from './config.js'
import { HttpError } from './http-error.js'
import { parseStatus } from './git/changes.js'

const exec = promisify(execFile)

/**
 * Most entries one directory will ever report.
 *
 * Cheap insurance rather than a real limit: the ignore rules are what remove
 * `node_modules`, and past them a directory of this size is pathological. But
 * one DOM node per row stops being free somewhere around here, and a browser
 * tab locking up is a worse answer than a truncated column.
 */
const MAX_ENTRIES = 5000

/** Bytes of a file inspected for the NUL that says it is not text. */
const NUL_SCAN_BYTES = 8000

/** How long a worktree's `git status` is reused for. See `changedPaths`. */
const STATUS_TTL_MS = 2000

/* ------------------------------------------------------------ containment -- */

/**
 * Is `path` the directory `root`, or something under it?
 *
 * `startsWith(root)` alone is wrong, and quietly so: `/a/bc` starts with
 * `/a/b`, so a sibling worktree whose name merely extends this one's would be
 * readable through it. The separator makes the comparison one about path
 * components rather than characters, and the equality arm is what lets the
 * worktree root itself be listed.
 */
const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root + sep)

/**
 * The worktree's own path with every symlink resolved, remembered.
 *
 * A worktree can sit under a symlinked parent -- /home -> /mnt/home and the
 * like -- and comparing a resolved target against an unresolved root would then
 * reject every path in it. Cached because that is one `realpath` per worktree
 * for the life of the process rather than one per request.
 */
const rootRealCache = new Map<string, string>()

const rootReal = async (root: string): Promise<string> => {
  const cached = rootRealCache.get(root)
  if (cached !== undefined) return cached
  const real = await realpath(root)
  rootRealCache.set(root, real)
  return real
}

/**
 * Resolve a worktree-relative path to an absolute one, or refuse.
 *
 * Two checks, because neither is sufficient alone. `resolve()` folds away `..`
 * and duplicate separators, which stops the textual escape -- but it knows
 * nothing about symlinks, and a link committed into a repository pointing at
 * /etc would sail through it. `realpath()` closes that.
 *
 * Deliberately requires the path to exist. Nothing here creates files: the
 * agent does that, and a save is to a file you already have open. That also
 * disposes of the dangling-symlink case, where writing to a path that does not
 * resolve would follow the link to wherever it pointed.
 *
 * `Workspace.browse()` does the opposite of all this on purpose -- it takes any
 * absolute path and expands `~`, because the project picker has to roam the
 * filesystem. Do not "fix" it to use this.
 */
export const containedPath = async (root: string, rel: string): Promise<string> => {
  // Node throws ERR_INVALID_ARG_VALUE for a NUL, which would surface as a 500.
  if (rel.includes('\0')) throw new HttpError(400, 'invalid path')
  // Refusing rather than re-rooting means a client bug is loud instead of odd.
  if (isAbsolute(rel)) throw new HttpError(400, 'path must be relative to the worktree')

  const base = await rootReal(root)
  const target = resolve(base, rel)
  if (!inside(base, target)) throw outside(rel)

  /*
   * `.git` is refused by name, and it has to be by name: `check-ignore` never
   * reports it (measured), and in a linked worktree it is a *file* rather than
   * a directory, so a kind test would miss it too. Letting an editor write
   * .git/config has no upside worth the footgun.
   */
  if (relative(base, target).split(sep)[0] === '.git') throw outside(rel)

  try {
    const real = await realpath(target)
    if (!inside(base, real)) throw outside(rel)
    return real
  } catch (err) {
    if (err instanceof HttpError) throw err
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') throw new HttpError(404, `no such file: ${rel}`, 'file-missing')
    if (code === 'EACCES') throw new HttpError(403, `cannot read ${rel}`, 'file-unreadable')
    throw new HttpError(400, `cannot resolve ${rel}`)
  }
}

const outside = (rel: string): HttpError =>
  new HttpError(403, `${rel} is outside the worktree`, 'path-outside-worktree')

/* ---------------------------------------------------------- ignore rules -- */

/**
 * Which of `paths` git would ignore. Relative to `cwd`, and NUL-framed.
 *
 * Directories must arrive with a trailing `/`. A pattern like `dist/` matches
 * only directories, and git decides whether a path is one by stat'ing it --
 * measured: `check-ignore dist` on a path that does not exist reports nothing
 * while `check-ignore dist/` reports it. `readdir` has already told us the
 * kind, so saying it removes both a redundant stat inside git and a race with
 * the directory being deleted underneath us.
 *
 * Through stdin rather than argv: a directory of five thousand entries would
 * blow ARG_MAX, and an entry named `-n` would be read as an option.
 *
 * Note what this inherits for free -- every `.gitignore` on the way up,
 * `.git/info/exclude`, and `core.excludesFile`. The exclude file is how the
 * IDE's own nested worktrees stay out of the browser, since
 * `ensureWorktreesIgnored` writes its worktree pattern there.
 */
const checkIgnore = async (cwd: string, paths: string[]): Promise<Set<string>> => {
  if (paths.length === 0) return new Set()
  const stdout = await new Promise<string>((done, fail) => {
    const child = execFile(
      'git',
      ['check-ignore', '-z', '--stdin'],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        /*
         * Exit 1 is "nothing here is ignored", with empty stdout -- not a
         * failure. The same trap `fileDiff` documents for `git diff
         * --no-index`, which exits 1 whenever the files differ.
         */
        if (err !== null && (err as { code?: unknown }).code !== 1) fail(err)
        else done(out)
      },
    )
    // git may exit before we have finished writing; EPIPE is not interesting.
    child.stdin?.on('error', () => {})
    child.stdin?.end(paths.map((path) => `${path}\0`).join(''))
  })
  // The output is each ignored path echoed back verbatim, so the strings we
  // sent are exactly the keys to look up.
  return new Set(stdout.split('\0').filter((path) => path !== ''))
}

/* --------------------------------------------------------- change marking -- */

const statusCache = new Map<string, { at: number; paths: Set<string> }>()

/** Forget a worktree's cached status, after something we did changed it. */
export const invalidateStatus = (worktreePath: string): void => {
  statusCache.delete(worktreePath)
}

/** A path and every directory above it, so an ancestor can be marked too. */
const addWithAncestors = (paths: Set<string>, path: string): void => {
  let at = path
  while (at !== '' && at !== '.' && at !== sep) {
    paths.add(at)
    const up = dirname(at)
    if (up === at) break
    at = up
  }
}

/**
 * Every path the worktree has changed, plus every directory containing one.
 *
 * The ancestors are precomputed rather than prefix-matched per entry: a lookup
 * is then one `Set.has` instead of a walk over every change, and marking a
 * directory that contains a change is the same question as marking the file.
 *
 * Cached for the same reason `Workspace.worktrees` is, and for the same span:
 * `git status` on a large repository is not free, and clicking down five
 * columns of the browser asks five times inside a second. Invalidated outright
 * after a save, because a two-second lag between saving a file and seeing it
 * marked reads as the save not having worked.
 *
 * `--untracked-files=all` rather than `normal`, which collapses an untracked
 * directory to `foo/` and never names the files inside it -- descending into
 * one would then show nothing marked. It is also what `worktreeChanges` uses,
 * so the two panels agree about the same worktree.
 */
const changedPaths = async (worktreePath: string): Promise<Set<string>> => {
  const now = Date.now()
  const cached = statusCache.get(worktreePath)
  if (cached !== undefined && now - cached.at < STATUS_TTL_MS) return cached.paths

  const paths = new Set<string>()
  try {
    const { stdout } = await exec(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
    )
    for (const change of parseStatus(stdout)) {
      addWithAncestors(paths, change.path)
      // A rename is marked at both ends, or half of it looks untouched.
      if (change.from !== undefined) addWithAncestors(paths, change.from)
    }
  } catch {
    // Marks are decoration. A listing that fails because git hiccupped would be
    // a worse answer than an unmarked one.
  }
  statusCache.set(worktreePath, { at: now, paths })
  return paths
}

/* ---------------------------------------------------------------- listing -- */

/**
 * What kind of thing an entry is, following symlinks.
 *
 * `dirent.isDirectory()` is false for a symlink to a directory, so reporting
 * the link's own kind would show a directory as a file and make clicking it an
 * error every time. A link that dangles or points outside the worktree is
 * dropped rather than shown: an entry that always fails on click is worse than
 * an entry that is not there. So are sockets, fifos and devices.
 */
const classify = async (
  dir: string,
  entry: Dirent,
  base: string,
): Promise<'dir' | 'file' | null> => {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return null
  try {
    const target = await realpath(join(dir, entry.name))
    if (!inside(base, target)) return null
    const stats = await stat(target)
    return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : null
  } catch {
    return null
  }
}

/** git speaks in forward slashes and worktree-relative paths. */
const childOf = (rel: string, name: string): string => (rel === '' ? name : `${rel}/${name}`)

/**
 * One directory of a worktree, ignore-filtered and change-marked.
 *
 * One level only: the browser shows the path you are standing on and its
 * siblings, and a recursive listing of a real repository is tens of thousands
 * of entries to fill a column of eight rows. That is also why this reads the
 * directory and asks git about those names, rather than asking
 * `git ls-files --cached --others --exclude-standard`, which is recursive --
 * at the repository root that enumerates everything, per click, and never
 * mentions a tracked directory at all.
 */
export const listDirectory = async (worktreePath: string, rel: string): Promise<FileListing> => {
  const base = await rootReal(worktreePath)
  const dir = await containedPath(worktreePath, rel)
  if (!(await stat(dir)).isDirectory()) throw new HttpError(400, `not a directory: ${rel}`)

  const raw = await readdir(dir, { withFileTypes: true })
  const found: { name: string; kind: 'dir' | 'file' }[] = []
  for (const entry of raw) {
    // See containedPath: by name, because in a linked worktree it is a file.
    if (entry.name === '.git') continue
    const kind = await classify(dir, entry, base)
    if (kind !== null) found.push({ name: entry.name, kind })
  }

  /*
   * The directory itself goes into the same batch as its entries. A client that
   * hand-crafts `?path=node_modules` then gets a refusal rather than a column
   * of three hundred thousand rows -- children of an ignored directory are
   * themselves reported ignored, so the filter below would empty it anyway, but
   * saying so outright is clearer and costs nothing extra.
   */
  const selfKey = rel === '' ? null : `${rel}/`
  const keyOf = (entry: { name: string; kind: 'dir' | 'file' }): string =>
    entry.kind === 'dir' ? `${childOf(rel, entry.name)}/` : childOf(rel, entry.name)
  const ignored = await checkIgnore(base, [
    ...(selfKey === null ? [] : [selfKey]),
    ...found.map(keyOf),
  ])
  if (selfKey !== null && ignored.has(selfKey)) {
    throw new HttpError(404, `no such file: ${rel}`, 'file-missing')
  }

  const changed = await changedPaths(worktreePath)
  const kept = found.filter((entry) => !ignored.has(keyOf(entry)))
  // Directories first, then by name: the browser is walked far more often than
  // it is read, and a column you descend through wants its doors at the top.
  kept.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
  )

  const entries: FileEntry[] = kept.slice(0, MAX_ENTRIES).map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    // Absent rather than false: in a clean repository that is every entry.
    ...(changed.has(childOf(rel, entry.name)) ? { changed: true } : {}),
  }))
  return { path: rel, entries, ...(kept.length > MAX_ENTRIES ? { truncated: true } : {}) }
}

/* ------------------------------------------------------------ read, write -- */

/**
 * A file's identity for the stale-write guard.
 *
 * Nanoseconds, not `mtimeMs`, which is a double that rounds away sub-millisecond
 * precision -- and two writes inside one millisecond are exactly what this
 * guards against. The inode is in it because a write done as write-a-temp-then-
 * rename produces a different file that can land on the same timestamp.
 */
const revOf = (stats: BigIntStats): FileRev =>
  `${stats.mtimeNs}-${stats.size}-${stats.ino}`

/**
 * The file as text, or the reason there is none.
 *
 * Two ways to not be text, and the second matters as much as the first. A NUL
 * byte early on is git's own heuristic, so this agrees with what the git panel
 * decided about the same file. But a latin-1 file has no NUL, decodes happily
 * into U+FFFD, and saving it back would rewrite every non-ASCII byte in it --
 * so a strict decode is the check that actually protects the file.
 */
const decodeText = (buffer: Buffer): string | null => {
  if (buffer.subarray(0, NUL_SCAN_BYTES).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

/**
 * Read a file, or say that it has not moved since `ifNotRev`.
 *
 * The follow-poll and the first read are the same request on purpose. It is not
 * only the round trip: the file vanishing, growing past the cap or ceasing to
 * be text all have to be answered somewhere, and a stat-only poll endpoint
 * would need its own vocabulary for every one of them.
 */
export const readTextFile = async (
  worktreePath: string,
  rel: string,
  ifNotRev?: string,
): Promise<FileContent | FileUnchanged> => {
  const file = await containedPath(worktreePath, rel)

  /*
   * stat, read, stat. If the file moved in between, the rev we would hand back
   * does not describe the bytes we got -- and the next save would then be
   * refused as stale for no reason the reader could see. Three attempts is
   * plenty; a file being rewritten faster than that is not one to edit.
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await stat(file, { bigint: true })
    if (before.isDirectory()) throw new HttpError(400, `${rel} is a directory`)
    if (!before.isFile()) throw new HttpError(400, `not a regular file: ${rel}`)

    const rev = revOf(before)
    if (rev === ifNotRev) return { unchanged: true, rev }

    const mtimeMs = Number(before.mtimeMs)
    const size = Number(before.size)
    // Nothing is truncated to fit: a partial buffer in the editor is one save
    // away from destroying the rest of the file.
    if (size > config.maxFileBytes) return { path: rel, rev, mtimeMs, size, tooLarge: true }

    const buffer = await readFile(file)
    if (revOf(await stat(file, { bigint: true })) !== rev) continue

    const text = decodeText(buffer)
    return text === null
      ? { path: rel, rev, mtimeMs, size, binary: true }
      : { path: rel, rev, mtimeMs, size, text }
  }
  throw new HttpError(409, `${rel} is being rewritten faster than it can be read`, 'stale-file')
}

/**
 * Save a file, unless it moved since it was read.
 *
 * The guard is the whole point: the agent in this worktree edits the same files,
 * and last-writer-wins between a human and an agent is how work disappears. The
 * refusal carries the *fresh* rev, so a client that decides to overwrite anyway
 * can send it straight back without another round trip -- which is why there is
 * no force flag.
 *
 * Written in place rather than through a temp file and a rename, which is what
 * `state.ts` next door does. The reasoning there does not apply here: a source
 * file is under git and still in the editor's buffer, while a rename would
 * change the inode, break hardlinks, drop the mode, and briefly show a stray
 * temp file to both the browser and `git status`.
 */
export const writeTextFile = async (
  worktreePath: string,
  rel: string,
  text: string,
  ifRev: string,
): Promise<FileSaved> => {
  const file = await containedPath(worktreePath, rel)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > config.maxFileBytes) {
    throw new HttpError(413, `${rel} is larger than the editor will save`, 'file-too-large')
  }

  const before = await stat(file, { bigint: true })
  if (!before.isFile()) throw new HttpError(400, `not a regular file: ${rel}`)
  const rev = revOf(before)
  if (rev !== ifRev) {
    throw new HttpError(409, `${rel} changed on disk since you opened it`, 'stale-file', {
      rev,
      mtimeMs: Number(before.mtimeMs),
    })
  }

  await writeFile(file, text, 'utf8')
  const after = await stat(file, { bigint: true })
  // The mark beside this file in the browser is about to be wrong otherwise.
  invalidateStatus(worktreePath)
  return {
    path: rel,
    rev: revOf(after),
    mtimeMs: Number(after.mtimeMs),
    size: Number(after.size),
  }
}
