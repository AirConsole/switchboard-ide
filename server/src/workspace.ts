import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { customAlphabet } from 'nanoid'
import type {
  AppSnapshot,
  FileContent,
  FileHit,
  FileListing,
  FileSaved,
  FileUnchanged,
  Project,
  RecentProject,
  Worktree,
  WorktreeTodo,
  RemoteServer,
} from '@switchboard/shared'
import { HttpError } from './http-error.js'
import { PeerClient, normalizeBaseUrl } from './remote/peer.js'
import { findFiles, listDirectory, readTextFile, writeTextFile } from './files.js'
import type { StateStore } from './state.js'
import type { SessionEngine } from './session/engine.js'
import {
  addWorktree,
  defaultWorktreeRoot,
  deleteBranch,
  defaultBranchRef,
  dirtyCount,
  unmergedCount,
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

/** Opaque, unlike a worktree id: nothing derives a todo from its path. */
const newTodoId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10)


/**
 * Ties the three sources of truth together: the state store (projects + UI),
 * git (worktrees) and the session engine (terminals).
 */

const emptySlice = (): Omit<AppSnapshot, 'ui'> => ({
  projects: [],
  worktrees: [],
  sessions: [],
  todos: [],
})

/**
 * The part of a peer's world that belongs to the projects we registered there.
 *
 * Matched on `root`, and on the peer's *own* project rather than its pointer to
 * a third machine: with two instances peered both ways, a peer holds both a
 * local project at `/src/ide` and a pointer to ours at the same path, and
 * picking whichever came first is a coin toss that swaps under you.
 *
 * **The project keeps our pointer's id, not the peer's.** That id is derived
 * from the root and the base URL, so it exists whether or not the peer answers
 * -- which is what lets an unreachable machine still have a tab, with its
 * worktrees missing, instead of the project itself disappearing on a cold
 * start. It is also the id the browser sends back to close the project, and
 * that has to address the pointer, which is the only part of it we own.
 *
 * Ids arriving here are already scoped by `PeerClient`, so the roots compare as
 * paths and everything else compares as scoped ids.
 */
const selectProjects = (
  snapshot: Omit<AppSnapshot, 'ui'>,
  pointers: readonly Project[],
  host: string,
): Omit<AppSnapshot, 'ui'> => {
  const projects: Project[] = []
  /** The peer's id for a project, mapped to ours. */
  const asOurs = new Map<string, string>()
  for (const pointer of pointers) {
    const theirs = snapshot.projects.find(
      (project) => project.root === pointer.root && project.host.kind === 'local',
    )
    projects.push({
      ...(theirs ?? pointer),
      id: pointer.id,
      host: { kind: 'remote', baseUrl: host },
    })
    if (theirs) asOurs.set(theirs.id, pointer.id)
  }

  const worktrees = snapshot.worktrees
    .filter((worktree) => asOurs.has(worktree.projectId))
    .map((worktree) => ({ ...worktree, projectId: asOurs.get(worktree.projectId) as string }))
  const worktreeIds = new Set(worktrees.map((worktree) => worktree.id))
  return {
    projects,
    worktrees,
    sessions: snapshot.sessions.filter((session) => worktreeIds.has(session.worktreeId)),
    todos: snapshot.todos.filter((todo) => worktreeIds.has(todo.worktreeId)),
  }
}

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

  /**
   * Bumped by every invalidate, so a read that started before one cannot cache
   * its stale answer afterwards.
   *
   * The 4s poll takes a git status and a transcript tail per worktree; a
   * mutation landing mid-flight used to be overwritten by that older listing,
   * timestamped with the `now` the poll captured before it began -- so the
   * invalidate that followed sent every client to refetch a snapshot that still
   * had the old worktrees in it, until the TTL lapsed.
   */
  private generation = 0

  invalidate(): void {
    this.cache = null
    this.generation += 1
  }

  /** Signature of everything a client would notice about the worktrees. */
  private static signature(worktrees: Worktree[]): string {
    return worktrees
      .map(
        (w) =>
          `${w.id}:${w.branch ?? ''}:${w.head ?? ''}:${w.dirty ?? 0}:${w.unmerged ?? 0}:` +
          `${w.missing === true}:${w.prompt ?? ''}`,
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
    const generation = this.generation

    const all: Worktree[] = []
    for (const project of this.store.projects) {
      /*
       * A remote project's worktrees belong to the peer, and asking git here
       * would not fail -- it would *answer*, about whatever happens to sit at
       * that path on this machine. The path is the peer's, and the same
       * checkout path is the normal case rather than a coincidence, so the ids
       * would collide byte for byte with the local project's and `resolve()`
       * would return whichever came first. Skipped, not tried and caught.
       */
      if (project.host.kind !== 'local') continue
      try {
        const list = await listWorktrees(project.id, project.root)
        // Once per project, not once per worktree: they share a repository and
        // therefore a default branch.
        const defaultRef = await defaultBranchRef(project.root)
        for (const worktree of list) {
          all.push({
            ...worktree,
            // `undefined` rather than a number when git could not say: the
            // dirty guard in removeWorktree refuses on "unknown", and a zero
            // here would tell it the worktree is clean.
            dirty: (await dirtyCount(worktree.path)) ?? undefined,
            unmerged: await unmergedCount(worktree.path, defaultRef),
            prompt: await lastPrompt(worktree.path),
          })
        }
      } catch {
        // A project whose directory moved or was deleted should not break the
        // whole snapshot; it simply contributes no worktrees.
      }
    }
    if (generation === this.generation) this.cache = { at: now, worktrees: all }
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
    const local: AppSnapshot = {
      projects: await this.describeProjects(),
      worktrees: await this.worktrees(),
      sessions: this.engine.list(),
      todos: this.store.todos,
      ui: this.store.ui,
    }
    const remote = await this.remoteSlices()
    return {
      projects: [...local.projects, ...remote.flatMap((r) => r.projects)],
      worktrees: [...local.worktrees, ...remote.flatMap((r) => r.worktrees)],
      sessions: [...local.sessions, ...remote.flatMap((r) => r.sessions)],
      todos: [...local.todos, ...remote.flatMap((r) => r.todos)],
      // The layout is the viewer's. A peer's `ui` never reaches here -- it is
      // dropped in `PeerClient.snapshot` -- and ours is never sent to one.
      ui: local.ui,
    }
  }

  /**
   * Every machine we can read from, once each.
   *
   * From the server registry rather than from the projects, because a machine
   * is added before any project on it is opened -- that is how you get a
   * listing of its disk to pick one from.
   */
  peers(): PeerClient[] {
    return this.store.servers.map((server) => new PeerClient(server.baseUrl, server.token))
  }

  /** By the short key that appears in a scoped id, not by base URL. */
  peerFor(key: string): PeerClient | null {
    return this.peers().find((peer) => peer.key === key) ?? null
  }

  /**
   * What each peer contributes to the snapshot: the projects we registered
   * there, and everything belonging to them.
   *
   * Only the projects we registered. A peer has its own open projects and its
   * own pointers to third machines, and showing those would put a repository on
   * your screen because somebody else opened it.
   *
   * A peer that does not answer contributes **nothing rather than an absence**,
   * and the difference is the whole of the failure mode: the caller must not be
   * able to tell "that machine is off" from "those worktrees are gone", because
   * the UI prunes layout for worktrees it no longer sees. `lastGood` is what
   * keeps a rebooting peer's windows on screen.
   */
  private async remoteSlices(): Promise<Omit<AppSnapshot, 'ui'>[]> {
    const pointers = new Map<string, Project[]>()
    for (const project of this.store.projects) {
      if (project.host.kind !== 'remote') continue
      pointers.set(project.host.baseUrl, [
        ...(pointers.get(project.host.baseUrl) ?? []),
        project,
      ])
    }

    return Promise.all(
      this.peers().map(async (peer) => {
        const mine = pointers.get(peer.baseUrl) ?? []
        try {
          const slice = selectProjects(await peer.snapshot(), mine, peer.baseUrl)
          this.lastGood.set(peer.baseUrl, slice)
          return slice
        } catch {
          /*
           * Unreachable, refused, or a protocol mismatch. Hold what it last
           * said -- and failing that, still show the projects themselves, with
           * no worktrees under them. The one thing that must not happen is the
           * tab vanishing: the UI prunes stored layout for worktrees it cannot
           * see, so "that machine is off" reading as "those worktrees are gone"
           * costs the user their panels and open files permanently.
           */
          return (
            this.lastGood.get(peer.baseUrl) ?? {
              ...emptySlice(),
              projects: mine.map((pointer) => ({
                ...pointer,
                host: { kind: 'remote' as const, baseUrl: peer.baseUrl },
              })),
            }
          )
        }
      }),
    )
  }

  private readonly lastGood = new Map<string, Omit<AppSnapshot, 'ui'>>()

  /**
   * Projects with their derived base ref attached, so the UI can name the ref a
   * new worktree will branch from instead of describing it vaguely.
   */
  private async describeProjects(): Promise<Project[]> {
    return Promise.all(
      // Local only: a remote project is represented in the snapshot by the
      // peer's own record, scoped, not by the pointer we keep to find it. Two
      // records for one project would be two tabs that never agree, and
      // `resolveDefaultBase` would be reading this machine's disk at the
      // peer's path besides.
      this.store.projects
        .filter((project) => project.host.kind === 'local')
        .map(async (project) => ({
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
    // It is open again, so it is no longer somewhere you have to find.
    this.store.forgetRecent(root)
    this.invalidate()
    return { ...project, defaultBase: await resolveDefaultBase(root).catch(() => undefined) }
  }

  /**
   * Close a project: take it out of the top bar, and optionally stop what it is
   * running.
   *
   * The two are separate because closing is about the registry and nothing
   * else. A project closed with its agents left running is a deliberate thing
   * to do -- they carry on in tmux and re-opening the project adopts them back
   * -- but it is also how sessions end up alive with nothing on screen owning
   * them, which is why the client asks rather than assuming.
   *
   * Sleeping here is all-or-nothing on purpose, unlike sleeping one worktree:
   * that dialog can afford to offer keeping Claude or the terminals, because
   * you are still looking at the worktree afterwards. Here the project is about
   * to leave the interface, so a half-stopped project would be exactly the
   * state nobody can see.
   */
  /**
   * Register a machine, and check we can actually speak to it.
   *
   * The one remote operation that *does* reach out before writing anything:
   * adding a machine is a thing you do once, at a keyboard, and being told
   * straight away that the address is wrong or the version does not match is
   * the whole value of it. Opening a project on it later must not, which is
   * why that is a separate call.
   */
  async addServer(input: { baseUrl: string; token?: string }): Promise<RemoteServer> {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const identity = await new PeerClient(baseUrl, input.token).identify()
    const server: RemoteServer = {
      baseUrl,
      name: identity.name,
      ...(input.token === undefined || input.token === '' ? {} : { token: input.token }),
      addedAt: Date.now(),
    }
    this.store.addServer(server)
    this.invalidate()
    return server
  }

  /** Forget a machine. Its projects go with it -- they address nothing now. */
  removeServer(baseUrl: string): void {
    const normalized = normalizeBaseUrl(baseUrl)
    for (const project of this.store.projects) {
      if (project.host.kind === 'remote' && project.host.baseUrl === normalized) {
        this.store.removeProject(project.id)
      }
    }
    this.store.removeServer(normalized)
    this.invalidate()
  }

  /**
   * Register a project that lives on another machine.
   *
   * This writes a record and performs **no I/O at all**, deliberately.
   * Registering must not fail because a peer is momentarily down -- you would
   * be unable to add the machine you are trying to reach precisely when you
   * most want to -- and the snapshot is where being unreachable is handled,
   * once, for every read.
   *
   * The path is checked and never repaired: `resolve()` or `expandHome()` would
   * fold the peer's path against *this* machine's cwd and home, and the result
   * would look like a path and address nothing.
   */
  async openRemoteProject(input: {
    baseUrl: string
    root: string
    name?: string
  }): Promise<Project> {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    // The credential lives with the machine, so the machine has to be known
    // before a project on it can be. `addServer` is what puts it there.
    if (!this.store.server(baseUrl)) throw new HttpError(404, 'no such server')
    const root = input.root.trim()
    if (!root.startsWith('/')) throw new HttpError(400, 'a remote path must be absolute')

    // Namespaced by base URL, and this is the one caller that passes a host
    // key: `/home/andrin/src/ide` on two machines hashes identically, so
    // without it the pointer and the local project would be one id.
    const id = projectIdFor(root, baseUrl)
    if (this.store.project(id)) throw new HttpError(409, 'that project is already open')

    const project: Project = {
      id,
      name: (input.name ?? '').trim() || basename(root),
      host: { kind: 'remote', baseUrl },
      root,
      worktreeRoot: '',
      addedAt: Date.now(),
    }
    this.store.addProject(project)
    this.invalidate()
    return project
  }

  async closeProject(id: string, opts: { sleep?: boolean } = {}): Promise<void> {
    // Collected before the project goes, because afterwards its worktrees are
    // no longer listed and there is nothing left to match todos against.
    const mine = (await this.worktrees()).filter((w) => w.projectId === id).map((w) => w.id)
    const project = this.store.project(id)
    // Only our own sessions are ours to kill. A remote project's run on the
    // peer, under the peer's ids, and `killForProject` here would match
    // nothing at best -- and the identically-pathed local project's sessions
    // at worst, which is the same aliasing `worktrees()` refuses to risk.
    if (opts.sleep === true && project?.host.kind === 'local') {
      await this.engine.killForProject(id)
    }
    // Remembered before it is removed, and only for a local project: a recent
    // is a path handed back to `openProject`, which is how a local one is
    // opened. A remote project will be reopened by base URL instead.
    if (project && project.host.kind === 'local') this.store.rememberRecent(project)
    this.store.removeProject(id)
    this.store.removeTodosFor(mine)
    this.invalidate()
  }

  async createWorktree(opts: {
    projectId: string
    branch: string
    base?: string
  }): Promise<Worktree> {
    const project = this.store.project(opts.projectId)
    if (!project) throw new HttpError(404, 'no such project')
    /*
     * A remote project's worktrees are made by the peer, through the proxy.
     * Reaching here with one means the routing above it failed, and the cost of
     * not saying so is specific: `worktreeRoot` for a remote pointer is derived
     * from a path on *that* machine, so `ensureWorktreesIgnored` and
     * `addWorktree` would run against whatever repository sits there on this
     * one. A refusal is the cheap half of that.
     */
    if (project.host.kind !== 'local') {
      throw new HttpError(400, 'that project lives on another machine')
    }
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
    // The same trap as the diff route: `base` lands where git parses options,
    // so `--lock` made a worktree the UI could no longer remove.
    if (base.startsWith('-')) throw new HttpError(400, 'that base ref is not a ref')

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
      // Unknown is not clean. Git failing to answer is exactly when killing the
      // sessions first would be worst.
      if (dirty === null) {
        throw new HttpError(
          400,
          `git could not say whether ${worktree.path} has uncommitted changes. ` +
            'Check it by hand, or remove it with force.',
          'worktree-unknown',
        )
      }
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
    this.store.removeTodosFor([worktree.id])
    this.invalidate()
  }

  // --- todos -----------------------------------------------------------------

  /**
   * Free text from a browser, on its way to being typed into a terminal.
   *
   * Every control byte goes, ESC included: without this a prompt could carry
   * its own escape sequences into the TUI -- a literal `ESC[201~` would end the
   * bracketed paste early and hand the rest to the app as keys. Newlines and
   * tabs stay, because they are the point.
   */
  private static clean(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  }

  async createTodo(input: { worktreeId: string; prompt: string }): Promise<WorktreeTodo> {
    // Throws 404 for a worktree that is not there, before anything is stored.
    await this.resolve(input.worktreeId)
    const prompt = Workspace.clean(input.prompt).trim()
    if (prompt === '') throw new HttpError(400, 'a todo needs a prompt')
    const todo: WorktreeTodo = {
      id: newTodoId(),
      worktreeId: input.worktreeId,
      prompt,
      createdAt: Date.now(),
    }
    this.store.addTodo(todo)
    return todo
  }

  /**
   * Edit a todo, or move it in and out of the run queue.
   *
   * `queued` is a boolean on the wire and a timestamp in the store: the client
   * says whether it wants the todo to run, and the server decides where in the
   * queue that puts it. Otherwise two browsers could disagree about the order.
   */
  updateTodo(id: string, patch: { prompt?: string; queued?: boolean }): WorktreeTodo {
    const todo = this.store.todo(id)
    if (!todo) throw new HttpError(404, 'no such todo')
    // Its prompt may already be on its way into Claude; editing it now would
    // change something that has effectively been sent.
    if (todo.dispatchingAt !== undefined) {
      throw new HttpError(409, 'that todo is being sent to Claude', 'todo-dispatching')
    }
    const next: Partial<WorktreeTodo> = {}
    if (patch.prompt !== undefined) {
      const prompt = Workspace.clean(patch.prompt).trim()
      if (prompt === '') throw new HttpError(400, 'a todo needs a prompt')
      next.prompt = prompt
    }
    if (patch.queued !== undefined) {
      next.queuedAt = patch.queued ? this.nextQueuedAt(todo.worktreeId) : undefined
      // Queueing it again is the human saying "try that once more".
      if (patch.queued) next.lastError = undefined
    }
    return this.store.patchTodo(id, next) ?? todo
  }

  deleteTodo(id: string): void {
    const todo = this.store.todo(id)
    if (!todo) throw new HttpError(404, 'no such todo')
    if (todo.dispatchingAt !== undefined) {
      throw new HttpError(409, 'that todo is being sent to Claude', 'todo-dispatching')
    }
    this.store.removeTodo(id)
  }

  /**
   * The next place in a worktree's queue.
   *
   * Strictly after the last one rather than simply `Date.now()`: two clicks
   * inside the same millisecond, or a clock that steps backwards, would
   * otherwise tie and the order of `(1)` and `(2)` would be arbitrary.
   */
  private nextQueuedAt(worktreeId: string): number {
    const last = this.store.todos
      .filter((t) => t.worktreeId === worktreeId && t.queuedAt !== undefined)
      .reduce((max, t) => Math.max(max, t.queuedAt ?? 0), 0)
    return Math.max(Date.now(), last + 1)
  }

  /*
   * A worktree's own files.
   *
   * They come through the funnel like everything else, because this is the
   * interface a remote project would have to implement -- reading a file on
   * another host is a proxy away, and the seam belongs here rather than in a
   * route. The mechanics live in `files.ts`, the way git's live in `git/`.
   */

  /** One directory of a worktree, ignore-filtered. `''` is its root. */
  async fileTree(worktreeId: string, path: string): Promise<FileListing> {
    const { worktree } = await this.resolve(worktreeId)
    return listDirectory(worktree.path, path)
  }

  /**
   * Files whose path matches, anywhere in the worktree.
   *
   * The tree lists one directory at a time on purpose, so it can only show what
   * you have walked to. This is the other half: a way to reach a file whose
   * directory you have never opened.
   */
  async findFiles(
    worktreeId: string,
    query: string,
  ): Promise<{ hits: FileHit[]; truncated?: boolean }> {
    const { worktree } = await this.resolve(worktreeId)
    return findFiles(worktree.path, query)
  }

  /** One file's text, or word that it has not moved since `ifNotRev`. */
  async readFile(
    worktreeId: string,
    path: string,
    ifNotRev?: string,
  ): Promise<FileContent | FileUnchanged> {
    const { worktree } = await this.resolve(worktreeId)
    return readTextFile(worktree.path, path, ifNotRev)
  }

  /** Save a file, refusing if it moved on disk since it was read. */
  async writeFile(
    worktreeId: string,
    path: string,
    text: string,
    ifRev: string,
  ): Promise<FileSaved> {
    const { worktree } = await this.resolve(worktreeId)
    return writeTextFile(worktree.path, path, text, ifRev)
  }

  /**
   * Closed projects the picker can offer back, newest first.
   *
   * Two kinds are filtered out here rather than in the browser, because both
   * questions are the server's to answer: one that is open again is not recent,
   * it is on screen; and one whose directory has gone would send the picker
   * into its "create this project?" proposal, offering to make a repository
   * where a deleted one used to be. Not stat-ing them at rest is the point of
   * doing it here -- this runs when the dialog opens, not on every snapshot.
   */
  async recentProjects(): Promise<RecentProject[]> {
    const open = new Set(this.store.projects.map((p) => p.root))
    const rows = await Promise.all(
      this.store.recents
        .filter((recent) => !open.has(recent.root))
        .map(async (recent) => ((await isDirectory(recent.root)) ? recent : null)),
    )
    return rows.filter((recent): recent is RecentProject => recent !== null)
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
