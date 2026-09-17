import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'

/* `config` reads the environment at import time. See state.test.ts. */
process.env.SWB_TOKEN = 'the-secret'
const { withPassword, writePassword } = await import('./helpers/password.js')
const STATE = withPassword()
const { allowRequest, allowSocket, hasPeerToken } = await import('../src/gate.js')
const { mintLink, mintSession, newTicket, spendTicket } = await import('../src/auth.js')

/**
 * Only what the gate reads. A real request always carries a Host and a method.
 *
 * The method matters now: a missing one is treated as a mutation, which is the
 * fail-closed reading and is what this fixture originally tripped over.
 */
const req = (headers: Record<string, string>, ip = '127.0.0.1'): FastifyRequest =>
  ({ headers: { host: '127.0.0.1:8083', ...headers }, ip, method: 'GET' }) as unknown as FastifyRequest

/** A browser holding a valid session, which is now the only way our page gets in. */
const signedIn = (extra: Record<string, string> = {}): Record<string, string> => ({
  cookie: `swb_session=${mintSession()}`,
  ...extra,
})

/** The port `config` derives its default allow-list from. */
const OURS = 'http://127.0.0.1:8083'

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
   *   curl -H 'Sec-Fetch-Site: none' http://box:8083/api/snapshot   -> 200
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

  it('lets the page served on this machine work, once it has signed in', () => {
    // A browser omits Origin on a same-origin GET, so Fetch Metadata is what
    // says "our own page" -- but it is no longer what says "allowed". The
    // session is. Fetch Metadata only narrows which of our pages may act.
    expect(allowRequest(req(signedIn({ 'sec-fetch-site': 'same-origin' })))).toBe(true)
    expect(allowRequest(req(signedIn({ 'sec-fetch-site': 'none' }), '::1'))).toBe(true)
    // Another site's page, even on this machine, is asking on its own account --
    // and now it may be doing so while the browser attaches our cookie for it.
    expect(allowRequest(req(signedIn({ 'sec-fetch-site': 'cross-site' })))).toBe(false)
  })

  /*
   * The rule the password replaced, and the reason it had to be replaced.
   *
   * Being on loopback used to be most of the evidence. Behind a reverse proxy
   * it is *all* of the internet: a proxy connects from 127.0.0.1, so every
   * request it forwards satisfies that test. Measured against the deployment
   * this was built for -- a request carrying the public Host, arriving at
   * loopback exactly as Caddy delivers it, was answered 200.
   */
  it('refuses a perfect-looking browser request from loopback with no session', () => {
    expect(allowRequest(req({ 'sec-fetch-site': 'same-origin' }, '127.0.0.1'))).toBe(false)
    expect(allowRequest(req({ 'sec-fetch-site': 'none' }, '127.0.0.1'))).toBe(false)
  })

  it('refuses a non-browser on this machine that carries no token', () => {
    // curl from a shell on the peer is not our page; it sends no Fetch Metadata.
    expect(allowRequest(req({}, '127.0.0.1'))).toBe(false)
  })

  /*
   * A mutation needs an Origin as well, which is the layer that still works on
   * the browsers that send no Fetch Metadata at all (Safari before 16.4,
   * Firefox before 90). With a cookie in play, that residual is a cross-site
   * POST that would otherwise land *authenticated*.
   */
  it('refuses a mutation with a session but no Origin, and takes one with it', () => {
    const post = (headers: Record<string, string>): FastifyRequest =>
      ({ ...req(headers), method: 'POST' }) as unknown as FastifyRequest
    expect(allowRequest(post(signedIn({ 'sec-fetch-site': 'same-origin' })))).toBe(false)
    expect(
      allowRequest(post(signedIn({ 'sec-fetch-site': 'same-origin', origin: OURS }))),
    ).toBe(true)
    expect(
      allowRequest(post(signedIn({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' }))),
    ).toBe(false)
  })

  /*
   * A token minted under a different password must not verify. This is the one
   * property the whole key-derivation choice exists for: `pnpm password` has to
   * revoke every session, and nothing else in the design does it.
   */
  it('refuses a session minted before the password changed', async () => {
    const before = mintSession()
    expect(allowRequest(req({ cookie: `swb_session=${before}`, 'sec-fetch-site': 'same-origin' }))).toBe(
      true,
    )
    // In place, because `config.stateDir` is captured at import -- pointing the
    // environment at a new directory changes nothing, which is itself worth
    // knowing when writing any fixture here.
    writePassword(STATE, 'a different password entirely')
    // The record is re-read at most once a second; the wait is the price of not
    // stat-ing on every single request.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(allowRequest(req({ cookie: `swb_session=${before}`, 'sec-fetch-site': 'same-origin' }))).toBe(
      false,
    )
    // And a session minted after it is fine, so this is revocation and not breakage.
    expect(allowRequest(req(signedIn({ 'sec-fetch-site': 'same-origin' })))).toBe(true)
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
    for (const origin of [OURS, 'http://localhost:8083']) {
      expect(allowSocket(req({ origin }, '10.0.0.7'))).toBe(false)
    }
    expect(allowSocket(req({}, '10.0.0.7'))).toBe(false)
  })

  it('lets a gateway in with the token, from anywhere', () => {
    expect(allowSocket(req({ 'x-swb-token': 'the-secret' }, '10.0.0.7'))).toBe(true)
  })

  /*
   * The hole that killed the previous attempt at a password here, as a test.
   *
   * `allowSocket` takes a gateway's token and **nothing else** -- no Origin, no
   * cookie. Cookies ignore the port, so a page on a sibling port of this
   * hostname is same-site and the browser attaches our cookie to a socket that
   * page opens; a WebSocket is exempt from CORS, so nothing else is in the way.
   * Measured end to end last time: `attach`, `focus`, `input`, and a shell
   * command ran as the user from a page they merely visited.
   *
   * A browser gets in with a single-use ticket instead, spent in `routes/ws.ts`,
   * which it can only obtain over `/api` where the origin is checked.
   */
  it('takes no cookie at all, whatever origin it arrives with', () => {
    expect(allowSocket(req(signedIn({ origin: OURS })))).toBe(false)
    expect(allowSocket(req(signedIn({ origin: 'http://127.0.0.1:8543' })))).toBe(false)
    expect(allowSocket(req({ origin: OURS }, '127.0.0.1'))).toBe(false)
    expect(allowSocket(req({}, '127.0.0.1'))).toBe(false)
    // The gateway, which is what this function is now for.
    expect(allowSocket(req({ 'x-swb-token': 'the-secret' }, '10.0.0.7'))).toBe(true)
  })
})

describe('the two kinds of token', () => {
  /*
   * The header skips the origin and name checks, which is right for another
   * machine and wrong for a browser. A session token is what sits in a
   * browser's cookie, so accepting one in the header would turn any leaked
   * cookie value into a credential that no longer has to come from our page.
   */
  it('takes a link token in the header and never a session token', () => {
    expect(allowRequest(req({ 'x-swb-token': mintLink() as string }, '10.0.0.7'))).toBe(true)
    expect(allowRequest(req({ 'x-swb-token': mintSession() as string }, '10.0.0.7'))).toBe(false)
    expect(allowSocket(req({ 'x-swb-token': mintSession() as string }, '10.0.0.7'))).toBe(false)
  })

  it('never takes a link token as a cookie', () => {
    const cookie = `swb_session=${mintLink()}`
    expect(allowRequest(req({ cookie, 'sec-fetch-site': 'same-origin' }))).toBe(false)
  })

  /*
   * A link does not expire -- the machine holding it keeps no password to log
   * in with again -- so the only thing that ends one is the password changing.
   */
  it('ends every link when the password changes', async () => {
    const link = mintLink() as string
    expect(allowRequest(req({ 'x-swb-token': link }, '10.0.0.7'))).toBe(true)
    writePassword(STATE, 'yet another password here')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(allowRequest(req({ 'x-swb-token': link }, '10.0.0.7'))).toBe(false)
  })
})

describe('socket tickets', () => {
  /*
   * A ticket issued before the password changed must not open a socket after
   * it. This was promised once by a function nothing called; an adversarial
   * pass found it. A ticket now carries its session and dies with it.
   */
  it('refuses a ticket whose session was revoked in the meantime', async () => {
    const early = newTicket(mintSession() as string)
    writePassword(STATE, 'and one more password')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(spendTicket(early)).toBeNull()
    // A ticket issued now is fine, so this is revocation rather than breakage.
    expect(spendTicket(newTicket(mintSession() as string))).not.toBeNull()
  })

  it('is spent once', () => {
    const ticket = newTicket(mintSession() as string)
    expect(spendTicket(ticket)).not.toBeNull()
    expect(spendTicket(ticket)).toBeNull()
  })
})

describe('a name we never published', () => {
  /*
   * DNS rebinding: a page served from a name the attacker owns, the name then
   * re-pointed at this address. The subtle half is that the rebound page is
   * *same-origin* with us afterwards -- no `Origin`, no preflight, and
   * `Sec-Fetch-Site: same-origin` -- so every check built on those agrees with
   * it. `Host` is the one thing it cannot change.
   *
   * On a token-less instance, which is the ordinary one, this was the whole of
   * the boundary: `POST /api/sessions` spawns a pty and a queued todo is typed
   * into a live Claude with no browser open. That is the capability the `/ws`
   * check closes, reached through `/api` instead.
   */
  it('refuses a request addressed to a name we do not answer to', () => {
    for (const host of ['evil.example', 'evil.example:8083', 'attacker.test']) {
      expect(allowRequest(req({ host, 'sec-fetch-site': 'same-origin' }))).toBe(false)
    }
  })

  it('answers to loopback, by every spelling', () => {
    for (const host of ['127.0.0.1:8083', 'localhost:8083', '[::1]:8083', '127.0.0.1']) {
      expect(allowRequest(req(signedIn({ host, 'sec-fetch-site': 'same-origin' })))).toBe(true)
    }
  })

  it('lets a gateway address a peer by whatever name reaches it', () => {
    // A peer has no reason to have published the name a gateway uses for it,
    // and rebinding is not a thing that happens to a server. The token speaks.
    expect(allowRequest(req({ host: 'box.local:8083', 'x-swb-token': 'the-secret' }, '10.0.0.7'))).toBe(
      true,
    )
  })
})
