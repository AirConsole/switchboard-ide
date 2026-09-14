import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

/* `config` reads the environment at import time. See state.test.ts. */
process.env.SWB_TOKEN = 'the-secret'
const { allowRequest } = await import('../src/gate.js')

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  /*
   * The gate exactly as index.ts registers it. Keyed on the route Fastify
   * matched, never on the URL text.
   */
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url
    if (route === undefined || !route.startsWith('/api')) return
    if (route === '/api/health') return
    if (allowRequest(request)) return
    await reply.status(401).send({ error: 'not allowed' })
  })
  app.get('/api/snapshot', async () => ({ secret: 'every worktree on this machine' }))
  app.post('/api/sessions', async () => ({ spawned: true }))
  app.get('/api/health', async () => ({ ok: true }))
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

/** No token and no Fetch Metadata: the shape a network attacker has. */
const ask = async (url: string, method = 'GET'): Promise<number> =>
  (await app.inject({ method: method as 'GET', url })).statusCode

describe('the gate is keyed on the route, not the URL text', () => {
  /*
   * `request.url` is the raw request target; the router matches the *decoded*
   * path. The two disagree, and every spelling of that disagreement was a way
   * in. Measured against a real peer with a token set and none supplied:
   * `GET /%61pi/snapshot` returned the full snapshot, and
   * `POST /%61pi/sessions` spawned a live shell in one of its worktrees --
   * unauthenticated command execution, from anywhere on the network.
   */
  it('refuses every spelling of a protected route', async () => {
    for (const url of ['/api/snapshot', '/%61pi/snapshot', '/ap%69/snapshot', '/api/%73napshot']) {
      expect([url, await ask(url)]).toEqual([url, 401])
    }
    expect(await ask('/%61pi/sessions', 'POST')).toBe(401)
  })

  it('still answers the routes that are meant to be open', async () => {
    expect(await ask('/api/health')).toBe(200)
    // A prefix, not the route: `startsWith` exempted this too, once.
    expect(await ask('/api/healthz')).toBe(404)
  })

  it('lets a gateway through on any spelling', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/%61pi/snapshot',
      headers: { 'x-swb-token': 'the-secret' },
    })
    expect(res.statusCode).toBe(200)
  })
})
