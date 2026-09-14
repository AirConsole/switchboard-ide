import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'

/* `config` reads the environment at import time. See state.test.ts. */
process.env.SWB_TOKEN = 'the-secret'
const { allowRequest, allowSocket, hasPeerToken } = await import('../src/gate.js')

/** Only what the gate reads. */
const req = (headers: Record<string, string>, ip = '127.0.0.1'): FastifyRequest =>
  ({ headers, ip }) as unknown as FastifyRequest

/** The port `config` derives its default allow-list from. */
const OURS = 'http://127.0.0.1:8084'

describe('who may reach a peer’s API', () => {
  it('lets a gateway in with the token, from anywhere', () => {
    expect(allowRequest(req({ 'x-swb-token': 'the-secret' }, '10.0.0.7'))).toBe(true)
  })

  it('refuses the wrong token, and a missing one', () => {
    expect(allowRequest(req({ 'x-swb-token': 'wrong' }, '10.0.0.7'))).toBe(false)
    expect(allowRequest(req({}, '10.0.0.7'))).toBe(false)
    expect(hasPeerToken(req({ 'x-swb-token': 'the-secre' }))).toBe(false)
  })

  /*
   * The hole this closes, and it was wide open.
   *
   * `Sec-Fetch-Site` means something only because a *browser* sets it, and this
   * gate accepted it on its own. Anything that is not a browser sets whatever
   * it likes, so on a peer bound off loopback --- which is the deployment the
   * token exists to make safe --- one forged header was the whole of it:
   *
   *   curl -H 'Sec-Fetch-Site: none' http://box:8084/api/snapshot   -> 200
   *
   * and from there `PUT /api/worktrees/<id>/file` writes into a worktree and
   * `POST /api/sessions` spawns a shell in it. Fetch Metadata can only narrow
   * browser traffic; it can never authenticate a non-browser.
   */
  it('refuses a forged Sec-Fetch-Site from off this machine', () => {
    for (const site of ['none', 'same-origin']) {
      expect(allowRequest(req({ 'sec-fetch-site': site }, '10.0.0.7'))).toBe(false)
      expect(allowRequest(req({ 'sec-fetch-site': site }, '192.168.1.20'))).toBe(false)
    }
  })

  it('still lets the page served on this machine work', () => {
    // A browser omits Origin on a same-origin GET, so this is the only thing
    // left that says "our own page" -- and it is believed solely from loopback.
    expect(allowRequest(req({ 'sec-fetch-site': 'same-origin' }, '127.0.0.1'))).toBe(true)
    expect(allowRequest(req({ 'sec-fetch-site': 'none' }, '::1'))).toBe(true)
    // Another site's page, even on this machine, is asking on its own account.
    expect(allowRequest(req({ 'sec-fetch-site': 'cross-site' }, '127.0.0.1'))).toBe(false)
  })

  it('refuses a non-browser on this machine that carries no token', () => {
    // curl from a shell on the peer is not our page; it sends no Fetch Metadata.
    expect(allowRequest(req({}, '127.0.0.1'))).toBe(false)
  })
})

describe('who may open a peer’s socket', () => {
  /*
   * The other half of the same mistake, and the more dangerous one: an admitted
   * socket may attach to a session and type into it, which is command execution.
   *
   * `Origin` is unforgeable only inside a browser, and `http://127.0.0.1:<port>`
   * is always in the allow-list -- so one forged header from anywhere on the
   * network was the whole of it. Measured against a peer bound to 0.0.0.0 with
   * a token set: accepted, before this.
   */
  it('refuses a forged Origin from off this machine', () => {
    for (const origin of [OURS, 'http://localhost:8084']) {
      expect(allowSocket(req({ origin }, '10.0.0.7'))).toBe(false)
    }
    expect(allowSocket(req({}, '10.0.0.7'))).toBe(false)
  })

  it('lets a gateway in with the token, from anywhere', () => {
    expect(allowSocket(req({ 'x-swb-token': 'the-secret' }, '10.0.0.7'))).toBe(true)
  })

  it('lets the peer’s own page in, from the peer', () => {
    expect(allowSocket(req({ origin: OURS }, '127.0.0.1'))).toBe(true)
    // Still not a page we serve, even from here.
    expect(allowSocket(req({ origin: 'https://evil.example' }, '127.0.0.1'))).toBe(false)
    // And a non-browser on the peer still needs the token.
    expect(allowSocket(req({}, '127.0.0.1'))).toBe(false)
  })
})
