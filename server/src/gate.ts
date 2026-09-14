import type { FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { config } from './config.js'

/**
 * Who may reach this server's API and its socket.
 *
 * There are exactly two kinds of caller, and no login, no cookie and no session
 * between them:
 *
 * - **Our own page**, in a browser. Recognised by Fetch Metadata, never by a
 *   cookie: `Sec-Fetch-Site` is set by the browser on every request including a
 *   same-origin GET, and script cannot forge it. That is what makes it usable
 *   where `Origin` is not -- a browser omits `Origin` entirely on a same-origin
 *   GET, so a check built on it would refuse the very page we serve.
 * - **A gateway**, which is this same program on another machine reading a
 *   project that lives here. It is not a browser, sends no Fetch Metadata, and
 *   presents `SWB_TOKEN` instead.
 *
 * `SWB_TOKEN` is what a machine sets to *be* a peer. Unset, this behaves
 * exactly as it always has and the bind address is the boundary; set, a caller
 * that is neither of the two above is refused, which is what makes it safe to
 * bind something other than loopback.
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

export const allowRequest = (request: FastifyRequest): boolean =>
  config.token === undefined || isOwnPage(request) || hasPeerToken(request)
