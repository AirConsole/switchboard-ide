import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Worktree } from '@switchboard/shared'
import { repoRoot, worktreeIdFor } from './worktree.js'

const exec = promisify(execFile)

/*
 * A workspace is a folder that is not a repository and holds several, for work
 * that spans them -- `~/src/company` with a dozen checkouts in it, where one
 * feature touches three. Nothing about it is stored beyond the folder: its
 * repositories are the directories inside it with a `.git`, and its worktrees
 * are the directories under `.claude/worktrees/`, each holding one real git
 * worktree per repository it spans. Discovered the way a repository's worktrees
 * are, so a worktree Claude assembles by hand shows up the same as one made
 * here.
 */

/** A repository inside a workspace worktree. */
export interface Member {
  /** Its directory's name, which is the prefix of every path reported from it. */
  name: string
  path: string
}

/**
 * Run `fn` over `items`, at most `limit` at a time, keeping the order.
 *
 * Measured over the 36 repositories this was written against: `git status` in
 * each one after the other took 840ms, eight at a time 100ms -- and the poll that
 * asks runs every four seconds.
 */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++
      out[at] = await fn(items[at]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export const PARALLEL_GIT = 8

const hasGit = async (dir: string): Promise<boolean> => {
  try {
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * The checkouts directly inside `dir`, by name.
 *
 * One level, not a walk: a workspace is the folder you would `cd` into to clone
 * the next repository, and a repository's own submodules and vendored checkouts
 * are that repository's business. Dot-directories are skipped, which is also
 * what keeps `.claude/worktrees` -- where this workspace's own worktrees live --
 * from being read as one of its repositories.
 */
export const reposIn = async (dir: string): Promise<string[]> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
  const found = await mapLimit(names, PARALLEL_GIT, async (name) =>
    (await hasGit(join(dir, name))) ? name : null,
  )
  return found.filter((name): name is string => name !== null).sort((a, b) => a.localeCompare(b))
}

/** A name that may be joined onto a directory and stay one level inside it. */
export const isRepoName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') &&
  !name.startsWith('.')

const roots = new Map<string, string>()

/**
 * The main checkout a member belongs to, which is where its branches are.
 *
 * Cached for the life of the process: a worktree does not change repository.
 */
export const memberRoot = async (path: string): Promise<string> => {
  const known = roots.get(path)
  if (known !== undefined) return known
  const root = await repoRoot(path)
  roots.set(path, root)
  return root
}

/** HEAD and the branch checked out, in one call; null for a checkout git cannot read. */
const headOf = async (path: string): Promise<{ head: string; branch: string | null } | null> => {
  try {
    // Measured: prints the hash, then the branch -- or `HEAD` when detached.
    const { stdout } = await exec('git', ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { cwd: path })
    const [head = '', branch = ''] = stdout.trim().split('\n')
    return { head, branch: branch === '' || branch === 'HEAD' ? null : branch }
  } catch {
    return null
  }
}

/** A workspace worktree, with where each of its repositories is. */
export type WorkspaceWorktree = Worktree & { members: Member[] }

/**
 * Every worktree of a workspace: the folder itself, then one per directory
 * under `worktreeRoot`.
 *
 * The folder is the main worktree and spans every repository in it, checked
 * out however each one happens to be -- which is what starting Claude in the
 * folder by hand always gave you. A worktree under `worktreeRoot` spans the
 * repositories that are git checkouts inside it, and is on a branch when all of
 * them agree about which.
 *
 * `head` is every member's HEAD together, since it only exists to say
 * "something moved here": one repository committing is a change to the whole.
 */
export const listWorkspaceWorktrees = async (
  projectId: string,
  root: string,
  worktreeRoot: string,
): Promise<WorkspaceWorktree[]> => {
  const describe = async (
    path: string,
    isMain: boolean,
  ): Promise<WorkspaceWorktree> => {
    const names = await reposIn(path)
    const heads = await mapLimit(names, PARALLEL_GIT, (name) => headOf(join(path, name)))
    const branches = new Set(heads.map((h) => h?.branch ?? null))
    const only = branches.size === 1 ? [...branches][0] ?? null : null
    return {
      id: worktreeIdFor(path),
      projectId,
      name: basename(path),
      branch: isMain ? null : only,
      path,
      isMain,
      repos: names,
      members: names.map((name) => ({ name, path: join(path, name) })),
      head: heads.map((h) => h?.head ?? '').join(','),
    }
  }

  const main = await describe(resolve(root), true)
  let dirs: string[] = []
  try {
    dirs = (await readdir(worktreeRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // No worktrees made yet.
  }
  const linked = await mapLimit(dirs, PARALLEL_GIT, (dir) => describe(join(worktreeRoot, dir), false))
  return [main, ...linked]
}

/**
 * What is inside a workspace worktree that none of its repositories holds.
 *
 * Nothing tracks it, so removing the worktree would destroy it with no copy
 * anywhere: counted as uncommitted work, which is what makes removal refuse
 * without `force`. `.DS_Store` is the one exception -- Finder writes it into
 * any folder it opens.
 */
export const strayEntries = async (path: string, members: readonly Member[]): Promise<number> => {
  const mine = new Set(members.map((m) => m.name))
  try {
    return (await readdir(path)).filter((name) => !mine.has(name) && name !== '.DS_Store').length
  } catch {
    return 0
  }
}

/**
 * Take a workspace worktree's folder away once its repositories have gone.
 *
 * `rmdir` unless forced, so a folder that still holds something -- which the
 * dirty guard should have refused on -- fails rather than disappears.
 */
export const removeWorkspaceFolder = async (path: string, force: boolean): Promise<void> => {
  if (force) {
    await rm(path, { recursive: true, force: true })
    return
  }
  await rm(join(path, '.DS_Store'), { force: true })
  await rmdir(path)
}

/** A workspace worktree's repositories, from what the snapshot says of it. */
export const membersOf = (worktree: Pick<Worktree, 'path' | 'repos'>): Member[] =>
  (worktree.repos ?? []).map((name) => ({ name, path: join(worktree.path, name) }))
