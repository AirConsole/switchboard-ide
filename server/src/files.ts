import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { BigIntStats, Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  FileContent,
  FileEntry,
  ContentHit,
  FileHit,
  FileListing,
  FileRev,
  FileSaved,
  FileUnchanged,
} from '@switchboard/shared'
import { mediaKindOf, mediaTypeOf } from '@switchboard/shared'
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

/**
 * Most paths a search will answer with.
 *
 * A search is a way of getting to one file, so a list longer than a screenful
 * has already failed at its job -- and the reader can always type another
 * letter, which is cheaper than us rendering four thousand rows they will not
 * read.
 */
const MAX_FIND = 200

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
  /*
   * At any depth, not just the first segment. This repo's own convention puts
   * worktrees at `<repo>/.claude/worktrees/<branch>`, so `.claude/worktrees/x/
   * .git` is a real file inside this tree -- rewriting it breaks another
   * agent's worktree -- and a vendored clone or submodule has the same door one
   * level down.
   */
  if (relative(base, target).split(sep).includes('.git')) throw outside(rel)

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
        /*
         * 128 is "not a git repository", which happens for a worktree whose
         * registration has been pruned while its directory survives. The
         * module's own docs say both 1 and 128 must be tolerated; only 1 was,
         * so that worktree answered a 500 with a git fatal in the body instead
         * of the 404 the rest of this file speaks.
         */
        /*
         * `err` first, and nothing read off it before that check.
         *
         * `execFile` reports success as a null error, and reading `.code` off
         * it threw a TypeError -- inside the callback, so it escaped this
         * promise rather than rejecting it, and the listing hung forever with
         * the request still open. It only bit where something is actually
         * ignored, since that is the only case git exits 0: every scratch
         * repository here has an empty .gitignore, and every real one does not.
         */
        if (err === null) {
          done(out)
          return
        }
        const code = (err as { code?: unknown }).code
        if (code === 1 || code === 128) done(out)
        else fail(err)
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

/* ----------------------------------------------------------------- search -- */

/**
 * Every file the worktree has, as git sees it.
 *
 * `--exclude-standard` is the whole reason this is a git command rather than a
 * walk: it applies every `.gitignore`, `.git/info/exclude` and
 * `core.excludesFile` for free, and never lists `.git` itself. Measured against
 * this checkout it returns 68 paths in 2ms, and 957 in 21ms on a larger repo,
 * with zero entries under `node_modules` or `dist`.
 *
 * `--cached --others` is tracked plus untracked, which is what a reader means
 * by "the files here" -- a file the agent created a minute ago is exactly the
 * one you are most likely to be looking for.
 */
const listFilesCache = new Map<string, { at: number; paths: string[] }>()

const allFiles = async (worktreePath: string): Promise<string[]> => {
  const now = Date.now()
  const cached = listFilesCache.get(worktreePath)
  if (cached !== undefined && now - cached.at < STATUS_TTL_MS) return cached.paths
  const { stdout } = await exec(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: worktreePath, maxBuffer: 16 * 1024 * 1024 },
  )
  const paths = stdout.split('\0').filter((path) => path !== '')
  listFilesCache.set(worktreePath, { at: now, paths })
  return paths
}

/** The part of a path after the last slash. */
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * Files whose path contains `query`, case-insensitively.
 *
 * A plain substring rather than a fuzzy subsequence: subsequence matching is
 * only useful with ranking behind it, and ranking is a second feature rather
 * than a flag on this one. What it does rank is where the match landed --
 * someone typing `filespane` means the file, not the directory above it, so a
 * hit in the name comes before a hit only in the path.
 *
 * The whole list is re-read at most every couple of seconds, so typing does not
 * spawn a git per keystroke; the filtering itself is a fraction of a
 * millisecond over a thousand paths.
 */
/**
 * The directories the worktree has, derived from the files in it.
 *
 * git has no notion of an empty directory, so every directory worth reaching is
 * an ancestor of a file `ls-files` reports -- which also means this inherits
 * the ignore rules for free, the same way the file list does.
 */
const dirsOf = (paths: string[]): string[] => {
  const dirs = new Set<string>()
  for (const path of paths) {
    let at = path.lastIndexOf('/')
    while (at > 0) {
      dirs.add(path.slice(0, at))
      at = path.lastIndexOf('/', at - 1)
    }
  }
  return [...dirs]
}

/**
 * Files and directories whose path contains the query.
 *
 * Directories are in it because a search is also how you get to a *place* you
 * have not walked to -- and one of them answers a different click from a file:
 * opening a file leaves the search up, while picking a directory drops the
 * query and unfolds that directory in the tree, which is where you were going.
 *
 * Ranked with matches on the name itself first, so `FilesPane` beats every file
 * that merely lives in a directory of that name, and directories before files
 * within a rank, which is the order the tree uses.
 */
export const findFiles = async (
  worktreePath: string,
  query: string,
): Promise<{ hits: FileHit[]; truncated?: boolean }> => {
  const needle = query.trim().toLowerCase()
  // Nothing to look for: answer without asking git anything.
  if (needle === '') return { hits: [] }

  const files = await allFiles(worktreePath)
  const hits: FileHit[] = []
  for (const path of dirsOf(files)) {
    if (path.toLowerCase().includes(needle)) hits.push({ path, kind: 'dir' })
  }
  for (const path of files) {
    if (path.toLowerCase().includes(needle)) hits.push({ path, kind: 'file' })
  }
  hits.sort((a, b) => {
    const inName = (hit: FileHit): number =>
      baseOf(hit.path).toLowerCase().includes(needle) ? 0 : 1
    const byWhere = inName(a) - inName(b)
    if (byWhere !== 0) return byWhere
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.path.localeCompare(b.path)
  })
  return {
    hits: hits.slice(0, MAX_FIND),
    ...(hits.length > MAX_FIND ? { truncated: true } : {}),
  }
}

/**
 * Lines that contain the query, case-insensitively, across the worktree.
 *
 * `git grep` rather than a walk of our own, for the reason `allFiles` asks git:
 * tracked plus untracked (`--untracked`), minus what is ignored, so
 * `node_modules` and `dist` are never searched, and never a binary (`-I`).
 * Fixed strings (`-F`), because the box is where you paste an error message
 * and a regex would make half of one mean something else; `-e` so a query that
 * starts with a dash is still a query.
 *
 * Bounded twice. `-m` keeps one file of a thousand hits from being the whole
 * answer -- and `more` names the files it cut short, and the process is killed once there are `MAX_FIND` lines, since
 * this runs as you type and a one-letter query matches most of a repository.
 * The time limit is for a repository big enough that even that takes a while.
 */
const GREP_PER_FILE = 20
const GREP_TIMEOUT_MS = 5000

export const grepFiles = (
  worktreePath: string,
  query: string,
): Promise<{ hits: ContentHit[]; truncated?: boolean; more?: string[] }> => {
  // Not trimmed, unlike a name: in a file, `x = ` and `x =` are different.
  const needle = query
  if (needle.trim() === '') return Promise.resolve({ hits: [] })
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'git',
      [
        'grep', '-I', '-n', '-i', '-F', '-z', '--untracked',
        // One past the cap, so a file that was cut short can say so.
        '-m', String(GREP_PER_FILE + 1), '-e', needle, '--',
      ],
      { cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const hits: ContentHit[] = []
    const perFile = new Map<string, number>()
    const more = new Set<string>()
    let truncated = false
    let pending = ''
    let stderr = ''
    const timer = setTimeout(() => {
      truncated = true
      child.kill()
    }, GREP_TIMEOUT_MS)
    /*
     * `path\0line\0text\n`, measured: with `-z` the separator after the line
     * number is a NUL as well, so a colon in a path or in the text is never
     * mistaken for one.
     */
    const take = (record: string): void => {
      const a = record.indexOf('\0')
      const b = a === -1 ? -1 : record.indexOf('\0', a + 1)
      if (b === -1) return
      const line = Number(record.slice(a + 1, b))
      if (!Number.isInteger(line)) return
      const path = record.slice(0, a)
      const count = (perFile.get(path) ?? 0) + 1
      perFile.set(path, count)
      if (count > GREP_PER_FILE) {
        more.add(path)
        return
      }
      const text = record.slice(b + 1).trim()
      hits.push({
        path,
        line,
        text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (hits.length >= MAX_FIND) return
      pending += chunk
      let end = pending.indexOf('\n')
      while (end !== -1 && hits.length < MAX_FIND) {
        take(pending.slice(0, end))
        pending = pending.slice(end + 1)
        end = pending.indexOf('\n')
      }
      if (hits.length >= MAX_FIND) {
        truncated = true
        child.kill()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // 1 is "nothing matched"; a kill of our own is not a failure either.
      if (code !== 0 && code !== 1 && code !== null) {
        reject(new Error(stderr.trim() || `git grep exited ${code}`))
        return
      }
      resolvePromise({
        hits,
        ...(truncated ? { truncated: true } : {}),
        ...(more.size > 0 ? { more: [...more] } : {}),
      })
    })
  })
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
 * byte early on is git's own heuristic, so this agrees with what the diff
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

/* ------------------------------------------------------------------ media -- */

// `mediaTypeOf` and its table live in shared/, because the browser has to know
// the same answer before the read comes back -- see media.ts there. Re-exported
// so what this module answers for does not change shape. `mediaKindOf` rides
// along for the tests that hold the two to each other; nothing here asks it,
// because which element shows a file is the panel's question.
export { mediaTypeOf, mediaKindOf }

/**
 * Where a media file is on disk, and what to serve it as.
 *
 * Only the path: the bytes go to the browser as a stream, because the point of
 * this route is the files that have no business being turned into JSON. The
 * type comes from the same table the read consulted, so `/raw` can never be
 * talked into labelling a file as something the reader did not ask for.
 */
export const mediaFile = async (
  worktreePath: string,
  rel: string,
): Promise<{ file: string; type: string; size: number }> => {
  const type = mediaTypeOf(rel)
  if (type === undefined) throw new HttpError(415, `${rel} is not something to show here`)
  return { ...(await streamable(worktreePath, rel)), type }
}

/**
 * The same, for a file being handed over rather than drawn.
 *
 * There is no table to pass here, and that is the point: the panel refusing to
 * *show* a file -- past the size cap, or holding no text at all -- is the whole
 * reason anybody asks for it this way, so a gate on what the browser can draw
 * would refuse exactly the files this exists for. A file over the cap is still
 * streamed, because the cap is about text going through JSON and says nothing
 * about handing bytes over.
 *
 * What it gives up instead is naming the format. Anything the table does not
 * know is `application/octet-stream` -- bytes, which is the one type that
 * renders nowhere and runs nothing, rather than a guess at a file we have not
 * read. Containment is untouched and is still the whole boundary.
 */
export const takeableFile = async (
  worktreePath: string,
  rel: string,
): Promise<{ file: string; type: string; size: number }> => ({
  ...(await streamable(worktreePath, rel)),
  type: mediaTypeOf(rel) ?? 'application/octet-stream',
})

/** Where a file is and how big, for a route that streams it rather than reads it. */
const streamable = async (
  worktreePath: string,
  rel: string,
): Promise<{ file: string; size: number }> => {
  const file = await containedPath(worktreePath, rel)
  const stats = await stat(file)
  if (!stats.isFile()) throw new HttpError(400, `not a regular file: ${rel}`)
  return { file, size: stats.size }
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

    /*
     * Something the browser draws is answered without reading a byte.
     *
     * Before the size cap, which is a cap on text going through JSON and has
     * nothing to say about a photograph: the bytes never come this way at all.
     * The client fetches them from `/raw`, keyed by this rev, so an image the
     * agent regenerates is a new URL and repaints on the next poll.
     */
    const media = mediaTypeOf(rel)
    if (media !== undefined) return { path: rel, rev, mtimeMs, size, binary: true, media }

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

/**
 * A file dropped into a directory of the worktree.
 *
 * Streamed to disk and never held: the whole point of dropping something in is
 * that it is the kind of file the editor cannot open -- a screen recording, a
 * sample, a PDF -- and those are exactly the sizes a buffer is wrong for. There
 * is deliberately **no size cap**. `maxFileBytes` is a cap on text going
 * through JSON and has nothing to say here, and any number picked for this
 * would be the wrong one for somebody dropping a video; the caller already has
 * a shell on this machine through every terminal in the row, so a cap protects
 * nothing it could not walk around.
 *
 * Written to a temp file beside the target and renamed on, which is the
 * opposite of what `writeTextFile` does one door up -- and the reasoning there
 * says why: a save is to a file under git that is still in the editor's buffer,
 * where a rename would change the inode and drop the mode. This is a file that
 * does not exist yet, arriving over a network that can stop halfway, and a
 * half-written one appearing in the tree under its final name is the thing to
 * avoid. The rename is atomic within the directory.
 *
 * It refuses to overwrite. Dropping a file whose name is already taken is far
 * more often a mistake than an intention, and the reader can see what is there
 * and decide -- where a silent overwrite is not recoverable and not even
 * noticed.
 */
export const uploadFile = async (
  worktreePath: string,
  dir: string,
  name: string,
  body: Readable,
): Promise<FileSaved> => {
  /*
   * The *directory* is contained -- the file itself cannot be, since it does
   * not exist and `containedPath` requires it to. The name is then held to a
   * single ordinary segment, which is what closes the gap that opens: a `name`
   * of `../../x` would otherwise be joined onto a path that passed the check.
   */
  if (name === '' || name === '.' || name === '..') throw new HttpError(400, 'that is not a name')
  if (/[/\\\0]/.test(name)) throw new HttpError(400, `a file name cannot contain a path: ${name}`)
  const root = await containedPath(worktreePath, dir)
  const into = await stat(root)
  if (!into.isDirectory()) throw new HttpError(400, `${dir} is not a directory`)
  const target = join(root, name)
  // Belt and braces: the name test above already makes this true, and a second
  // reading costs nothing on a path that is about to receive bytes.
  if (relative(root, target) !== name) throw new HttpError(403, `${name} is outside ${dir}`)

  const exists = await stat(target).catch(() => null)
  if (exists !== null) {
    throw new HttpError(409, `there is already a file called ${name} here`, 'file-exists')
  }

  const temp = join(root, `.swb-upload-${randomUUID()}`)
  try {
    await pipeline(body, createWriteStream(temp))
    await rename(temp, target)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
  const after = await stat(target, { bigint: true })
  // The marks beside these files in the browser are about to be wrong otherwise.
  invalidateStatus(worktreePath)
  return {
    path: dir === '' ? name : `${dir}/${name}`,
    rev: revOf(after),
    mtimeMs: Number(after.mtimeMs),
    size: Number(after.size),
  }
}
