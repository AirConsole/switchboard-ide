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
peer.get('/api/snapshot', async () => peerSnapshot)

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
