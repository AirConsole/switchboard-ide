import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import type { AppSnapshot, Session } from '@switchboard/shared'
import { PROTOCOL_VERSION } from '@switchboard/shared'
import { makeRepoWithCommit, type TempRepo } from './helpers/repo.js'
import { hostKeyFor } from '../src/remote/scope.js'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-remote-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { Workspace } = await import('../src/workspace.js')
type SessionEngine = ConstructorParameters<typeof Workspace>[1]

const engine = { list: (): Session[] => [], killForProject: async () => {} } as unknown as SessionEngine

/**
 * A stand-in peer: the few routes a gateway reads, over real HTTP.
 *
 * Real HTTP rather than a mocked `fetch`, because what is being tested is the
 * boundary itself -- scoping, selection and what happens when the other side
 * simply stops answering.
 */
const peer = Fastify()
let peerUrl = ''
let peerSnapshot: AppSnapshot
let answering = true

peer.addHook('onRequest', async (_request, reply) => {
  if (!answering) {
    // Not a 500: a machine that is off refuses the connection, and the point is
    // that the gateway treats any failure to answer the same way.
    await reply.hijack()
    reply.raw.destroy()
  }
})
peer.get('/api/server', async () => ({ name: 'peer', protocolVersion: PROTOCOL_VERSION }))
let reads = 0
/** Set when the fake peer is asked without the gateway's own loop guard. */
let unguardedReads = 0
const slept: string[] = []
peer.post('/api/worktrees/:id/sleep', async (request) => {
  slept.push((request.params as { id: string }).id)
  return { ok: true }
})
peer.get('/api/snapshot', async (request) => {
  reads++
  if (request.headers['x-swb-peer-read'] === undefined) unguardedReads++
  return peerSnapshot
})

await peer.listen({ host: '127.0.0.1', port: 0 })
peerUrl = `http://127.0.0.1:${(peer.server.address() as AddressInfo).port}`

afterAll(async () => {
  await peer.close()
  await rm(stateDir, { recursive: true, force: true })
})

let repo: TempRepo
let store: InstanceType<typeof StateStore>
let workspace: InstanceType<typeof Workspace>

beforeEach(async () => {
  answering = true
  /*
   * `stateFile` is one path for the whole file -- it is derived from config at
   * import time -- so a store left holding projects is inherited by the next
   * test through the debounced write it eventually lands. Flushed and deleted
   * rather than ignored: without this the suite passed alone and failed in a
   * full run, which is the worst way to find out.
   */
  await store?.flush()
  await rm(join(stateDir, 'state.json'), { force: true })
  repo = await makeRepoWithCommit()
  store = new StateStore()
  await store.load()
  workspace = new Workspace(store, engine)
  // The peer's own ids are bare -- it has no idea anyone remote is asking.
  peerSnapshot = {
    projects: [
      { id: 'p-peer', name: 'ide', host: { kind: 'local' }, root: '/srv/ide', worktreeRoot: '/srv/ide/.claude/worktrees', addedAt: 1 },
      // A project on the peer we never registered, and its pointer to a third
      // machine at the same path we did register.
      { id: 'p-other', name: 'other', host: { kind: 'local' }, root: '/srv/other', worktreeRoot: '', addedAt: 1 },
      { id: 'p-third', name: 'ide', host: { kind: 'remote', baseUrl: 'http://third' }, root: '/srv/ide', worktreeRoot: '', addedAt: 1 },
    ],
    worktrees: [
      { id: 'wt-a', projectId: 'p-peer', name: 'main', branch: 'main', path: '/srv/ide', isMain: true },
      { id: 'wt-b', projectId: 'p-other', name: 'main', branch: 'main', path: '/srv/other', isMain: true },
    ],
    sessions: [{ id: 's-a', worktreeId: 'wt-a' } as Session, { id: 's-b', worktreeId: 'wt-b' } as Session],
    todos: [{ id: 't-a', worktreeId: 'wt-a', prompt: 'go', createdAt: 1 }],
    // The peer's layout, which must never reach ours.
    ui: { ...store.ui, panels: { 'wt-a': ['files'] } },
  }
})

/** A machine is registered before a project on it can be; see `addServer`. */
const addRemote = async (root = '/srv/ide') => {
  if (!store.server(peerUrl)) await workspace.addServer({ baseUrl: peerUrl, token: 'tok' })
  return workspace.openRemoteProject({ baseUrl: peerUrl, root })
}

describe('a project on another machine', () => {
  it('registers a project without touching the network or the disk', async () => {
    await workspace.addServer({ baseUrl: peerUrl, token: 'tok' })
    answering = false
    // Registering must not fail because the peer is momentarily down: that is
    // exactly when you are trying to add it.
    const project = await addRemote()
    expect(project.host).toMatchObject({ kind: 'remote', baseUrl: peerUrl })
    // Never repaired against this machine's cwd or home -- the path is theirs.
    expect(project.root).toBe('/srv/ide')
  })

  it('refuses a path that is not absolute, rather than resolving it here', async () => {
    await expect(addRemote('srv/ide')).rejects.toThrow(/absolute/)
  })

  it('refuses a project on a machine it has never been told about', async () => {
    await expect(
      workspace.openRemoteProject({ baseUrl: peerUrl, root: '/srv/ide' }),
    ).rejects.toThrow(/no such server/)
  })

  /*
   * The credential lives with the machine, once, and never on a project --
   * `Project` is in every snapshot the browser receives. The type forbids it
   * now; this checks the registry does not leak it by another route.
   */
  it('never puts a credential anywhere a client can see', async () => {
    await addRemote()
    const snapshot = await workspace.snapshot()
    expect(JSON.stringify(snapshot)).not.toContain('tok')
    expect(store.server(peerUrl)?.token).toBe('tok')
  })

  /*
   * The trap this design exists to avoid. git would not fail on a remote
   * project's root -- it would *answer*, about whatever sits at that path on
   * this machine, and the same checkout path on two machines is the normal
   * case. The ids would then collide byte for byte.
   */
  it('never asks local git about a remote project', async () => {
    await workspace.openProject(repo.path)
    const localCount = (await workspace.worktrees()).length
    // The same path again, as a project that lives on the peer.
    await addRemote(repo.path)
    workspace.invalidate()
    expect(await workspace.worktrees()).toHaveLength(localCount)
  })

  it('refuses to create a worktree in it', async () => {
    const project = await addRemote()
    await expect(
      workspace.createWorktree({ projectId: project.id, branch: 'x' }),
    ).rejects.toThrow(/another machine/)
  })

  it('merges only the projects we registered, under our own id', async () => {
    const pointer = await addRemote()
    const snapshot = await workspace.snapshot()

    const remote = snapshot.projects.filter((p) => p.host.kind === 'remote')
    // Our pointer's id, not the peer's `p-peer`: it is derived from the root
    // and the base URL, so it exists even when the peer does not answer.
    expect(remote.map((p) => p.id)).toEqual([pointer.id])
    // `p-other` is the peer's own business and must not appear on our screen.
    expect(snapshot.projects.map((p) => p.name)).not.toContain('other')

    expect(snapshot.worktrees.map((w) => w.id)).toEqual([`${hostKeyFor(peerUrl)}~wt-a`])
    expect(snapshot.worktrees[0]?.projectId).toBe(pointer.id)
    expect(snapshot.sessions.map((s) => s.id)).toEqual([`${hostKeyFor(peerUrl)}~s-a`])
    expect(snapshot.todos.map((t) => t.id)).toEqual([`${hostKeyFor(peerUrl)}~t-a`])
  })

  it('takes the peer’s own project at that path, not its pointer to a third machine', async () => {
    // Peered both ways, a peer holds a local project and a remote one at the
    // same root. Picking whichever came first is a coin toss that swaps.
    await addRemote()
    const snapshot = await workspace.snapshot()
    expect(snapshot.worktrees).toHaveLength(1)
    expect(snapshot.worktrees[0]?.name).toBe('main')
  })

  it('keeps its own layout and never adopts the peer’s', async () => {
    await addRemote()
    const snapshot = await workspace.snapshot()
    // The peer's `ui` names `wt-a` and would otherwise land on an id that is
    // not even spelled the same here.
    expect(snapshot.ui.panels).not.toHaveProperty('wt-a')
    expect(snapshot.ui).toEqual(store.ui)
  })

  /*
   * The failure that costs the user something permanent. The UI prunes stored
   * layout for worktrees it no longer sees, so "that machine is off" reading as
   * "those worktrees are gone" deletes panels and open files for good.
   */
  it('holds what a peer last said when it stops answering', async () => {
    await addRemote()
    const before = await workspace.snapshot()
    expect(before.worktrees).toHaveLength(1)

    answering = false
    const during = await workspace.snapshot()
    expect(during.worktrees.map((w) => w.id)).toEqual(before.worktrees.map((w) => w.id))
  })

  /*
   * The cache is a memory of a machine, not a record of what is registered.
   * Returned whole, it was authoritative about both -- so a project closed
   * while its peer was down came back on the next snapshot, and could not be
   * closed again until the machine answered.
   */
  it('does not resurrect a project closed while its peer was down', async () => {
    const pointer = await addRemote()
    expect((await workspace.snapshot()).worktrees).toHaveLength(1)

    answering = false
    await workspace.closeProject(pointer.id)

    const after = await workspace.snapshot()
    expect(after.projects.map((p) => p.id)).not.toContain(pointer.id)
    expect(after.worktrees).toHaveLength(0)
  })

  /* And the mirror image: a project opened while it was down must still show. */
  it('shows a project opened while its peer was down', async () => {
    await addRemote('/srv/ide')
    await workspace.snapshot() // one good read, so there is a cache to hold

    answering = false
    const second = await workspace.openRemoteProject({ baseUrl: peerUrl, root: '/srv/other' })
    const after = await workspace.snapshot()
    expect(after.projects.map((p) => p.id)).toContain(second.id)
    // The one we did read keeps its worktrees; the new one has none to show.
    expect(after.worktrees.map((w) => w.projectId)).not.toContain(second.id)
  })

  /*
   * A machine with nothing open on it contributes nothing to the merge, and
   * asking it anyway costs the full request timeout on *every* snapshot --
   * which is refetched on every invalidate. One laptop with its lid shut made
   * the whole row sluggish, local worktrees included.
   */
  it('does not call a machine that has no project open on it', async () => {
    await workspace.addServer({ baseUrl: peerUrl, token: 'tok' })
    reads = 0
    await workspace.snapshot()
    expect(reads).toBe(0)

    await workspace.openRemoteProject({ baseUrl: peerUrl, root: '/srv/ide' })
    await workspace.snapshot()
    expect(reads).toBe(1)
  })

  /*
   * `lastGood` in memory only held the guarantee *after* one successful read,
   * and the case that costs the user something is the other one: a gateway that
   * starts before its peer is listening reports zero worktrees, and the UI
   * prunes stored layout for worktrees it cannot see -- panels, open files and
   * the expanded tree, written back and gone for good.
   */
  /*
   * Two instances pointed at each other is an expected configuration -- see
   * `selectProjects`, which exists to tell a peer's own project from its
   * pointer back to us. Without a guard, one `GET /api/snapshot` recursed until
   * the 5s timeouts fired at the leaves: measured at 8,500 requests and five
   * seconds of pegged CPU, and self-sustaining, because the browser refetches
   * on every invalidate and the git poll fires every four seconds.
   *
   * The guard is a header, and the work it skips was never wanted: we keep only
   * the projects a peer holds locally, so its view of third machines is
   * computed and then thrown away on arrival.
   */
  it('tells a peer not to go round again, on every read', async () => {
    await addRemote()
    unguardedReads = 0
    await workspace.snapshot()
    expect(reads).toBeGreaterThan(0)
    expect(unguardedReads).toBe(0)
  })

  it('answers a gateway with its own world only', async () => {
    await addRemote()
    // What a peer returns when *we* are the peer being read.
    const asPeer = await workspace.snapshot({ localOnly: true })
    expect(asPeer.worktrees.filter((w) => w.id.includes('~'))).toHaveLength(0)
    expect(asPeer.projects.filter((p) => p.host.kind === 'remote')).toHaveLength(0)
  })

  /*
   * "Sleep" on a remote project can only mean asking the peer. Without this the
   * box was ticked, the pointer went, and the peer's agents carried on running
   * with nothing on screen owning them -- the state `closeProject` exists to
   * avoid.
   */
  it('asks the peer to sleep a remote project\u2019s worktrees', async () => {
    const pointer = await addRemote()
    await workspace.snapshot()
    slept.length = 0
    await workspace.closeProject(pointer.id, { sleep: true })
    expect(slept).toEqual(['wt-a'])
  })

  it('refuses to forget a machine while its projects are open', async () => {
    await addRemote()
    // One misclick on a small x would otherwise close every project on it,
    // prune their layout and leave no way back but retyping everything.
    expect(() => workspace.removeServer(peerUrl)).toThrow(/close the project/)
    expect(store.server(peerUrl)).toBeDefined()
  })

  it('forgets a machine once nothing is open on it', async () => {
    const pointer = await addRemote()
    await workspace.closeProject(pointer.id)
    workspace.removeServer(peerUrl)
    expect(store.server(peerUrl)).toBeUndefined()
  })

  it('remembers what a peer said across a restart of this server', async () => {
    await addRemote()
    expect((await workspace.snapshot()).worktrees).toHaveLength(1)
    await store.flush()

    // A fresh process: same state file, nothing in memory, and the peer is off.
    answering = false
    const restarted = new StateStore()
    await restarted.load()
    const after = await new Workspace(restarted, engine).snapshot()

    expect(after.worktrees.map((w) => w.id)).toEqual([`${hostKeyFor(peerUrl)}~wt-a`])
    // Liveness is a live fact: a remembered session would claim an agent was
    // running on a machine that is switched off.
    expect(after.sessions).toHaveLength(0)
  })

  /*
   * Amber and green are the two things a row of agents is scanned for, so they
   * are the two that must never be recalled. Measured before this: unplug a
   * peer with an agent waiting on you and the bullet stayed amber, indefinitely,
   * for something that was not running -- and clicking it 504s. `cachedSlice`
   * said as much already; `lastGood` is the commoner path and did not.
   */
  it('never reports a session on a machine that did not answer', async () => {
    await addRemote()
    const before = await workspace.snapshot()
    expect(before.sessions.map((s) => s.id)).toEqual([`${hostKeyFor(peerUrl)}~s-a`])

    answering = false
    const during = await workspace.snapshot()
    // The worktrees stay -- losing those costs the user their layout -- but
    // nothing claims an agent is alive, or blocked on them, on a machine
    // that is off.
    expect(during.worktrees).toHaveLength(1)
    expect(during.sessions).toEqual([])
  })

  /*
   * All the protection was on the exception path, and "answered, but empty" is
   * the commoner shape of the same loss: someone closes the project in the
   * peer's own UI, or one `listWorktrees` throws on an index.lock, and the
   * reply is a clean 200 with nothing in it.
   */
  it('keeps what it knew when a peer answers without the project', async () => {
    await addRemote()
    expect((await workspace.snapshot()).worktrees).toHaveLength(1)

    // The peer still answers; it simply no longer lists that project.
    peerSnapshot = { ...peerSnapshot, projects: [], worktrees: [] }
    const after = await workspace.snapshot()
    expect(after.worktrees.map((w) => w.id)).toEqual([`${hostKeyFor(peerUrl)}~wt-a`])
  })

  /*
   * The commoner shape, and the one the first version of this guard missed: the
   * project is listed and its worktrees are not. That is what a single
   * `listWorktrees` throwing on an index.lock produces, because the peer
   * catches per project and carries on -- a clean 200 with the project present
   * and nothing under it. A registered repository always has at least its main
   * worktree, so "none" means the enumeration failed.
   */
  it('keeps what it knew when a peer lists the project but no worktrees', async () => {
    await addRemote()
    expect((await workspace.snapshot()).worktrees).toHaveLength(1)

    peerSnapshot = { ...peerSnapshot, worktrees: [] }
    const after = await workspace.snapshot()
    expect(after.worktrees.map((w) => w.id)).toEqual([`${hostKeyFor(peerUrl)}~wt-a`])
    // And the push filter goes on recognising that session, or a blocked agent
    // over there stops lighting amber here.
    expect(workspace.knowsSession(`${hostKeyFor(peerUrl)}~s-a`)).toBe(true)
  })

  /*
   * Both memories, or the in-memory one shadows the cleared store entry for the
   * life of the process.
   */
  it('does not resurrect worktrees after a machine\u2019s last project closes', async () => {
    const pointer = await addRemote()
    await workspace.snapshot()

    await workspace.closeProject(pointer.id)
    await workspace.snapshot()

    answering = false
    const reopened = await workspace.openRemoteProject({ baseUrl: peerUrl, root: '/srv/ide' })
    const after = await workspace.snapshot()
    expect(after.projects.map((p) => p.id)).toContain(reopened.id)
    expect(after.worktrees).toHaveLength(0)
  })

  it('still shows the project when a peer has never answered', async () => {
    // A cold start with the peer down: nothing is remembered, and the tab has
    // to survive anyway or the project looks deleted rather than unreachable.
    await workspace.addServer({ baseUrl: peerUrl, token: 'tok' })
    answering = false
    const pointer = await workspace.openRemoteProject({ baseUrl: peerUrl, root: '/srv/ide' })
    const snapshot = await workspace.snapshot()
    expect(snapshot.projects.map((p) => p.id)).toContain(pointer.id)
    expect(snapshot.worktrees).toHaveLength(0)
  })
})
