import type { FastifyInstance, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { config } from './config.js'

/**
 * Who may reach this server's API and its socket.
 *
 * There are exactly two kinds of caller, and no login, no cookie and no session
 * between them:
 *
 * - **A gateway**, which is this same program on another machine reading a
 *   project that lives here. It is not a browser, and presents `SWB_TOKEN`.
 * - **Our own page**, in a browser *on this machine*. Recognised by Fetch
 *   Metadata **and** a loopback peer address, and the second half is not
 *   decoration: `Sec-Fetch-Site` means something only because a browser is the
 *   one setting it. Anything that is not a browser sets whatever it likes, so
 *   `curl -H 'Sec-Fetch-Site: none'` walked straight past a token-gated `/api`
 *   -- full snapshot, then `PUT .../file`, then `POST /api/sessions`, which is
 *   unauthenticated command execution on the peer. Fetch Metadata can only
 *   *narrow* browser traffic; it can never authenticate a non-browser.
 *
 * So the loopback address is what actually carries that second case, and Fetch
 * Metadata narrows it further -- a page on this machine cannot be made to ask
 * on some other site's behalf. A TCP peer address cannot be forged the way a
 * header can.
 *
 * `SWB_TOKEN` is what a machine sets to *be* a peer. Unset, this behaves
 * exactly as it always has and the bind address is the boundary. Set, anything
 * arriving over the network must carry the token, which is what makes it safe
 * to bind an address other than loopback -- and a peer's own UI is then usable
 * only from the machine itself, which is the intended trade: you look at a peer
 * through the gateway.
 *
 * One deployment caveat, for whoever puts a proxy in front of a peer: don't.
 * A reverse proxy connects from loopback, so every request it forwards would
 * look local. A peer needs no proxy -- the gateway reaches it directly.
 */

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
const secretEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const tokenOf = (request: FastifyRequest): string | undefined => {
  const header = request.headers['x-swb-token']
  return typeof header === 'string' ? header : undefined
}

export const hasPeerToken = (request: FastifyRequest): boolean => {
  const expected = config.token
  if (expected === undefined) return false
  const given = tokenOf(request)
  return given !== undefined && secretEquals(given, expected)
}

/**
 * A browser request that came from our own page, or from the address bar.
 *
 * `same-origin` is our page's own fetches. `none` is a direct navigation --
 * typing the URL, a bookmark -- which is how index.html itself is asked for.
 * `cross-site` and `same-site` are some other page asking on its own account,
 * and those are exactly what this refuses.
 */
export const isOwnPage = (request: FastifyRequest): boolean => {
  const site = request.headers['sec-fetch-site']
  return site === 'same-origin' || site === 'none'
}

/**
 * Not some other site's page asking on its own account.
 *
 * The weaker half of `isOwnPage`, for the instance that has no token: a client
 * sending no Fetch Metadata at all is not a browser (curl, the health check,
 * the tests) and is judged by the bind address as it always was, while a
 * browser that names a cross-site or same-site initiator is refused.
 *
 * Without it, a page you merely visited could reach `http://127.0.0.1:<port>`
 * -- `hostAllowed` passes, because that genuinely is one of our names.
 * Measured against a scratch instance: `POST /api/worktrees/<id>/sleep` from a
 * cross-site page returned 200. It cannot *read* the reply, since no CORS
 * header is ever sent, but it does not need to in order to act.
 *
 * The residual is browser-version-shaped rather than absolute: Safari before
 * 16.4 and Firefox before 90 send no Fetch Metadata at all, so from those the
 * same cross-site POST still lands. Closing that needs an anti-CSRF credential,
 * which this design deliberately does not have -- and allowing the absent
 * header is what keeps curl, the health check and the tests working. `same-site`
 * is refused as well as `cross-site` for the same reason in miniature: the spec
 * ignores the port, so another local app on a different port of this machine is
 * `same-site`, and that is exactly the caller to keep out.
 */
const notCrossSite = (request: FastifyRequest): boolean => {
  const site = request.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

/**
 * The connection came from this machine.
 *
 * `request.ip` is the socket's peer address: Fastify only believes
 * `X-Forwarded-For` when `trustProxy` is on, and it is not.
 */
export const isLoopback = (request: FastifyRequest): boolean => {
  const ip = request.ip
  // The whole of 127/8, not just `.1`: a local client bound to an alias -- some
  // proxies, a systemd socket unit, a container given a host-loopback alias --
  // is genuinely local, and refusing it with an auth error rather than an
  // address one is a confusing afternoon. Node renders a mapped peer in dotted
  // form, so there is no hex `::ffff:7f00:1` spelling to handle.
  return ip.startsWith('127.') || ip.startsWith('::ffff:127.') || ip === '::1'
}

/**
 * The name this request was addressed to is one we answer to.
 *
 * The anti-rebinding check, and the only one that works: a rebound page is
 * same-origin with us, so it sends no `Origin`, triggers no preflight, and
 * reports `Sec-Fetch-Site: same-origin`. `Host` is the one thing it cannot
 * change -- it carries the name the user typed, which the attacker owns and we
 * have never published.
 *
 * Without this, a token-less instance -- the ordinary one -- was fully writable
 * by any page you happened to visit for as long as it kept a DNS record
 * pointed here: `POST /api/sessions` spawns a pty, and a queued todo is typed
 * into a live Claude by the dispatcher with no browser open at all. That is the
 * same capability the `/ws` check in this change closes, reached through
 * `/api` instead.
 */
const hostAllowed = (request: FastifyRequest): boolean => {
  const header = request.headers.host
  if (header === undefined) return false
  try {
    /*
     * Parsed rather than split. The split version accepted `localhost:99:99`,
     * and needed a special case to keep the brackets on `[::1]` -- `new URL`
     * does both correctly and refuses anything that is not a real authority.
     * The second comparison it replaced (`has(header)`) was dead: this set only
     * ever holds bare hostnames, so a value with a port never matched it.
     */
    return config.publicHosts.has(new URL(`http://${header}`).hostname)
  } catch {
    return false
  }
}

export const allowRequest = (request: FastifyRequest): boolean => {
  // A gateway is not a browser: it addresses a peer by whatever name reaches
  // it, which this machine has no reason to have published. The token is what
  // speaks for it, and rebinding is not a thing that happens to a server.
  if (hasPeerToken(request)) return true
  if (!hostAllowed(request)) return false
  /*
   * With no token there is no credential, so the connection's own address is
   * the only boundary there is -- and every header a caller could be judged by
   * is one it writes itself. Measured on `--bind 0.0.0.0` with no token: a
   * request from the network carrying `Host: 127.0.0.1:<port>` -- a name this
   * server genuinely answers to -- walked straight past the rebinding gate and
   * read the whole snapshot.
   *
   * So a token-less instance serves this machine only. Binding it elsewhere
   * without setting `SWB_TOKEN` is not a configuration that can be made safe,
   * and failing closed says so at the first request instead of quietly serving
   * the network.
   */
  if (config.token === undefined) return isLoopback(request) && notCrossSite(request)
  return isLoopback(request) && isOwnPage(request)
}

/**
 * Who may open the socket.
 *
 * Separate from `allowRequest` because the questions differ: `/api` is asked by
 * our own page with no `Origin` at all (a browser omits it on a same-origin
 * GET), while a WebSocket always carries one. So here the allow-list is real
 * evidence -- against a browser.
 *
 * Against anything else it is worth nothing, and that is the half that bit:
 * `http://127.0.0.1:<port>` is always in the list, so a raw client on the
 * network sending that as its `Origin` was admitted, and an admitted socket may
 * attach to a session and type into it. Measured against a peer bound to
 * 0.0.0.0: accepted, before this. On a peer the token is therefore the only
 * credential that crosses the network, and a browser is believed solely from
 * this machine.
 */
export const allowSocket = (request: FastifyRequest): boolean => {
  // A gateway reading this machine: not a browser, so no Origin, and the token
  // is the whole of what it presents.
  if (hasPeerToken(request)) return true

  const origin = request.headers.origin
  const ours = origin !== undefined && config.publicOrigins.has(origin)

  if (config.token !== undefined) return ours && isLoopback(request)

  /*
   * Not a peer. A missing `Origin` is not a browser -- curl, a health check, a
   * test -- and that used to be allowed outright on the reasoning that this
   * instance is bound to loopback. It is not necessarily: `--bind` is a
   * documented knob, and nothing enforced the assumption.
   *
   * Demonstrated end to end on `--bind 0.0.0.0` with no token: a socket from
   * the LAN address with no Origin and no token was accepted, the unasked
   * `session-state` broadcast handed over a live session id, and one `input`
   * frame wrote a file as the user. `/api` on that same instance refuses the
   * same caller, so the two halves disagreed. The bind address is only a
   * boundary where it is actually loopback, so say so.
   */
  /*
   * Same rule as `/api`, and for the same reason: `Origin` is unforgeable only
   * inside a browser, and `http://127.0.0.1:<port>` is always in the list. On
   * `--bind 0.0.0.0` with no token a raw client from the network forged
   * exactly that and was admitted -- and an admitted socket may attach to a
   * session and type into it. Without a credential, the address is the
   * boundary.
   */
  return isLoopback(request) && (origin === undefined || ours)
}

/**
 * Whether the built page and its assets may be served to this caller.
 *
 * Loopback, always -- not only when this instance is somebody's peer, which is
 * what it used to say. A token-less instance bound off loopback then served the
 * whole app, its assets and vite's source maps to the network while refusing
 * every API call behind it: the page half open and the API half closed, and two
 * CLAUDE.md files claiming otherwise. It is not a data leak, because the page
 * cannot work without the API -- but it advertises an IDE here, and a security
 * claim that is only sometimes true is worse than not making it.
 */
const allowPage = (request: FastifyRequest): boolean => isLoopback(request)

/**
 * The gate, installed rather than described.
 *
 * Registered from here rather than written out in index.ts because a test that
 * hand-copies this logic can diverge from it -- and did: `gate-routing.test.ts`
 * transcribed the page rule *without* its `config.token` condition, so it
 * asserted a stricter rule than the server had and the gap above survived a
 * review that was looking straight at it. There is one copy now, and the test
 * installs this same function.
 */
export const registerGate = (app: FastifyInstance): void => {
  app.addHook('onRequest', async (request, reply) => {
    /*
     * Keyed on the route Fastify matched, never on the URL text. `request.url`
     * is the raw request target and the router matches the *decoded* path, so
     * the two disagree -- and every spelling of that disagreement was a way
     * through: measured against a real peer with a token set and none
     * supplied, `GET /%61pi/snapshot` returned the full snapshot and
     * `POST /%61pi/sessions` spawned a live shell in one of its worktrees.
     */
    const route = request.routeOptions.url
    if (route === undefined || !route.startsWith('/api')) {
      /*
       * `/ws` runs its own rule at the upgrade, where a hook cannot reach --
       * and it is the one non-`/api` route a *gateway* must be able to open
       * over the network. Falling into the page branch answered a
       * token-bearing gateway with 404 instead of a socket, which is every
       * remote terminal dead.
       */
      if (route === '/ws') return
      /*
       * No `route !== undefined` guard: an unmatched path falls to the SPA
       * catch-all, which would serve the page to the network by the back door.
       * 404 rather than 401: there is nothing here to authenticate *to*.
       */
      if (!allowPage(request)) await reply.status(404).send({ error: 'not found' })
      return
    }
    /*
     * `/api/health` says `{ok:true}` and nothing else, and it is what
     * `swb` polls after starting one -- neither a browser nor a
     * gateway. An exact match, not a prefix: `startsWith` also exempted
     * `/api/healthz` and anything else someone might later add under that stem.
     */
    if (route === '/api/health') return
    if (allowRequest(request)) return
    await reply.status(401).send({ error: 'not allowed' })
  })
}
