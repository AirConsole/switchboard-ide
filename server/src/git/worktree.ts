import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
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
      name: isMain ? basename(mainPath) : basename(w.path),
      branch: w.branch,
      path: w.path,
      isMain,
      missing: w.prunable,
    }
  })
}

/** Default location for new worktrees: `<parent>/<repo>-branches/`. */
export const defaultWorktreeRoot = (root: string): string =>
  resolve(root, '..', `${basename(resolve(root))}-branches`)

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

export const worktreePathFor = (worktreeRoot: string, branch: string): string =>
  join(worktreeRoot, branch.replace(/\//g, '-'))
