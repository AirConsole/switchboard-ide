import { access, readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AppSnapshot, Project, Worktree } from '@ide-n-dream/shared'
import type { StateStore } from './state.js'
import type { SessionEngine } from './session/engine.js'
import {
  addWorktree,
  defaultWorktreeRoot,
  deleteBranch,
  dirtyCount,
  isGitRepo,
  isValidBranchName,
  listWorktrees,
  projectIdFor,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  worktreePathFor,
} from './git/worktree.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Ties the three sources of truth together: the state store (projects + UI),
 * git (worktrees) and the session engine (terminals).
 */
export class Workspace {
  /**
   * Short-lived cache over `git worktree list` + `git status`. The snapshot is
   * re-fetched after every mutation and on reconnect, and `git status` on a
   * large repo is not free, so repeated reads inside a couple of seconds reuse
   * the result.
   */
  private cache: { at: number; worktrees: Worktree[] } | null = null
  private readonly cacheTtlMs = 2000

  constructor(
    private readonly store: StateStore,
    private readonly engine: SessionEngine,
  ) {}

  invalidate(): void {
    this.cache = null
  }

  async worktrees(): Promise<Worktree[]> {
    const now = Date.now()
    if (this.cache && now - this.cache.at < this.cacheTtlMs) return this.cache.worktrees

    const all: Worktree[] = []
    for (const project of this.store.projects) {
      try {
        const list = await listWorktrees(project.id, project.root)
        for (const worktree of list) {
          all.push({ ...worktree, dirty: await dirtyCount(worktree.path) })
        }
      } catch {
        // A project whose directory moved or was deleted should not break the
        // whole snapshot; it simply contributes no worktrees.
      }
    }
    this.cache = { at: now, worktrees: all }
    return all
  }

  async resolve(worktreeId: string): Promise<{ worktree: Worktree; project: Project }> {
    const worktree = (await this.worktrees()).find((w) => w.id === worktreeId)
    if (!worktree) throw new HttpError(404, 'no such worktree')
    const project = this.store.project(worktree.projectId)
    if (!project) throw new HttpError(404, 'no such project')
    return { worktree, project }
  }

  async snapshot(): Promise<AppSnapshot> {
    return {
      projects: this.store.projects,
      worktrees: await this.worktrees(),
      sessions: this.engine.list(),
      ui: this.store.ui,
    }
  }

  async openProject(path: string): Promise<Project> {
    const expanded = expandHome(path)
    if (!(await isDirectory(expanded))) throw new HttpError(400, `not a directory: ${expanded}`)
    if (!(await isGitRepo(expanded))) throw new HttpError(400, `not a git repository: ${expanded}`)
    // Normalise to the repo root so opening a subdirectory (or a worktree of the
    // repo) registers the same project rather than a near-duplicate.
    const root = await repoRoot(expanded)
    const project: Project = {
      id: projectIdFor(root),
      name: basename(root),
      root,
      worktreeRoot: defaultWorktreeRoot(root),
      addedAt: Date.now(),
    }
    this.store.addProject(project)
    this.invalidate()
    return project
  }

  closeProject(id: string): void {
    this.store.removeProject(id)
    this.invalidate()
  }

  async createWorktree(opts: {
    projectId: string
    branch: string
    base?: string
  }): Promise<Worktree> {
    const project = this.store.project(opts.projectId)
    if (!project) throw new HttpError(404, 'no such project')
    const branch = opts.branch.trim()
    if (!(await isValidBranchName(project.root, branch))) {
      throw new HttpError(400, `invalid branch name: ${branch}`)
    }
    const path = worktreePathFor(project.worktreeRoot, branch)
    if (await exists(path)) throw new HttpError(409, `path already exists: ${path}`)

    try {
      await addWorktree({ root: project.root, path, branch, base: opts.base })
    } catch (err) {
      throw new HttpError(400, gitMessage(err))
    }
    this.invalidate()
    const created = (await this.worktrees()).find((w) => resolve(w.path) === resolve(path))
    if (!created) throw new HttpError(500, 'worktree created but not listed by git')
    return created
  }

  /**
   * Remove a worktree and everything running in it.
   *
   * Sessions are killed first, deliberately: a live shell holding the directory
   * as its cwd leaves tmux reporting `/path (deleted)` and can make git's
   * removal fail or leave the session pointed at a directory that no longer
   * exists.
   */
  async removeWorktree(opts: {
    worktreeId: string
    force: boolean
    alsoDeleteBranch: boolean
  }): Promise<void> {
    const { worktree, project } = await this.resolve(opts.worktreeId)
    if (worktree.isMain) throw new HttpError(400, 'refusing to remove the main worktree')

    await this.engine.killForWorktree(worktree.id)
    try {
      await removeWorktree(project.root, worktree.path, opts.force)
    } catch (err) {
      throw new HttpError(400, gitMessage(err))
    }
    if (opts.alsoDeleteBranch && worktree.branch) {
      try {
        await deleteBranch(project.root, worktree.branch, opts.force)
      } catch {
        // The worktree is gone, which is what was asked; an unmerged branch that
        // git declines to delete is not a failure of this operation.
      }
    }
    await pruneWorktrees(project.root).catch(() => {})
    this.invalidate()
  }

  /** Directory listing for the "Open project" picker. */
  async browse(path: string): Promise<{
    path: string
    parent: string | null
    entries: { name: string; path: string; isRepo: boolean }[]
  }> {
    const dir = resolve(expandHome(path || homedir()))
    if (!(await isDirectory(dir))) throw new HttpError(400, `not a directory: ${dir}`)
    const raw = await readdir(dir, { withFileTypes: true })
    const dirs = raw
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
    const entries = await Promise.all(
      dirs.map(async (e) => {
        const full = resolve(dir, e.name)
        return { name: e.name, path: full, isRepo: await exists(resolve(full, '.git')) }
      }),
    )
    const parent = resolve(dir, '..')
    return { path: dir, parent: parent === dir ? null : parent, entries }
  }
}

const expandHome = (path: string): string =>
  path.startsWith('~') ? resolve(homedir(), path.slice(1).replace(/^\/+/, '')) : path

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** git writes the useful part of a failure to stderr, not to `message`. */
const gitMessage = (err: unknown): string => {
  const e = err as { stderr?: string; message?: string }
  const text = (e.stderr ?? e.message ?? 'git command failed').toString().trim()
  return text.split('\n').slice(0, 3).join(' ').trim() || 'git command failed'
}
