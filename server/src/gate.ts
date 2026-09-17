import type { FastifyInstance, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import {
  COOKIE_NAMES,
  IDLE_MS,
  clearedCookies,
  cookieFor,
  cookieValues,
  hasPassword,
  mintSession,
  verifySession,
  type Session,
} from './auth.js'
import { config } from './config.js'

/**
 * Who may reach this server's API and its socket.
 *
 * There are three kinds of caller, and the order below is the order they are
 * trusted:
 *
 * - **A gateway**: this same program on another machine, presenting a token in
 *   `x-swb-token`. Not a browser, so no Host, Origin or Fetch Metadata rule
 *   applies to it -- it addresses a peer by whatever name reaches it, which that
 *   machine has no reason to have published.
 * - **Our own page**, presenting a session cookie. A cookie is attached by the
 *   *browser*, not by the page, so holding one says nothing about who asked --
 *   which is what CSRF is. Hence `cookieAllowed`, whose layers are all
 *   initiator checks and none of which is an authenticator.
 * - **Nobody else.**
 *
 * What is gone from this file is the loopback address. Behind a reverse proxy
 * every caller on earth is `127.0.0.1` -- measured: a request carrying
 * `Host: <the public name>` and `sec-fetch-site: same-origin`, arriving at
 * 127.0.0.1 exactly as Caddy delivers it, was answered 200. So any rule of the
 * form "local callers are fine" hands the whole internet a bypass, and per-IP
 * rate limiting counts one IP. The password is the boundary now; the address is
 * not a boundary at all.
 *
 * A password on this IDE was built once before and abandoned after four
 * adversarial passes found sixteen holes. Read `61b640e` before changing the
 * ordering here: checking the credential before the origin is what reopened
 * command execution from a page the user merely visited.
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

/**
 * A machine caller: another Switchboard reading this one.
 *
 * Two credentials are accepted, and the second is the migration path. A link
 * token is an ordinary session token obtained by logging in with the password
 * once; `SWB_TOKEN` is the static secret that predates the password and is
 * still honoured so an already-linked pair does not go dark on upgrade.
 *
 * Deliberately **not** `Authorization`: `PeerClient` already puts a `Basic`
 * credential there for a peer behind somebody else's proxy, and one header
 * meaning two things is how a deployment behind a proxy stops authenticating.
 */
export const hasPeerToken = (request: FastifyRequest): boolean => {
  const given = tokenOf(request)
  if (given === undefined) return false
  if (verifySession(given) !== null) return true
  const expected = config.token
  return expected !== undefined && secretEquals(given, expected)
}

/** Our own page's session, from whichever cookie name this deployment uses. */
export const cookieSession = (request: FastifyRequest): Session | null => {
  for (const name of COOKIE_NAMES) {
    for (const value of cookieValues(request.headers.cookie, name)) {
      const session = verifySession(value)
      if (session !== null) return session
    }
  }
  return null
}

/** Whether a cookie was presented at all, valid or not. See the hook. */
const bearsCookie = (request: FastifyRequest): boolean =>
  COOKIE_NAMES.some((name) => cookieValues(request.headers.cookie, name).length > 0)

/**
 * A browser request that came from our own page, or from the address bar.
 *
 * `same-origin` is our page's own fetches. `none` is a direct navigation --
 * typing the URL, a bookmark -- which is how a raw file URL is opened. A
 * *missing* header is refused, where the old `notCrossSite` allowed it: that
 * fail-open existed only because there was no credential to present, and its
 * cost was the documented residual -- Safari before 16.4 and Firefox before 90
 * send no Fetch Metadata at all. With a cookie in play that residual is a
 * cross-site POST that lands *authenticated*, so the layers below cover it
 * instead.
 */
export const isOwnPage = (request: FastifyRequest): boolean => {
  const site = request.headers['sec-fetch-site']
  return site === 'same-origin' || site === 'none'
}

/** Nothing here mutates. Anything else needs the full rule below. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/**
 * The CSRF rule, and the only place a cookie is judged.
 *
 * Three layers, each independently sufficient against a browser that
 * implements it, because a cookie is evidence about the browser and never
 * about the initiator:
 *
 * 1. `SameSite=Strict` on the cookie itself -- no cross-site request carries it.
 * 2. Fetch Metadata: the initiator as the browser reports it.
 * 3. `Origin` against the allow-list, which is what still works on the browser
 *    versions that send no Fetch Metadata at all.
 *
 * Layer 3 cannot apply to GET: a browser sends no `Origin` on a same-origin GET,
 * and `<img src>` on `/api/worktrees/:id/raw` could not carry one anyway. That
 * is safe only while **no GET mutates** -- checked across all of them; the
 * closest is `/api/usage`, which execs a cached `claude -p /usage`. Adding a
 * mutating GET breaks this reasoning, and this comment is where you find out.
 */
const cookieAllowed = (request: FastifyRequest): boolean => {
  if (!isOwnPage(request)) return false
  if (SAFE_METHODS.has(request.method)) return true
  // A mutation from our own page is always `same-origin`; `none` would be a
  // person typing a POST, which is not a thing that happens.
  if (request.headers['sec-fetch-site'] !== 'same-origin') return false
  const origin = request.headers.origin
  return origin !== undefined && config.publicOrigins.has(origin)
}

/**
 * The name this request was addressed to is one we answer to.
 *
 * The anti-rebinding check, and it carries more weight than it used to: a
 * rebound page is same-origin with us, sends no `Origin`, triggers no preflight,
 * reports `Sec-Fetch-Site: same-origin` -- **and the browser attaches our
 * session cookie to it**. Every other check in this file agrees with such a
 * page. `Host` is the one thing about it the attacker does not choose.
 */
const hostAllowed = (request: FastifyRequest): boolean => {
  const header = request.headers.host
  if (header === undefined) return false
  try {
    return config.publicHosts.has(new URL(`http://${header}`).hostname)
  } catch {
    return false
  }
}

/**
 * Why a request was refused.
 *
 * Separated so a name we do not answer to is a 404 while a missing credential
 * is a 401 -- which is what lets `swb` prove `--host` is right with no
 * credential at all: 401 for the good name, 404 for a bogus one.
 */
export type Refusal = 'ok' | 'host' | 'auth'

export const judgeRequest = (request: FastifyRequest): Refusal => {
  if (hasPeerToken(request)) return 'ok'
  if (!hostAllowed(request)) return 'host'
  if (cookieSession(request) === null) return 'auth'
  return cookieAllowed(request) ? 'ok' : 'auth'
}

export const allowRequest = (request: FastifyRequest): boolean => judgeRequest(request) === 'ok'

/**
 * Who may open the socket.
 *
 * **A cookie is not accepted here, and that is the whole point.** Cookies are
 * scoped by host and ignore the port, so a page on a sibling port of the same
 * hostname is *same-site* and the browser hands it our cookie -- and a
 * WebSocket is exempt from CORS, so nothing else is in the way. That was
 * measured end to end on the previous attempt: from a page the user merely
 * visited, `attach`, `focus` and `input` were accepted and a shell command ran
 * as them. It is not hypothetical for this deployment, whose proxy serves five
 * ports on one hostname with one of them unauthenticated.
 *
 * So the browser presents a single-use ticket instead, obtained over `/api`
 * where the origin *is* checked. `ws.ts` spends it. A gateway presents its
 * token, as it always did.
 */
export const allowSocket = (request: FastifyRequest): boolean => hasPeerToken(request)

/**
 * Whether the built page and its assets may be served.
 *
 * Anyone who addressed us by a name we answer to, because a login page that
 * needs a login is not a login page. This was `isLoopback`, which behind a
 * proxy is every caller on earth -- so this is an honest statement of what was
 * already happening rather than a new exposure. It serves the shell, the
 * bundle, the manifest and the icons; every byte about projects, worktrees and
 * sessions is behind `/api`.
 */
const allowPage = (request: FastifyRequest): boolean => hostAllowed(request)

/**
 * Reached without a credential, by exact match.
 *
 * `/api/health` says `{ok:true}` and is what `swb` polls. `/api/login` is where
 * a credential is obtained, so it cannot need one; it runs its own origin rule
 * and its own throttle. `/api/logout` only ever clears a cookie, and a session
 * too broken to pass the gate is exactly when you want to log out.
 *
 * Exact matches, never a prefix: `startsWith('/api/health')` also exempted
 * `/api/healthz` and anything anyone adds under that stem later.
 */
const OPEN_ROUTES: ReadonlySet<string> = new Set(['/api/health', '/api/login', '/api/logout'])

export const registerGate = (app: FastifyInstance): void => {
  app.addHook('onRequest', async (request, reply) => {
    /*
     * Keyed on the route Fastify matched, never on the URL text. `request.url`
     * is the raw request target and the router matches the *decoded* path, so
     * the two disagree -- and every spelling of that disagreement was a way
     * through: measured against a real peer, `GET /%61pi/snapshot` returned the
     * full snapshot and `POST /%61pi/sessions` spawned a live shell.
     */
    const route = request.routeOptions.url
    if (route === undefined || !route.startsWith('/api')) {
      // `/ws` runs its own rule at the upgrade, where a hook cannot reach.
      if (route === '/ws') return
      // No `route !== undefined` guard: an unmatched path falls to the SPA
      // catch-all, which would serve the page by the back door. 404 rather than
      // 401 because there is nothing here to authenticate to.
      if (!allowPage(request)) await reply.status(404).send({ error: 'not found' })
      return
    }
    if (OPEN_ROUTES.has(route)) return

    const verdict = judgeRequest(request)
    if (verdict === 'host') {
      await reply.status(404).send({ error: 'not found' })
      return
    }
    if (verdict === 'auth') {
      /*
       * A cookie that does not verify is cleared on the way out. Without this,
       * `pnpm password` -- which invalidates every token by design -- can leave
       * a browser holding a stale cookie that keeps being chosen ahead of the
       * fresh one, which reads as a login that silently does nothing.
       */
      if (bearsCookie(request)) {
        void reply.header('set-cookie', clearedCookies(request.headers.host))
      }
      await reply
        .status(401)
        .send({ error: 'not allowed', code: hasPassword() ? 'auth-required' : 'password-not-set' })
      return
    }
    /*
     * Sliding expiry, re-issued from here rather than from a route so that every
     * request is a chance to extend. `iat` is carried over unchanged, so the
     * absolute cap still bites however long the session keeps being used.
     */
    const session = cookieSession(request)
    if (session !== null && session.exp - Date.now() < IDLE_MS / 2) {
      const fresh = mintSession(session.iat)
      if (fresh !== null) void reply.header('set-cookie', cookieFor(request.headers.host, fresh))
    }
  })
}
