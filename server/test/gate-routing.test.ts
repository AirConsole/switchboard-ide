import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

/* `config` reads the environment at import time. See state.test.ts. */
process.env.SWB_TOKEN = 'the-secret'
const { allowRequest, isLoopback } = await import('../src/gate.js')

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  /*
   * The gate exactly as index.ts registers it. Keyed on the route Fastify
   * matched, never on the URL text.
   */
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url
    if (route === undefined || !route.startsWith('/api')) {
      if (route === '/ws') return
      if (!isLoopback(request)) await reply.status(404).send({ error: 'not found' })
      return
    }
    if (route === '/api/health') return
    if (allowRequest(request)) return
    await reply.status(401).send({ error: 'not allowed' })
  })
  /*
   * The static tree and `/ws`, which are what the hook does when the route is
   * not an API one. Registered here because the bug this catches was in that
   * branch and not in the predicates the other gate tests ask.
   */
  app.get('/ws', async () => ({ upgraded: true }))
  // The SPA the way index.ts serves it: a catch-all handler rather than a
  // route, so an unmatched path has no `routeOptions.url` -- which is the case
  // that slipped past the gating once.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
      return reply.status(404).send({ error: 'not found' })
    }
    return reply.send({ page: true })
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

describe('what the hook does with the routes that are not the API', () => {
  /*
   * `/ws` is not under `/api`, so gating the static tree on a peer caught it
   * too -- and a gateway asking for a socket over the network got 404 instead
   * of the socket's own check. That is every remote terminal dead, and the
   * other gate tests could not see it: they ask `allowSocket` rather than the
   * server, so the route never ran.
   */
  it('lets /ws reach its own check, from anywhere', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ws',
      remoteAddress: '10.0.0.7',
      headers: { host: '127.0.0.1:8084' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('serves a peer\u2019s page to its own machine only', async () => {
    const fromHere = await app.inject({ method: 'GET', url: '/anything', headers: { host: '127.0.0.1:8084' } })
    expect(fromHere.statusCode).toBe(200)
    // Including a path that matches no route at all, which reaches the SPA
    // catch-all and so had no `routeOptions.url` to be gated on.
    const fromAway = await app.inject({
      method: 'GET',
      url: '/anything',
      remoteAddress: '10.0.0.7',
      headers: { host: '127.0.0.1:8084' },
    })
    expect(fromAway.statusCode).toBe(404)
  })
})
