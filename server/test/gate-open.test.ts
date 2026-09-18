import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'

/* No SWB_TOKEN: the ordinary instance, which is nobody's peer. */
delete process.env.SWB_TOKEN
const { withPassword } = await import('./helpers/password.js')
withPassword()
const { allowRequest, allowSocket, registerGate } = await import('../src/gate.js')
const { mintSession } = await import('../src/auth.js')
const Fastify = (await import('fastify')).default

const req = (headers: Record<string, string>, ip = '127.0.0.1'): FastifyRequest =>
  ({ headers: { host: '127.0.0.1:7999', ...headers }, ip, method: 'GET' }) as unknown as FastifyRequest

const signedIn = (extra: Record<string, string> = {}): Record<string, string> => ({
  cookie: `swb_session=${mintSession()}`,
  ...extra,
})

describe('an instance that is nobody’s peer', () => {
  /*
   * `--bind` is a documented knob, so "bound to loopback" was an assumption
   * and not a fact. Demonstrated end to end on `--bind 0.0.0.0` with no
   * token: a socket from the LAN address carrying no Origin and no token was
   * accepted, the unasked `session-state` broadcast handed over a live session
   * id, and one `input` frame wrote a file as the user -- while `/api` on the
   * same instance refused the same caller.
   */
  /*
   * The rule is stronger than it was, and simpler: without a credential there
   * is no socket, from anywhere -- including from this machine. Being on
   * loopback used to be the evidence, and behind a reverse proxy loopback is
   * the whole internet.
   */
  it('refuses a socket with no credential, from anywhere at all', () => {
    expect(allowSocket(req({}, '10.0.0.7'))).toBe(false)
    expect(allowSocket(req({}, '127.0.0.1'))).toBe(false)
  })

  /*
   * And an Origin is no longer evidence either. A page on a sibling port of
   * this hostname is same-site, so the browser hands it our cookie -- and a
   * WebSocket is exempt from CORS. A browser opens this with a single-use
   * ticket obtained over `/api`, which that page cannot get.
   */
  it('admits neither our own origin nor a stranger, because the origin is not the credential', () => {
    expect(allowSocket(req({ origin: 'http://127.0.0.1:7999' }))).toBe(false)
    expect(allowSocket(req(signedIn({ origin: 'http://127.0.0.1:7999' })))).toBe(false)
    expect(allowSocket(req({ origin: 'https://evil.example' }))).toBe(false)
  })

  /*
   * `Origin` is unforgeable only inside a browser, and `http://127.0.0.1:<port>`
   * is always in the allow-list -- so on `--bind 0.0.0.0` a raw client from
   * the network forged it and was admitted, which is attach-and-type.
   */
  it('refuses a forged loopback Origin from off this machine', () => {
    expect(allowSocket(req({ origin: 'http://127.0.0.1:7999' }, '10.0.0.7'))).toBe(false)
  })

  /*
   * And the same on `/api`: a `Host` this server genuinely answers to is not
   * evidence of anything when the caller writes it. Measured, 200 on the whole
   * snapshot from the network.
   */
  it('refuses a forged loopback Host from off this machine', () => {
    expect(allowRequest(req({ host: '127.0.0.1:7999' }, '10.0.0.7'))).toBe(false)
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

  it('lets our page through once it has signed in, and nothing else', () => {
    expect(allowRequest(req(signedIn({ 'sec-fetch-site': 'same-origin' })))).toBe(true)
    expect(allowRequest(req(signedIn({ 'sec-fetch-site': 'none' })))).toBe(true)
    // The same requests without a session. Fetch Metadata narrows which of our
    // pages may act; it has never been able to say that a caller is ours.
    expect(allowRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false)
    expect(allowRequest(req({}))).toBe(false)
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
  it('is served to any name we answer to, because a login page cannot need a login', async () => {
    const app = Fastify()
    registerGate(app)
    app.setNotFoundHandler(async (_request, reply) => reply.send({ page: true }))
    await app.ready()

    const here = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:7999' } })
    expect(here.statusCode).toBe(200)
    /*
     * From the network too, and deliberately: this was `isLoopback`, which
     * behind a reverse proxy is every caller on earth anyway -- so restricting
     * it was describing something that had never been true. It serves the shell,
     * the bundle, the manifest and the icons. Everything about projects,
     * worktrees and sessions is behind `/api` and needs the password.
     */
    const away = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '10.0.0.7',
      headers: { host: '127.0.0.1:7999' },
    })
    expect(away.statusCode).toBe(200)
    // A name we do not answer to is still nothing, from anywhere. That is the
    // rebinding check, and it is the one thing about a rebound page the
    // attacker does not choose.
    const strange = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'evil.example' },
    })
    expect(strange.statusCode).toBe(404)
    await app.close()
  })
})
