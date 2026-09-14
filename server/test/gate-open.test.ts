import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'

/* No SWB_TOKEN: the ordinary instance, which is nobody's peer. */
delete process.env.SWB_TOKEN
const { allowRequest, allowSocket, registerGate } = await import('../src/gate.js')
const Fastify = (await import('fastify')).default

const req = (headers: Record<string, string>, ip = '127.0.0.1'): FastifyRequest =>
  ({ headers: { host: '127.0.0.1:8084', ...headers }, ip }) as unknown as FastifyRequest

describe('an instance that is nobody’s peer', () => {
  /*
   * `--bind` is a documented knob, so "bound to loopback" was an assumption
   * and not a fact. Demonstrated end to end on `--bind 0.0.0.0` with no
   * token: a socket from the LAN address carrying no Origin and no token was
   * accepted, the unasked `session-state` broadcast handed over a live session
   * id, and one `input` frame wrote a file as the user -- while `/api` on the
   * same instance refused the same caller.
   */
  it('refuses a socket with no Origin from off this machine', () => {
    expect(allowSocket(req({}, '10.0.0.7'))).toBe(false)
    // From this machine it is curl, a health check or a test, as before.
    expect(allowSocket(req({}, '127.0.0.1'))).toBe(true)
  })

  it('still admits our own page, and refuses a page we did not serve', () => {
    expect(allowSocket(req({ origin: 'http://127.0.0.1:8084' }))).toBe(true)
    expect(allowSocket(req({ origin: 'https://evil.example' }))).toBe(false)
  })

  /*
   * `Origin` is unforgeable only inside a browser, and `http://127.0.0.1:<port>`
   * is always in the allow-list -- so on `--bind 0.0.0.0` a raw client from
   * the network forged it and was admitted, which is attach-and-type.
   */
  it('refuses a forged loopback Origin from off this machine', () => {
    expect(allowSocket(req({ origin: 'http://127.0.0.1:8084' }, '10.0.0.7'))).toBe(false)
  })

  /*
   * And the same on `/api`: a `Host` this server genuinely answers to is not
   * evidence of anything when the caller writes it. Measured, 200 on the whole
   * snapshot from the network.
   */
  it('refuses a forged loopback Host from off this machine', () => {
    expect(allowRequest(req({ host: '127.0.0.1:8084' }, '10.0.0.7'))).toBe(false)
  })

  /*
   * Fetch Metadata narrows browser traffic even with no token. `hostAllowed`
   * cannot catch this one: `127.0.0.1` genuinely is one of our names. Measured
   * against a scratch instance before the fix, `POST .../sleep` from a
   * cross-site page returned 200 -- it cannot read the reply, but it does not
   * need to in order to act.
   */
  it('refuses another site’s page acting on its own account', () => {
    expect(allowRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(allowRequest(req({ 'sec-fetch-site': 'same-site' }))).toBe(false)
  })

  it('still lets our page and non-browsers through', () => {
    expect(allowRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(allowRequest(req({ 'sec-fetch-site': 'none' }))).toBe(true)
    // curl and the health check send no Fetch Metadata at all.
    expect(allowRequest(req({}))).toBe(true)
  })

  it('still refuses a name we never published', () => {
    expect(allowRequest(req({ host: 'evil.example' }))).toBe(false)
  })
})

describe('the page, on an instance that is nobody\u2019s peer', () => {
  /*
   * The page rule used to be gated on *having a token*, so an ordinary
   * instance bound off loopback served the whole app, its assets and vite's
   * source maps to the network -- while refusing every API call behind it.
   * The page half open and the API half closed, with two CLAUDE.md files
   * claiming otherwise. Not a data leak, since the page cannot work without
   * the API; but it advertises an IDE here, and a security claim that is only
   * sometimes true is worse than not making it.
   */
  it('is served to this machine only, token or no token', async () => {
    const app = Fastify()
    registerGate(app)
    app.setNotFoundHandler(async (_request, reply) => reply.send({ page: true }))
    await app.ready()

    const here = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:8084' } })
    expect(here.statusCode).toBe(200)
    const away = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '10.0.0.7',
      headers: { host: '127.0.0.1:8084' },
    })
    expect(away.statusCode).toBe(404)
    await app.close()
  })
})
