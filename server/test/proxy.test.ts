import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-proxy-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { Workspace } = await import('../src/workspace.js')
const { registerProxy } = await import('../src/remote/proxy.js')
const { hostKeyFor } = await import('../src/remote/scope.js')
const { PROTOCOL_VERSION } = await import('@switchboard/shared')

/** Every path the peer was asked for, which is the thing under test. */
const asked: { method: string; url: string; body: unknown }[] = []

const peer = Fastify()
peer.get('/api/server', async () => ({ name: 'peer', protocolVersion: PROTOCOL_VERSION }))
peer.all('/api/*', async (request) => {
  asked.push({ method: request.method, url: request.url, body: request.body })
  return { worktreeId: 'wt-peer', id: 'wt-peer' }
})
await peer.listen({ host: '127.0.0.1', port: 0 })
const peerUrl = `http://127.0.0.1:${(peer.server.address() as AddressInfo).port}`
const key = hostKeyFor(peerUrl)

let app: FastifyInstance
let store: InstanceType<typeof StateStore>

beforeAll(async () => {
  store = new StateStore()
  await store.load()
  const workspace = new Workspace(store, { list: () => [] } as never)
  await workspace.addServer({ baseUrl: peerUrl, token: 'tok' })
  const pointer = await workspace.openRemoteProject({ baseUrl: peerUrl, root: '/srv/ide' })
  localProjectId = pointer.id

  app = Fastify()
  registerProxy(app, workspace)
  // Stand-ins for the real routes, so "handled locally" is observable.
  app.get('/api/worktrees/:id/tree', async () => ({ here: true }))
  app.post('/api/worktrees', async () => ({ here: true }))
  app.get('/api/snapshot', async () => ({ here: true }))
  app.get('/api/browse', async () => ({ here: true }))
  app.post('/api/worktrees/:id/todos', async () => ({ here: true }))
  await app.ready()
})

let localProjectId = ''

afterAll(async () => {
  await app.close()
  await peer.close()
  await rm(stateDir, { recursive: true, force: true })
})

const call = async (
  url: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; asked: typeof asked }> => {
  asked.length = 0
  const res = await app.inject(
    payload === undefined ? { method, url } : { method, url, payload },
  )
  return { status: res.statusCode, body: res.json<Record<string, unknown>>(), asked: [...asked] }
}

describe('which machine a request goes to', () => {
  it('forwards a scoped path id, with the peer’s own id restored', async () => {
    const out = await call(`/api/worktrees/${key}~wt-peer/tree`)
    expect(out.asked[0]?.url).toBe('/api/worktrees/wt-peer/tree')
    // And the reply comes back scoped, so the browser only ever sees our ids.
    expect(out.body.worktreeId).toBe(`${key}~wt-peer`)
  })

  it('keeps a local request local', async () => {
    const out = await call('/api/worktrees/wt-local/tree')
    expect(out.asked).toEqual([])
    expect(out.body).toEqual({ here: true })
  })

  /*
   * A remote project's id is our pointer's and therefore bare, so nothing about
   * it says "another machine". Without the store lookup this was answered here
   * and refused, and creating a worktree on a remote project was unreachable.
   */
  it('routes a remote project by its pointer, and renames it for the peer', async () => {
    const out = await call('/api/worktrees', 'POST', { projectId: localProjectId, branch: 'x' })
    expect(out.asked[0]?.url).toBe('/api/worktrees')
    // The peer calls that project something else: the same root, hashed without
    // a base URL. Sending our id would address nothing there.
    expect((out.asked[0]?.body as { projectId: string }).projectId).not.toBe(localProjectId)
    expect((out.asked[0]?.body as { projectId: string }).projectId).toMatch(/^p-[0-9a-f]{10}$/)
  })

  it('sends `?host=` reads to that machine, without the parameter', async () => {
    const out = await call(`/api/browse?path=%2Fsrv&host=${key}`)
    expect(out.asked[0]?.url).toBe('/api/browse?path=%2Fsrv')
  })

  /*
   * Silently resolving a disagreement is what lands a request on another
   * machine's identically-pathed worktree -- and worktree ids hash the bare
   * path, so the wrong peer *answering* is the normal case, not a miss.
   */
  it('refuses a request that names two machines', async () => {
    const out = await call(`/api/worktrees/${key}~wt-peer/tree?host=hdeadbeef`)
    expect(out.status).toBe(400)
    expect(out.asked).toEqual([])
  })

  it('never forwards the snapshot, which is the merge of every machine', async () => {
    // Forwarded whole it would hand back the peer's entire world, including the
    // `ui` blob the boundary exists to strip.
    const out = await call(`/api/snapshot?host=${key}`)
    expect(out.asked).toEqual([])
    expect(out.body).toEqual({ here: true })
  })

  it('does not read a prompt as a machine name', async () => {
    // `rm -rf ~` is a string like any other; deciding routing by scanning free
    // text sent an ordinary todo to a machine that does not exist.
    const out = await call('/api/worktrees/wt-local/todos', 'POST', { prompt: 'rm -rf ~' })
    expect(out.asked).toEqual([])
    expect(out.body).toEqual({ here: true })
  })

  it('answers rather than throwing on a malformed escape', async () => {
    // `decodeURIComponent('%zz')` throws; that was a 500 where the route says 404.
    const out = await call('/api/worktrees/%zz/tree')
    expect(out.status).not.toBe(500)
  })

  it('says which machine did not answer, not that this one broke', async () => {
    await peer.close()
    const out = await call(`/api/worktrees/${key}~wt-peer/tree`)
    expect(out.status).toBe(504)
  })
})
