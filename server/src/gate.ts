import type { FastifyRequest } from 'fastify'
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
 * The connection came from this machine.
 *
 * `request.ip` is the socket's peer address: Fastify only believes
 * `X-Forwarded-For` when `trustProxy` is on, and it is not.
 */
export const isLoopback = (request: FastifyRequest): boolean => {
  const ip = request.ip
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
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
  // `[::1]:8084` keeps its brackets; everything else splits on the last colon.
  const name = header.startsWith('[')
    ? (header.slice(0, header.indexOf(']') + 1) || header)
    : (header.split(':')[0] ?? header)
  return config.publicHosts.has(name) || config.publicHosts.has(header)
}

export const allowRequest = (request: FastifyRequest): boolean => {
  // A gateway is not a browser: it addresses a peer by whatever name reaches
  // it, which this machine has no reason to have published. The token is what
  // speaks for it, and rebinding is not a thing that happens to a server.
  if (hasPeerToken(request)) return true
  if (!hostAllowed(request)) return false
  return config.token === undefined || (isLoopback(request) && isOwnPage(request))
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

  // Not a peer: bound to loopback, and the allow-list is what stops a page you
  // merely visited from opening a socket here. A missing Origin is not a
  // browser -- curl, a health check, a test -- and is gated by the bind address
  // the way every `/api` route is.
  return origin === undefined || ours
}
