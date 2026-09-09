import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AppSnapshot, Project, Worktree } from '@ide-n-dream/shared'
import type { StateStore } from './state.js'
import type { SessionEngine } from './session/engine.js'
import {
  addWorktree,
  defaultWorktreeRoot,
  deleteBranch,
  dirtyCount,
  enclosingRepoRoot,
  ensureWorktreesIgnored,
  initRepository,
  isGitRepo,
  isValidBranchName,
  listWorktrees,
  projectIdFor,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  resolveDefaultBase,
  worktreePathFor,
} from './git/worktree.js'
import { lastPrompt } from './session/claude.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable tag so the client can offer a specific recovery. */
    readonly code?: string,
    /** Extra fields merged into the error response body. */
    readonly details?: Record<string, unknown>,
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

  /** Signature of everything a client would notice about the worktrees. */
  private static signature(worktrees: Worktree[]): string {
    return worktrees
      .map(
        (w) =>
          `${w.id}:${w.branch ?? ''}:${w.head ?? ''}:${w.dirty ?? 0}:${w.missing === true}:${w.prompt ?? ''}`,
      )
      .join('|')
  }

  private lastSignature: string | null = null
  private polling = false

  /**
   * Re-read the worktrees and say whether anything a client can see moved.
   *
   * Worktree state was only ever computed when a snapshot was asked for, and
   * snapshots are only asked for after a mutation or on reconnect -- so a dirty
   * count was a load-time value, and an agent editing or committing changed
   * nothing on screen. This is what a caller polls to turn that into a push.
   *
   * Overlapping runs are dropped rather than queued: `git status` on a large
   * repo can outlast the interval, and piling up would only make it worse.
   */
  async pollChanged(): Promise<boolean> {
    if (this.polling) return false
    this.polling = true
    try {
      this.invalidate()
      const signature = Workspace.signature(await this.worktrees())
      const changed = this.lastSignature !== null && this.lastSignature !== signature
      this.lastSignature = signature
      return changed
    } catch {
      return false
    } finally {
      this.polling = false
    }
  }

  async worktrees(): Promise<Worktree[]> {
    const now = Date.now()
    if (this.cache && now - this.cache.at < this.cacheTtlMs) return this.cache.worktrees

    const all: Worktree[] = []
    for (const project of this.store.projects) {
      try {
        const list = await listWorktrees(project.id, project.root)
        for (const worktree of list) {
          all.push({
            ...worktree,
            dirty: await dirtyCount(worktree.path),
            prompt: await lastPrompt(worktree.path),
          })
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
      projects: await this.describeProjects(),
      worktrees: await this.worktrees(),
      sessions: this.engine.list(),
      ui: this.store.ui,
    }
  }

  /**
   * Projects with their derived base ref attached, so the UI can name the ref a
   * new worktree will branch from instead of describing it vaguely.
   */
  private async describeProjects(): Promise<Project[]> {
    return Promise.all(
      this.store.projects.map(async (project) => ({
        ...project,
        defaultBase: await resolveDefaultBase(project.root).catch(() => undefined),
      })),
    )
  }

  /**
   * Register a project.
   *
   * With `create`, a missing directory is created and initialised as a
   * repository. Without it, a missing path is reported as `path-missing` so the
   * client can offer to create it rather than dead-ending on an error.
   */
  async openProject(
    path: string,
    opts: { create?: boolean; commitExisting?: boolean } = {},
  ): Promise<Project> {
    const target = resolve(expandHome(path))

    if (!(await exists(target))) {
      if (!opts.create) {
        throw new HttpError(404, `Nothing exists at ${target}`, 'path-missing', {
          path: target,
          // Creating a repository inside another one is almost always a
          // mistake, so let the client warn before it happens.
          insideRepo: await enclosingRepoOf(target),
        })
      }
      await mkdir(target, { recursive: true })
    }

    if (!(await isDirectory(target))) throw new HttpError(400, `Not a directory: ${target}`)

    if (!(await isGitRepo(target))) {
      if (!opts.create) {
        throw new HttpError(400, `Not a git repository: ${target}`, 'not-a-repo', {
          path: target,
          ...(await inspectForInit(target)),
        })
      }
      await initRepository(target, { commitExisting: opts.commitExisting })
    }

    // Normalise to the repo root so opening a subdirectory (or a worktree of the
    // repo) registers the same project rather than a near-duplicate.
    const root = await repoRoot(target)
    const project: Project = {
      id: projectIdFor(root),
      name: basename(root),
      // Only local projects can be opened by path. A remote one will arrive
      // with a base URL instead, and its ids will be namespaced by it.
      host: { kind: 'local' },
      root,
      worktreeRoot: defaultWorktreeRoot(root),
      addedAt: Date.now(),
    }
    this.store.addProject(project)
    this.invalidate()
    return { ...project, defaultBase: await resolveDefaultBase(root).catch(() => undefined) }
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

    // Before creating anything inside the repository, make sure git will not
    // report it as untracked.
    await ensureWorktreesIgnored(project.root)

    // With no base named, branch from origin/<default-branch> so the worktree
    // starts clean -- Claude Code's own default for `worktree.baseRef`.
    const base = opts.base?.trim() || (await resolveDefaultBase(project.root))

    try {
      await addWorktree({ root: project.root, path, branch, base })
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

    // Refuse before touching anything. Sessions have to die before git will
    // remove the directory, but killing them and only then discovering that git
    // refuses would leave the worktree intact and its work in progress gone.
    if (!opts.force) {
      const dirty = await dirtyCount(worktree.path)
      if (dirty > 0) {
        throw new HttpError(
          400,
          `${worktree.path} has ${dirty} uncommitted change${dirty === 1 ? '' : 's'}. ` +
            'Discard them to remove it.',
          'worktree-dirty',
          { dirty },
        )
      }
    }

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

/**
 * Directories that are heavy, machine-generated and nearly always unwanted in a
 * first commit. Reported so the client can warn before `git add -A` sweeps one
 * in, which is tedious to undo once committed.
 */
const JUNK_DIRECTORIES = [
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.next',
  'vendor',
  '__pycache__',
]

/** What the client needs to describe initialising an existing directory. */
const inspectForInit = async (
  target: string,
): Promise<{ entries: number; hasGitignore: boolean; junk: string[] }> => {
  try {
    const names = await readdir(target)
    return {
      entries: names.length,
      hasGitignore: names.includes('.gitignore'),
      // Only relevant without a .gitignore; with one, `git add -A` honours it.
      junk: names.includes('.gitignore') ? [] : names.filter((n) => JUNK_DIRECTORIES.includes(n)),
    }
  } catch {
    return { entries: 0, hasGitignore: false, junk: [] }
  }
}

/**
 * The repository enclosing a path that does not exist yet, found by walking up
 * to the nearest directory that does exist and asking git from there.
 */
const enclosingRepoOf = async (target: string): Promise<string | null> => {
  let current = resolve(target)
  for (;;) {
    if (await isDirectory(current)) return enclosingRepoRoot(current)
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
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
