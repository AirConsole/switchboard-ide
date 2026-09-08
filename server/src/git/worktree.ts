import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Worktree } from '@ide-n-dream/shared'

const exec = promisify(execFile)

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/**
 * Ids are derived from the absolute path rather than generated.
 *
 * Sessions record their worktree id inside tmux, so the id must be identical
 * after an IDE restart or those sessions would be orphaned. Hashing the path
 * makes that automatic and needs no persistence to be correct.
 */
const idFor = (prefix: string, path: string): string =>
  `${prefix}-${createHash('sha1').update(resolve(path)).digest('hex').slice(0, 10)}`

export const projectIdFor = (root: string): string => idFor('p', root)
export const worktreeIdFor = (path: string): string => idFor('wt', path)

export const isGitRepo = async (path: string): Promise<boolean> => {
  try {
    const out = await git(path, 'rev-parse', '--is-inside-work-tree')
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** Absolute root of the main worktree, given any path inside the repo. */
export const repoRoot = async (path: string): Promise<string> => {
  // --path-format=absolute keeps this correct when called from a subdirectory.
  const out = await git(path, 'rev-parse', '--path-format=absolute', '--show-toplevel')
  return out.trim()
}

export interface RawWorktree {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

/**
 * Parse `git worktree list --porcelain`: records separated by blank lines, each
 * a sequence of `key value` or bare-flag lines.
 */
export const listRawWorktrees = async (root: string): Promise<RawWorktree[]> => {
  const stdout = await git(root, 'worktree', 'list', '--porcelain')
  const out: RawWorktree[] = []
  let current: RawWorktree | null = null
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      if (current) out.push(current)
      current = null
      continue
    }
    const spaceAt = line.indexOf(' ')
    const key = spaceAt === -1 ? line : line.slice(0, spaceAt)
    const value = spaceAt === -1 ? '' : line.slice(spaceAt + 1)
    if (key === 'worktree') {
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      }
      continue
    }
    if (!current) continue
    if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
    else if (key === 'locked') current.locked = true
    else if (key === 'prunable') current.prunable = true
  }
  if (current) out.push(current)
  return out
}

export const listWorktrees = async (projectId: string, root: string): Promise<Worktree[]> => {
  const raw = await listRawWorktrees(root)
  const mainPath = resolve(root)
  return raw.map((w) => {
    const isMain = resolve(w.path) === mainPath
    return {
      id: worktreeIdFor(w.path),
      projectId,
      /*
       * The main worktree is named after its branch, not its directory: the
       * directory is the repository, whose name the interface already shows
       * beside it, so using it here just says the project twice. A detached
       * main worktree has no branch to use, so it falls back to the directory.
       */
      name: isMain ? (w.branch ?? basename(mainPath)) : basename(w.path),
      branch: w.branch,
      path: w.path,
      isMain,
      missing: w.prunable,
      ...(w.head === null ? {} : { head: w.head }),
    }
  })
}

/**
 * Where new worktrees go: `<repo>/.claude/worktrees/`.
 *
 * This is Claude Code's own convention -- `claude --worktree` and its
 * EnterWorktree tool both create worktrees inside `.claude/worktrees/` -- so a
 * worktree made here and one made by Claude itself land in the same place, and
 * neither litters the directory above the repository.
 */
export const defaultWorktreeRoot = (root: string): string =>
  join(resolve(root), '.claude', 'worktrees')

const WORKTREE_IGNORE_PATTERN = '**/.claude/worktrees/'

/**
 * Make sure git ignores the worktrees directory.
 *
 * Worktrees now live inside the repository, so without this the main worktree
 * reports `.claude/` as untracked: it would inflate the dirty count on every
 * tab, block removal behind the "uncommitted changes" guard, and risk being
 * committed by a careless `git add -A`.
 *
 * The pattern goes in `.git/info/exclude` rather than `.gitignore` because that
 * file is repo-local and untracked, so nothing appears in a file the team
 * shares. Claude Code writes the identical pattern to the identical place.
 */
export const ensureWorktreesIgnored = async (root: string): Promise<void> => {
  try {
    const gitDir = (
      await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    ).trim()
    const excludeFile = join(gitDir, 'info', 'exclude')
    const current = await readFile(excludeFile, 'utf8').catch(() => '')
    if (current.split('\n').some((line) => line.trim() === WORKTREE_IGNORE_PATTERN)) return
    await mkdir(dirname(excludeFile), { recursive: true })
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    await appendFile(excludeFile, `${separator}${WORKTREE_IGNORE_PATTERN}\n`)
  } catch {
    // Not fatal: the worktree still works, the main repo just looks dirty.
  }
}

export const currentBranch = async (path: string): Promise<string | null> => {
  try {
    const out = (await git(path, 'branch', '--show-current')).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** Count of changed tracked+untracked entries, for the tab's dirty indicator. */
export const dirtyCount = async (path: string): Promise<number> => {
  try {
    const out = await git(path, 'status', '--porcelain=v1', '--untracked-files=normal')
    return out.split('\n').filter((l) => l.trim() !== '').length
  } catch {
    return 0
  }
}

export const branchExists = async (root: string, branch: string): Promise<boolean> => {
  try {
    await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

/**
 * Git refuses many characters in branch names; validating up front turns a
 * confusing git error into a clear message. `check-ref-format` is the authority,
 * so we ask git rather than reimplementing its rules.
 */
export const isValidBranchName = async (root: string, branch: string): Promise<boolean> => {
  if (branch.trim() === '' || branch.includes('/../') || branch.startsWith('-')) return false
  try {
    await git(root, 'check-ref-format', '--branch', branch)
    return true
  } catch {
    return false
  }
}

export interface AddWorktreeOptions {
  root: string
  /** Directory to create. Must not exist. */
  path: string
  branch: string
  /** Ref to branch from; defaults to the repo's current HEAD. */
  base?: string
}

export const addWorktree = async (opts: AddWorktreeOptions): Promise<void> => {
  const exists = await branchExists(opts.root, opts.branch)
  const args = ['worktree', 'add']
  if (exists) {
    // Checking out an existing branch: no -b, and no base (git would reject it).
    args.push(opts.path, opts.branch)
  } else {
    args.push('-b', opts.branch, opts.path)
    if (opts.base) args.push(opts.base)
  }
  await git(opts.root, ...args)
}

export const removeWorktree = async (
  root: string,
  path: string,
  force = false,
): Promise<void> => {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(path)
  await git(root, ...args)
}

export const deleteBranch = async (root: string, branch: string, force = false): Promise<void> => {
  await git(root, 'branch', force ? '-D' : '-d', branch)
}

export const pruneWorktrees = async (root: string): Promise<void> => {
  await git(root, 'worktree', 'prune')
}

/**
 * Turn a directory into a usable project: `git init` plus a first commit.
 *
 * The commit is not optional. A repository with no commits has no HEAD, and
 * `git worktree add` refuses to run against it ("fatal: not a valid object
 * name: 'HEAD'"), so a freshly created project could not do the one thing this
 * IDE exists for.
 *
 * `commitExisting` decides whether files already in the directory go into that
 * commit. Including them matters more than it looks: a first commit with no
 * files means every new worktree checks out an empty tree, so the branch you
 * hand an agent would not contain the project. `git add -A` honours a
 * .gitignore if one is there.
 *
 * `--allow-empty` covers both an empty directory and an opt-out, so there is
 * one code path either way.
 */
export const initRepository = async (
  path: string,
  opts: { commitExisting?: boolean } = {},
): Promise<void> => {
  await git(path, 'init')
  if (opts.commitExisting ?? true) await git(path, 'add', '-A')
  await git(path, 'commit', '--allow-empty', '-m', 'Initial commit')
}

/** Root of the repository containing `path`, or null when there is none. */
export const enclosingRepoRoot = async (path: string): Promise<string | null> => {
  try {
    const out = await git(path, 'rev-parse', '--path-format=absolute', '--show-toplevel')
    return out.trim() === '' ? null : out.trim()
  } catch {
    return null
  }
}

export const worktreePathFor = (worktreeRoot: string, branch: string): string =>
  join(worktreeRoot, branch.replace(/\//g, '-'))

/** Used when a repository has no remote to be fresh against. */
export const LOCAL_HEAD_BASE = 'HEAD'

/**
 * The ref new worktrees branch from when none is named.
 *
 * This matches Claude Code's `worktree.baseRef` default of `fresh`: branch from
 * origin/<default-branch> "for a clean tree", rather than carrying whatever
 * happens to be checked out locally. `head` -- the other setting -- is what
 * typing a base by hand gives you.
 *
 * No fetch is performed: the remote-tracking ref is used as it stands, so this
 * never blocks on the network.
 */
export const resolveDefaultBase = async (root: string): Promise<string> => {
  // What the remote itself calls its default branch, when git has recorded it.
  try {
    const head = (
      await git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    ).trim()
    if (head !== '') return head
  } catch {
    // origin/HEAD is only set by clone, or by `git remote set-head`.
  }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await git(root, 'rev-parse', '--verify', '--quiet', candidate)
      return candidate
    } catch {
      // Not this one.
    }
  }
  return LOCAL_HEAD_BASE
}
