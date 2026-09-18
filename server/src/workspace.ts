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
  RemoteCache,
} from '@switchboard/shared'
import { HttpError } from './http-error.js'
import { config } from './config.js'
import { PeerClient, PeerUnreachable, basicFrom, normalizeBaseUrl, plainHttpAllowed } from './remote/peer.js'
import { hostKeyFor, unscopeId } from './remote/scope.js'
import {
  findFiles,
  listDirectory,
  mediaFile,
  readTextFile,
  takeableFile,
  writeTextFile,
} from './files.js'
import type { StateStore } from './state.js'
import type { SessionEngine } from './session/engine.js'
import {
  addWorktree,
  defaultWorktreeRoot,
  deleteBranch,
  deleteRemoteBranch,
  remoteBranches,
  defaultBranchRef,
  dirtyCount,
  unmergedCount,
  enclosingRepoRoot,
  ensureWorktreesIgnored,
  initRepository,
  isGitRepo,
  branchExists,
  isValidBranchName,
  listRawWorktrees,
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


/**
 * What a linked machine contributes to the merged snapshot.
 *
 * **Everything it has open**, not a subset we subscribed to. Linking a machine
 * says "what is running there is running here", which is what the row is for:
 * an agent blocked on you is blocked on you wherever it is, and a model where
 * you had to have registered that particular project first could not tell you.
 *
 * Its *local* projects only. A peer has its own links to third machines, and
 * following those would make this transitive -- C's worktrees arriving through
 * B, named by ids B scoped for itself. Non-transitive is also what makes two
 * machines linked to each other terminate rather than recurse.
 *
 * Ids are already scoped by `PeerClient`, so nothing here has to rewrite them:
 * a remote project is known by the peer's own id, which is what lets every
 * route address it through the ordinary proxy.
 */
const localTo = (
  snapshot: Omit<AppSnapshot, 'ui'>,
  baseUrl: string,
  name: string,
): Omit<AppSnapshot, 'ui'> => {
  const projects = snapshot.projects
    .filter((project) => project.host.kind === 'local')
    .map((project) => ({ ...project, host: { kind: 'remote' as const, baseUrl, name } }))
  const mine = new Set(projects.map((project) => project.id))
  const worktrees = snapshot.worktrees.filter((worktree) => mine.has(worktree.projectId))
  const worktreeIds = new Set(worktrees.map((worktree) => worktree.id))
  return {
    projects,
    worktrees,
    sessions: snapshot.sessions.filter((session) => worktreeIds.has(session.worktreeId)),
    todos: snapshot.todos.filter((todo) => worktreeIds.has(todo.worktreeId)),
  }
}

/**
 * What to show for a machine that did not answer.
 *
 * Its projects and worktrees as we last saw them, and **no sessions**:
 * liveness and attention are live facts, and remembered they claim an agent is
 * running -- and, worse, that one is *blocked on you* -- on a machine that is
 * switched off. Measured: unplug a peer with an agent waiting and the amber
 * stayed indefinitely for something that was not there. Amber and green are
 * the two things the row is scanned for, so they are the two that must never
 * be recalled.
 *
 * Shown at all, rather than dropped, because the UI prunes stored layout for
 * worktrees it cannot see -- so "that machine is off" reading as "those
 * worktrees are gone" costs panels and open files permanently.
 */
const remembered = (
  cached: { projects: Project[]; worktrees: Worktree[] } | undefined,
): Omit<AppSnapshot, 'ui'> => ({
  projects: cached?.projects ?? [],
  worktrees: cached?.worktrees ?? [],
  sessions: [],
  todos: [],
})

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
          // A branch appearing on or vanishing from a remote changes what the
          // removal dialog asks, so it is part of "something changed here".
          `${w.remoteBranch ?? ''}:${w.remoteBranchMerged === true ? 'm' : ''}:` +
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
      try {
        const list = await listWorktrees(project.id, project.root)
        this.forgetGoneWorktrees(project.id, list)
        // Once per project, not once per worktree: they share a repository and
        // therefore a default branch.
        const defaultRef = await defaultBranchRef(project.root)
        // Likewise once per project: `refs/remotes` is the repository's, and
        // every worktree of it reads its own branch out of the same answer.
        const remotes = await remoteBranches(project.root, defaultRef)
        for (const worktree of list) {
          const remote = worktree.branch === null ? undefined : remotes.get(worktree.branch)
          all.push({
            ...worktree,
            // `undefined` rather than a number when git could not say: the
            // dirty guard in removeWorktree refuses on "unknown", and a zero
            // here would tell it the worktree is clean.
            dirty: (await dirtyCount(worktree.path)) ?? undefined,
            unmerged: await unmergedCount(worktree.path, defaultRef),
            remoteBranch: remote?.ref,
            remoteBranchMerged: remote?.merged,
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

  /** See `Worktree.awake`, and `PersistedState.awake` for the null case. */
  private isAwake(worktreeId: string): boolean {
    const awake = this.store.awake
    if (awake === null) return this.engine.listForWorktree(worktreeId).length > 0
    return awake.includes(worktreeId)
  }

  /**
   * Wake or sleep worktrees of this machine.
   *
   * The first call seeds the list from what `isAwake` has been answering, so a
   * machine that never recorded anything does not put every running worktree
   * to sleep the moment one of them is touched.
   */
  async setAwake(worktreeIds: string[], awake: boolean): Promise<void> {
    /*
     * One at a time. The seed awaits the worktree list, so two first-ever
     * changes landing together -- two tabs, or opening a project while
     * clicking another worktree -- both seeded from the same starting list and
     * the second write dropped the first: measured, waking `wt-a` and `wt-b`
     * at once stored only `wt-b`.
     */
    const turn = this.awakeWrites.then(async () => {
      const current =
        this.store.awake ??
        (await this.worktrees()).filter((w) => this.isAwake(w.id)).map((w) => w.id)
      const next = awake
        ? [...current, ...worktreeIds]
        : current.filter((id) => !worktreeIds.includes(id))
      this.store.setAwake(next)
    })
    this.awakeWrites = turn.catch(() => {})
    return turn
  }

  private awakeWrites: Promise<void> = Promise.resolve()

  /** Each open project's worktree ids as last listed; see `forgetGoneWorktrees`. */
  private readonly listed = new Map<string, Set<string>>()

  /**
   * Drop the awake mark of a worktree that has gone from its project.
   *
   * Removing one through the IDE clears it, but an agent running `git worktree
   * remove` itself is routine here, and ids are hashed from the path -- so the
   * same branch made again later came back awake, a window with nothing
   * running in it. Only on a listing that succeeded, and only for ids this
   * project listed before: a closed project's marks are kept on purpose, since
   * reopening it picks them back up. A worktree removed while the server was
   * down is not caught; nothing here saw it.
   */
  private forgetGoneWorktrees(projectId: string, list: readonly { id: string }[]): void {
    const now = new Set(list.map((w) => w.id))
    const before = this.listed.get(projectId)
    this.listed.set(projectId, now)
    const awake = this.store.awake
    if (before === undefined || awake === null) return
    const gone = [...before].filter((id) => !now.has(id))
    if (gone.length > 0 && awake.some((id) => gone.includes(id))) {
      this.store.setAwake(awake.filter((id) => !gone.includes(id)))
    }
  }

  async resolve(worktreeId: string): Promise<{ worktree: Worktree; project: Project }> {
    const worktree = (await this.worktrees()).find((w) => w.id === worktreeId)
    if (!worktree) throw new HttpError(404, 'no such worktree')
    const project = this.store.project(worktree.projectId)
    if (!project) throw new HttpError(404, 'no such project')
    return { worktree, project }
  }

  /**
   * Everything this browser needs, merged across every machine.
   *
   * `localOnly` is what a peer answers with, and it is a loop guard as much as
   * an optimisation. Without it two instances peered at each other -- which
   * `localTo` says outright is an expected configuration -- turn one
   * snapshot into a recursion that only unwinds when the 5s timeouts fire at
   * the leaves: measured, **8,500 requests and five seconds of pegged CPU from
   * a single `GET /api/snapshot`**, self-sustaining because the browser
   * refetches on every invalidate and the git poll fires every four seconds.
   * Adding your own URL as a machine does it on one box.
   *
   * The work skipped was never wanted anyway: `localTo` keeps only the
   * projects a peer holds *locally*, so a peer's own view of third machines is
   * computed and then discarded on arrival.
   */
  async snapshot(opts: { localOnly?: boolean } = {}): Promise<AppSnapshot> {
    const local: AppSnapshot = {
      projects: await this.describeProjects(),
      // Stamped after the cache, which lives two seconds: a wake read through
      // it would show the window a beat after the click that asked for it.
      worktrees: (await this.worktrees()).map((worktree) => ({
        ...worktree,
        awake: this.isAwake(worktree.id),
      })),
      sessions: this.engine.list(),
      todos: this.store.todos,
      ui: this.store.ui,
    }
    const remote = opts.localOnly === true ? [] : await this.remoteSlices()
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
    return this.store.servers.map(
      (server) => new PeerClient(server.baseUrl, server.token, server.basic),
    )
  }

  /**
   * Whether a scoped session id is one the merged snapshot carries.
   *
   * What the relay uses to decide which of a peer's pushes are ours to pass on.
   * Read from the last merge rather than by asking the peer: a push arrives
   * between snapshots, and a session the snapshot has never mentioned is one
   * whose project we did not open.
   */
  knowsSession(scopedId: string): boolean {
    for (const slice of this.lastGood.values()) {
      if (slice.sessions.some((session) => session.id === scopedId)) return true
    }
    return false
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
  /**
   * What every linked machine is running, merged in.
   *
   * One read per machine, in parallel, and a machine that does not answer
   * contributes what it last said rather than nothing -- see `remembered`.
   * There is no per-project subscription to reconcile against any more: a
   * machine is linked or it is not, and linking means all of it.
   */
  private async remoteSlices(): Promise<Omit<AppSnapshot, 'ui'>[]> {
    return Promise.all(
      this.peers().map(async (peer) => {
        try {
          const slice = localTo(
            await peer.snapshot(),
            peer.baseUrl,
            this.store.server(peer.baseUrl)?.name ?? peer.baseUrl,
          )
          this.lastGood.set(peer.baseUrl, slice)
          this.refused.delete(peer.baseUrl)
          /*
           * Written through, so the guarantee survives this process. In memory
           * alone it only held *after* one successful read, and the case that
           * costs the user something is the other one: a gateway that starts
           * before its peer is listening reports zero worktrees, and the UI
           * prunes the layout of every worktree on it, permanently.
           *
           * Only on a change: `snapshot()` is a GET that runs several times a
           * minute per tab, and `scheduleSave` has no maximum wait, so writing
           * every time starves the save a just-queued todo depends on.
           */
          const entry = {
            baseUrl: peer.baseUrl,
            projects: slice.projects,
            worktrees: slice.worktrees,
          }
          if (JSON.stringify(this.store.remoteCache(peer.baseUrl)) !== JSON.stringify(entry)) {
            this.store.setRemoteCache(entry)
          }
          return slice
        } catch (err) {
          // Unreachable, refused, or a protocol mismatch.
          if (err instanceof HttpError && err.code === 'link-refused') this.refused.add(peer.baseUrl)
          /*
           * Through `remembered` whichever memory answers, because it is the
           * one that strips the sessions -- returning `lastGood` directly put
           * them back, and a test written for exactly that caught it here.
           */
          return remembered(this.lastGood.get(peer.baseUrl) ?? this.store.remoteCache(peer.baseUrl))
        }
      }),
    )
  }

  private readonly lastGood = new Map<string, Omit<AppSnapshot, 'ui'>>()

  /**
   * Machines that answered but no longer accept this one's link token.
   *
   * Remembered so the picker can say "link it again" rather than leave a
   * machine looking merely quiet: its worktrees stay on screen from the last
   * good read either way, and without this nothing says the fix is to type its
   * password once more. Cleared by the next read that succeeds.
   */
  private readonly refused = new Set<string>()

  linkRefused(baseUrl: string): boolean {
    return this.refused.has(normalizeBaseUrl(baseUrl))
  }

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
  async addServer(input: { baseUrl: string; password?: string; token?: string }): Promise<RemoteServer> {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    /*
     * Taken out of the address before anything else sees it. `normalizeBaseUrl`
     * would drop it silently and `fetch()` refuses a URL that carries it, so
     * `https://user:pw@machine` used to mean "type a password and watch it
     * vanish, then get a bare 401 from the proxy with no hint why".
     */
    const basic = basicFrom(input.baseUrl)
    /*
     * 504, not 500. The proxy goes to trouble to make this distinction --
     * "that machine did not answer" rather than "this one is broken" -- and
     * the one place a human types an address was the place that did not,
     * because `PeerUnreachable` is not an `HttpError` and Fastify defaults.
     */
    const unreachable = (err: unknown): never => {
      if (err instanceof PeerUnreachable) throw new HttpError(504, err.message, 'unreachable')
      throw err
    }

    let token = input.token
    if (input.password !== undefined) {
      /*
       * One password opens a whole machine, so a typo in the address is the
       * password sent wherever the typo points. Refused before anything is
       * sent, not after.
       */
      if (!plainHttpAllowed(new URL(baseUrl))) {
        throw new HttpError(
          400,
          'that address would send the password in clear over a network you may not own -- use https://, or a name on your own network',
          'insecure-link',
        )
      }
      const anonymous = new PeerClient(baseUrl, undefined, basic)
      // Health first: an address that is off or wrong is told apart from a
      // wrong password, and never receives the password at all.
      await anonymous.health().catch(unreachable)
      token = await anonymous.login(input.password).catch((err: unknown): never => {
        if (err instanceof HttpError && err.code === 'bad-password') {
          // Not 401: the page asking is signed in here, and a 401 is how it
          // learns that it is not.
          throw new HttpError(400, 'that machine did not take the password', 'bad-password')
        }
        if (err instanceof HttpError && err.code === 'password-not-set') {
          throw new HttpError(409, 'that machine has no password yet -- run `pnpm password` on it', 'peer-password-not-set')
        }
        return unreachable(err)
      })
    }
    if (token === undefined) throw new HttpError(400, 'that machine’s password', 'bad-request')
    const identity = await new PeerClient(baseUrl, token, basic).identify().catch(unreachable)
    /*
     * Not this machine. Linking one to itself is accepted at every other step
     * and is a meltdown: the relay opens a socket to itself, which is accepted
     * as a client and given a relay of its own -- 1,447 sockets in five
     * seconds, measured. Compared by instance id rather than by address,
     * because the address is exactly what is being got wrong.
     */
    const isSelf =
      identity.instanceId === undefined
        ? // A machine old enough to send no instance id still must not be
          // linked to itself, and the address is what is left to compare. It
          // catches the spelling someone would actually type, which is the
          // mistake this guard is for; a different one for the same machine
          // gets through, and no longer melts anything down when it does.
          config.publicOrigins.has(baseUrl)
        : identity.instanceId === config.instanceId
    if (isSelf) throw new HttpError(400, 'that is this machine', 'server-is-self')
    const server: RemoteServer = {
      baseUrl,
      name: identity.name,
      token,
      ...(basic === undefined ? {} : { basic }),
      addedAt: Date.now(),
    }
    this.store.addServer(server)
    // Linking again is the fix for a refusal; say so now, not on the next read.
    this.refused.delete(baseUrl)
    this.invalidate()
    return server
  }

  /**
   * Unlink a machine: stop asking it anything.
   *
   * Nothing of that machine's is closed, because nothing of it was ever ours --
   * its projects simply stop appearing here, and are still open there. That is
   * what makes this safe to do from a small x, where the old model had to
   * refuse while projects were open because forgetting the link would have
   * taken local pointer records with it.
   */
  removeServer(baseUrl: string): void {
    const normalized = normalizeBaseUrl(baseUrl)
    this.store.removeServer(normalized)
    // Or the memory of it outlives the link and reappears if it is re-added.
    this.lastGood.delete(normalized)
    this.refused.delete(normalized)
    this.store.clearRemoteCache(normalized)
    this.invalidate()
  }

  async closeProject(id: string, opts: { sleep?: boolean } = {}): Promise<void> {
    /*
     * Local projects only, now that a remote one is closed on the machine it
     * lives on: its id is that machine's own, so the proxy sends this very
     * request there and the peer runs this very method. Which is the whole
     * point of linking -- there is no pointer of ours to remove, and "close" on
     * a remote project means what it says rather than "stop showing it here".
     */
    // Collected before the project goes, because afterwards its worktrees are
    // no longer listed and there is nothing left to match todos against.
    const mine = (await this.worktrees()).filter((w) => w.projectId === id).map((w) => w.id)
    const project = this.store.project(id)
    if (opts.sleep === true) {
      // Stopping everything means nothing of it is awake, so opening it again
      // does not claim agents that were killed. Without `sleep` the set stays,
      // which is what lets reopening pick them up mid-flight.
      await this.setAwake(mine, false)
      await this.engine.killForProject(id)
    }
    // Remembered before it is removed: a recent is a path handed back to
    // `openProject`, which is how one is opened.
    if (project) this.store.rememberRecent(project)
    this.store.removeProject(id)
    this.store.removeTodosFor(mine)
    this.invalidate()
  }

  /**
   * What creating a worktree on this name would do, for the form to say so.
   *
   * `git worktree add` means two different things depending on the answer --
   * check out a branch that is already there, or cut a new one from the default
   * -- and the form asks for a name without saying which it will be. It used to
   * carry a "Branch from" field that made the second case explicit; this tells
   * you instead of asking, which is the same information for none of the width.
   */
  async describeBranch(
    projectId: string,
    name: string,
  ): Promise<{ valid: boolean; exists: boolean; usedBy?: string }> {
    const project = this.store.project(projectId)
    if (!project) throw new HttpError(404, 'no such project')
    const branch = name.trim()
    if (branch === '') return { valid: false, exists: false }
    if (!(await isValidBranchName(project.root, branch))) {
      return { valid: false, exists: false }
    }
    /*
     * A branch can only be checked out in one worktree at a time, so a name
     * already in use is not a slow way to get an error -- it is a thing git
     * will refuse outright ("fatal: '<branch>' is already used by worktree
     * at ..."). Reported here so the form can stop before the button rather
     * than after it, and reported as the *path*, because "already in use" is
     * only useful if you can go and look at what is using it.
     */
    const usedBy = (await listRawWorktrees(project.root).catch(() => [])).find(
      (w) => w.branch === branch,
    )?.path
    return {
      valid: true,
      exists: await branchExists(project.root, branch),
      ...(usedBy === undefined ? {} : { usedBy }),
    }
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
   * Of what is destroyed locally, sessions go first, deliberately: a live shell
   * holding the directory as its cwd leaves tmux reporting `/path (deleted)`
   * and can make git's removal fail or leave the session pointed at a directory
   * that no longer exists. Ahead of all of it, and ahead of the point of no
   * return, goes the branch on the remote.
   */
  async removeWorktree(opts: {
    worktreeId: string
    force: boolean
    alsoDeleteBranch: boolean
    alsoDeleteRemoteBranch: boolean
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

    /*
     * The remote goes first, before anything local is destroyed.
     *
     * It is the only step here that leaves this machine, and so the only one
     * that fails for reasons nothing local can predict: no network, a protected
     * branch, a lease that does not hold. Failing here leaves the worktree, its
     * sessions and its branch exactly as they were and puts git's own words in
     * the dialog. Doing it last would have left the human looking at a closed
     * dialog believing a branch was gone that is still on the remote.
     *
     * It also has to come before the local branch goes: the remote copy is
     * found through `refs/heads/<branch>`, so deleting the branch first leaves
     * nothing to look it up from and the remote branch quietly survives -- the
     * test for "deletes the branch on the remote when asked" fails on exactly
     * that when this block is moved down.
     */
    if (opts.alsoDeleteRemoteBranch && worktree.branch !== null) {
      const defaultRef = await defaultBranchRef(project.root)
      const target = (await remoteBranches(project.root, defaultRef)).get(worktree.branch)
      // Nothing there is not a failure: someone else deleting it first is the
      // outcome that was asked for.
      if (target) {
        try {
          await deleteRemoteBranch(project.root, target)
        } catch (err) {
          throw new HttpError(
            400,
            `${target.ref} was not deleted, so nothing was removed: ${gitMessage(err)}`,
            'remote-branch',
          )
        }
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
    // A removed worktree's id would otherwise sit in the list forever, and a
    // worktree made again at the same path -- same id -- would come back awake.
    if (this.store.awake !== null) this.store.setAwake(this.store.awake.filter((id) => id !== worktree.id))
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
   * Edit a todo, move it in and out of the run queue, or move it to another
   * worktree.
   *
   * `queued` is a boolean on the wire and a timestamp in the store: the client
   * says whether it wants the todo to run, and the server decides where in the
   * queue that puts it. Otherwise two browsers could disagree about the order.
   */
  async updateTodo(
    id: string,
    patch: { prompt?: string; queued?: boolean; worktreeId?: string },
  ): Promise<WorktreeTodo> {
    const todo = this.store.todo(id)
    if (!todo) throw new HttpError(404, 'no such todo')
    // Its prompt may already be on its way into Claude; editing it now would
    // change something that has effectively been sent -- and moving it would
    // park it against an agent that is not the one receiving it.
    if (todo.dispatchingAt !== undefined) {
      throw new HttpError(409, 'that todo is being sent to Claude', 'todo-dispatching')
    }
    const next: Partial<WorktreeTodo> = {}
    if (patch.prompt !== undefined) {
      const prompt = Workspace.clean(patch.prompt).trim()
      if (prompt === '') throw new HttpError(400, 'a todo needs a prompt')
      next.prompt = prompt
    }
    /*
     * Where the todo now lives. Resolved first, so a move to a worktree that is
     * no longer there 404s rather than stranding the todo somewhere nothing
     * lists -- `removeTodosFor` only ever sees ids that are still worktrees.
     */
    const destination = patch.worktreeId ?? todo.worktreeId
    if (patch.worktreeId !== undefined && patch.worktreeId !== todo.worktreeId) {
      await this.resolve(patch.worktreeId)
      next.worktreeId = patch.worktreeId
    }
    /*
     * A queued todo stays queued across a move -- moving it is saying "run that
     * there instead", and silently dropping the one instruction it carries is
     * worse than honouring it. But a place in a queue is only meaningful within
     * one worktree, so it takes a new one at the end of the destination's:
     * keeping the old timestamp would let a todo moved in overtake everything
     * already waiting there.
     */
    if (patch.queued !== undefined) {
      next.queuedAt = patch.queued ? this.nextQueuedAt(destination) : undefined
      // Queueing it again is the human saying "try that once more".
      if (patch.queued) next.lastError = undefined
    } else if (next.worktreeId !== undefined && todo.queuedAt !== undefined) {
      next.queuedAt = this.nextQueuedAt(destination)
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

  /**
   * Where a file the browser can draw itself is, and what to serve it as.
   *
   * The bytes do not come back through here: the route streams them. What the
   * funnel owns is the same thing it owns for every other file operation --
   * which worktree, and therefore which root the path is contained against.
   */
  async mediaFile(
    worktreeId: string,
    path: string,
  ): Promise<{ file: string; type: string; size: number }> {
    const { worktree } = await this.resolve(worktreeId)
    return mediaFile(worktree.path, path)
  }

  /**
   * The same, for a file being taken out of the IDE rather than shown in it.
   *
   * Separate from `mediaFile` because the condition is different, not because
   * the plumbing is -- see `takeableFile`.
   */
  async takeableFile(
    worktreeId: string,
    path: string,
  ): Promise<{ file: string; type: string; size: number }> {
    const { worktree } = await this.resolve(worktreeId)
    return takeableFile(worktree.path, path)
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
