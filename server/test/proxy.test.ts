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
const { HttpError } = await import('../src/http-error.js')

/** Every path the peer was asked for, which is the thing under test. */
const asked: { method: string; url: string; body: unknown }[] = []

const peer = Fastify()
peer.get('/api/server', async () => ({ name: 'peer', protocolVersion: PROTOCOL_VERSION }))
peer.all('/api/*', async (request, reply) => {
  asked.push({ method: request.method, url: request.url, body: request.body })
  if (request.url.includes('missing')) {
    // Shaped exactly as the real error handler sends it: `details` spread at
    // the top level beside `error` and `code`.
    return reply
      .status(404)
      .send({ error: 'nothing at /srv/x', code: 'path-missing', path: '/srv/x', insideRepo: null })
  }
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

  app = Fastify()
  // The same error handler `registerApi` installs, because what is under test
  // is what reaches the client -- and Fastify's default one drops `details`.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply
        .status(error.status)
        .send({ error: error.message, code: error.code, ...error.details })
      return
    }
    void reply.status(500).send({ error: (error as Error).message })
  })
  registerProxy(app, workspace)
  // Stand-ins for the real routes, so "handled locally" is observable.
  app.get('/api/worktrees/:id/tree', async () => ({ here: true }))
  app.post('/api/worktrees', async () => ({ here: true }))
  app.get('/api/snapshot', async () => ({ here: true }))
  app.get('/api/browse', async () => ({ here: true }))
  app.post('/api/projects', async () => ({ here: true }))
  // The two the allow-list exists to keep local.
  app.patch('/api/ui', async () => ({ here: true }))
  app.post('/api/servers', async () => ({ here: true }))
  app.post('/api/worktrees/:id/todos', async () => ({ here: true }))
  await app.ready()
})

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
   * `POST /api/worktrees` needs no special case any more, and that is the point
   * of linking: a remote project is known by the machine's own id, scoped, so
   * the route that addresses a project routes itself. When the gateway minted
   * an id of its own for it, nothing about that id said "another machine" --
   * the request was answered locally and refused, and creating a worktree on a
   * remote project was simply unreachable.
   */
  it('routes a remote project by its own scoped id', async () => {
    const out = await call('/api/worktrees', 'POST', { projectId: `${key}~p-peer`, branch: 'x' })
    expect(out.asked[0]?.url).toBe('/api/worktrees')
    expect((out.asked[0]?.body as { projectId: string }).projectId).toBe('p-peer')
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
    // On a route that takes `?host=` at all -- see the next test for one that
    // does not.
    const out = await call(`/api/projects?host=hdeadbeef`, 'POST', {
      path: '/x',
      projectId: `${key}~p-peer`,
    })
    expect(out.status).toBe(400)
    expect(out.asked).toEqual([])
  })

  /*
   * `?host=` steers three routes. It used to steer every one, which was
   * measured as destructive: `PATCH /api/ui?host=B` replaced B's stored layout
   * -- the panels and open files of the person sitting at B -- and
   * `POST /api/servers?host=B` linked B to a machine of the caller's choosing.
   * Refused rather than ignored: it named a machine, and quietly sending the
   * request elsewhere is how a mistake becomes an afternoon.
   */
  it('refuses a server on a route that does not take one', async () => {
    const cases: [string, 'GET' | 'POST'][] = [
      [`/api/worktrees/${key}~wt-peer/tree?host=${key}`, 'GET'],
      [`/api/servers?host=${key}`, 'POST'],
    ]
    for (const [url, method] of cases) {
      const out = await call(url, method, method === 'POST' ? {} : undefined)
      expect([url, out.status]).toEqual([url, 400])
      expect(out.asked).toEqual([])
    }
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

  /*
   * The client acts on `code` and `details`, not on the message: `path-missing`
   * and `not-a-repo` are what turn a failed open into the "create this?" offer,
   * and `stale-file` carries the `rev` that is the only way to resolve a save an
   * agent got to first. Dropped, those recoveries were unreachable on a remote
   * machine -- a red line and no way forward.
   */
  it('carries a peer\u2019s error code and details through, not just its message', async () => {
    const out = await call(`/api/worktrees/${key}~wt-missing/tree`)
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({
      error: 'nothing at /srv/x',
      code: 'path-missing',
      path: '/srv/x',
    })
  })

  it('says which machine did not answer, not that this one broke', async () => {
    await peer.close()
    const out = await call(`/api/worktrees/${key}~wt-peer/tree`)
    expect(out.status).toBe(504)
  })
})
