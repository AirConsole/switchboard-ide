import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import type { AppSnapshot, Session } from '@switchboard/shared'
import { PROTOCOL_VERSION } from '@switchboard/shared'
import { hostKeyFor } from '../src/remote/scope.js'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-remote-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { Workspace } = await import('../src/workspace.js')
type SessionEngine = ConstructorParameters<typeof Workspace>[1]

const engine = {
  list: (): Session[] => [],
  killForProject: async () => {},
} as unknown as SessionEngine

/**
 * A stand-in machine: the few routes a gateway reads, over real HTTP.
 *
 * Real HTTP rather than a mocked `fetch`, because what is being tested is the
 * boundary itself -- what is merged, and what happens when the other side
 * stops answering.
 */
const peer = Fastify()
let peerSnapshot: AppSnapshot
let answering = true
let reads = 0
/** Set when the peer is asked without the gateway's own loop guard. */
let unguardedReads = 0

peer.addHook('onRequest', async (_request, reply) => {
  if (!answering) {
    // Not a 500: a machine that is off refuses the connection, and the point is
    // that every failure to answer is treated the same way.
    await reply.hijack()
    reply.raw.destroy()
  }
})
peer.get('/api/server', async () => ({ name: 'peer', protocolVersion: PROTOCOL_VERSION }))
peer.get('/api/snapshot', async (request) => {
  reads++
  if (request.headers['x-swb-peer-read'] === undefined) unguardedReads++
  return peerSnapshot
})

await peer.listen({ host: '127.0.0.1', port: 0 })
const peerUrl = `http://127.0.0.1:${(peer.server.address() as AddressInfo).port}`
const key = hostKeyFor(peerUrl)

afterAll(async () => {
  await peer.close()
  await rm(stateDir, { recursive: true, force: true })
})

let store: InstanceType<typeof StateStore>
let workspace: InstanceType<typeof Workspace>

beforeEach(async () => {
  answering = true
  reads = 0
  unguardedReads = 0
  /*
   * `stateFile` is one path for the whole file -- derived from config at import
   * time -- so a store left holding servers is inherited by the next test
   * through the debounced write it eventually lands. Without this the suite
   * passed alone and failed in a full run, which is the worst way to find out.
   */
  await store?.flush()
  await rm(join(stateDir, 'state.json'), { force: true })
  store = new StateStore()
  await store.load()
  workspace = new Workspace(store, engine)

  // The peer's own ids are bare: it has no idea anyone is linked to it.
  peerSnapshot = {
    projects: [
      { id: 'p-peer', name: 'ide', host: { kind: 'local' }, root: '/srv/ide', worktreeRoot: '/srv/ide/.claude/worktrees', addedAt: 1 },
      { id: 'p-other', name: 'other', host: { kind: 'local' }, root: '/srv/other', worktreeRoot: '', addedAt: 1 },
      // The peer's own link to a third machine.
      { id: 'p-third', name: 'third', host: { kind: 'remote', baseUrl: 'http://third' }, root: '/srv/third', worktreeRoot: '', addedAt: 1 },
    ],
    worktrees: [
      { id: 'wt-a', projectId: 'p-peer', name: 'main', branch: 'main', path: '/srv/ide', isMain: true },
      { id: 'wt-b', projectId: 'p-other', name: 'main', branch: 'main', path: '/srv/other', isMain: true },
      { id: 'wt-c', projectId: 'p-third', name: 'main', branch: 'main', path: '/srv/third', isMain: true },
    ],
    sessions: [
      { id: 's-a', worktreeId: 'wt-a' } as Session,
      { id: 's-c', worktreeId: 'wt-c' } as Session,
    ],
    todos: [{ id: 't-a', worktreeId: 'wt-a', prompt: 'go', createdAt: 1 }],
    // The peer's layout, which must never reach ours.
    ui: { ...store.ui, panels: { 'wt-a': ['files'] } },
  }
})

const link = async () => workspace.addServer({ baseUrl: peerUrl, token: 'tok' })
const scoped = (id: string): string => `${key}~${id}`

describe('a machine you have linked', () => {
  /*
   * Linking says "what is running there is running here". A model where you
   * first had to register each project could not do the one thing the row is
   * for: an agent blocked on you is blocked on you wherever it is, and one in a
   * project you had not subscribed to never reached you.
   */
  it('brings everything it has open', async () => {
    await link()
    const snapshot = await workspace.snapshot()

    expect(snapshot.projects.filter((p) => p.host.kind === 'remote').map((p) => p.id)).toEqual([
      scoped('p-peer'),
      scoped('p-other'),
    ])
    expect(snapshot.worktrees.map((w) => w.id)).toEqual([scoped('wt-a'), scoped('wt-b')])
    expect(snapshot.sessions.map((s) => s.id)).toEqual([scoped('s-a')])
    expect(snapshot.todos.map((t) => t.id)).toEqual([scoped('t-a')])
  })

  /*
   * Its *local* projects only. Following its links would make this transitive
   * -- a third machine's worktrees arriving through this one, named by ids it
   * scoped for itself -- and non-transitive is also what makes two machines
   * linked to each other terminate rather than recurse.
   */
  it('does not bring the machines it is itself linked to', async () => {
    await link()
    const snapshot = await workspace.snapshot()
    expect(snapshot.projects.map((p) => p.name)).not.toContain('third')
    expect(snapshot.worktrees.map((w) => w.id)).not.toContain(scoped('wt-c'))
    expect(snapshot.sessions.map((s) => s.id)).not.toContain(scoped('s-c'))
  })

  it('keeps its own layout and never adopts the other machine’s', async () => {
    await link()
    const snapshot = await workspace.snapshot()
    // The peer's `ui` names `wt-a`, an id that is not even spelled the same here.
    expect(snapshot.ui.panels).not.toHaveProperty('wt-a')
    expect(snapshot.ui).toEqual(store.ui)
  })

  it('never puts a credential anywhere a client can see', async () => {
    await link()
    const snapshot = await workspace.snapshot()
    expect(JSON.stringify(snapshot)).not.toContain('tok')
    expect(store.server(peerUrl)?.token).toBe('tok')
  })

  /*
   * Two instances linked to each other is an expected configuration. Without a
   * guard, one `GET /api/snapshot` recursed until the 5s timeouts fired at the
   * leaves: measured at 8,500 requests and five seconds of pegged CPU, and
   * self-sustaining, because the browser refetches on every invalidate and the
   * git poll fires every four seconds.
   */
  it('tells a machine not to go round again, on every read', async () => {
    await link()
    await workspace.snapshot()
    expect(reads).toBeGreaterThan(0)
    expect(unguardedReads).toBe(0)
  })

  it('answers a gateway with its own world only', async () => {
    await link()
    const asPeer = await workspace.snapshot({ localOnly: true })
    expect(asPeer.worktrees.filter((w) => w.id.includes('~'))).toHaveLength(0)
    expect(asPeer.projects.filter((p) => p.host.kind === 'remote')).toHaveLength(0)
  })
})

describe('a machine that stops answering', () => {
  /*
   * The UI prunes stored layout for worktrees it cannot see, so "that machine
   * is off" reading as "those worktrees are gone" costs panels, open files and
   * expanded trees permanently.
   */
  it('keeps the worktrees it last had', async () => {
    await link()
    expect((await workspace.snapshot()).worktrees).toHaveLength(2)

    answering = false
    const during = await workspace.snapshot()
    expect(during.worktrees.map((w) => w.id)).toEqual([scoped('wt-a'), scoped('wt-b')])
  })

  /*
   * And never a session. Liveness and attention are live facts: remembered,
   * they claim an agent is running -- and, worse, that one is *blocked on you*
   * -- on a machine that is switched off. Measured: unplug a peer with an agent
   * waiting and the amber stayed indefinitely for something that was not there.
   */
  it('never reports one of its sessions', async () => {
    await link()
    expect((await workspace.snapshot()).sessions).toHaveLength(1)

    answering = false
    expect((await workspace.snapshot()).sessions).toEqual([])
  })

  /*
   * In memory alone the guarantee only held *after* one successful read, and
   * the case that costs the user something is the other one: a gateway that
   * starts before its peer is listening reports nothing, and the prune runs.
   */
  it('is remembered across a restart of this server', async () => {
    await link()
    await workspace.snapshot()
    await store.flush()

    answering = false
    const restarted = new StateStore()
    await restarted.load()
    const after = await new Workspace(restarted, engine).snapshot()

    expect(after.worktrees.map((w) => w.id)).toEqual([scoped('wt-a'), scoped('wt-b')])
    expect(after.sessions).toHaveLength(0)
  })

  it('shows nothing for a machine that has never answered', async () => {
    answering = false
    // `addServer` reaches out, so linking an unreachable machine fails -- which
    // is the one remote call that should, because you are at the keyboard.
    await expect(link()).rejects.toThrow()
  })
})

describe('unlinking', () => {
  /*
   * Nothing of that machine's is closed, because nothing of it was ever ours.
   * Its projects stop appearing here and are still open there -- which is what
   * makes this safe from a small x, where the old model had to refuse while
   * projects were open.
   */
  it('just stops asking, and takes nothing with it', async () => {
    await link()
    expect((await workspace.snapshot()).worktrees).toHaveLength(2)

    workspace.removeServer(peerUrl)
    const after = await workspace.snapshot()
    expect(after.worktrees).toHaveLength(0)
    expect(after.projects.filter((p) => p.host.kind === 'remote')).toHaveLength(0)
    expect(store.server(peerUrl)).toBeUndefined()
  })

  it('forgets what the machine last said, so re-linking does not resurrect it', async () => {
    await link()
    await workspace.snapshot()
    workspace.removeServer(peerUrl)
    await link()

    answering = false
    expect((await workspace.snapshot()).worktrees).toHaveLength(0)
  })
})

describe('this machine’s own projects', () => {
  /*
   * Only local projects are stored. A linked machine's arrive in the snapshot
   * under its own ids and are never written here -- which is what retired the
   * guards `worktrees()` and `createWorktree` used to carry, because a stored
   * remote project would have sent local git at a path on another machine.
   */
  it('are the only kind the store holds', async () => {
    await link()
    await workspace.snapshot()
    expect(store.projects.every((project) => project.host.kind === 'local')).toBe(true)
  })
})
