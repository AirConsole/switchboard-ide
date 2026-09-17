import { createHmac, hkdfSync, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.js'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/**
 * The password, the sessions it opens, and what a guess costs.
 *
 * Read this before changing anything here: a password on this IDE was built
 * once before, on branch `remote`, and abandoned after four adversarial passes
 * in five hours found sixteen holes. The worst of them was that the session
 * cookie *reopened* the command-execution hole the design existed to close, and
 * every rule below that looks paranoid is standing where one of those sixteen
 * was. The commit is `61b640e` and it is worth reading.
 *
 * Three facts shape everything in this file:
 *
 * - **A reverse proxy connects from loopback**, so behind Caddy every caller on
 *   earth arrives as `127.0.0.1`. Measured. Nothing here may be decided by the
 *   peer address, and rate limiting cannot be per-IP.
 * - **Cookies ignore the port.** A page on a sibling port of the same hostname
 *   is *same-site* and the browser hands it our cookie. `SameSite` does not
 *   separate origins, only sites, and believing otherwise is what caused the
 *   RCE. Hence `/ws` does not accept a cookie at all -- see `newTicket`.
 * - **`pnpm restart` is the deploy**, several times a day. A session key that
 *   did not survive a restart would log the owner out constantly, and they
 *   would respond by choosing a shorter password. Surviving restart is a
 *   security property here, not a convenience.
 */

export const authFile = (): string => join(config.stateDir, 'auth.json')

interface Record_ {
  stamp: string
  hash: Buffer
  salt: Buffer
  params: { N: number; r: number; p: number }
  keylen: number
  generation: number
  /** HMAC key for session tokens, derived from the hash. See `load`. */
  sessionKey: Buffer
  updatedAt: number
}

const MAXMEM = 192 * 1024 * 1024
const RECHECK_MS = 1000

let cached: Record_ | null = null
let checkedAt = 0

/**
 * The stored record, re-read when the file changes.
 *
 * Re-read rather than captured at start, because `pnpm password` runs while the
 * server is up and "changing the password revokes every session" has to be true
 * the moment it returns -- not after somebody remembers to restart. Bounded to
 * one `stat` per second, which is ~2us.
 *
 * Keyed on the inode as well as mtime and size: the file is replaced by
 * `rename`, so every write is a new inode, and two writes inside one
 * millisecond would otherwise look identical.
 *
 * A missing, unreadable or malformed file is `null`, and `null` refuses
 * everything. There is deliberately no branch anywhere that reads "no password
 * set" as "no password required" -- that was the shape of two of the sixteen.
 */
const load = (): Record_ | null => {
  const now = Date.now()
  if (cached !== null && now - checkedAt < RECHECK_MS) return cached
  checkedAt = now
  let stamp: string
  try {
    const s = statSync(authFile())
    stamp = `${s.ino}:${s.size}:${s.mtimeMs}`
  } catch {
    cached = null
    return null
  }
  if (cached?.stamp === stamp) return cached
  try {
    const raw: unknown = JSON.parse(readFileSync(authFile(), 'utf8'))
    cached = parse(stamp, raw)
  } catch {
    cached = null
  }
  return cached
}

/** @param raw the parsed file, from an untrusted-shape point of view. */
const parse = (stamp: string, raw: unknown): Record_ | null => {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || r.algorithm !== 'scrypt') return null
  const { N, p, r: rParam, keylen, generation, updatedAt } = r
  if (!Number.isInteger(N) || !Number.isInteger(rParam) || !Number.isInteger(p)) return null
  if (!Number.isInteger(keylen) || !Number.isInteger(generation)) return null
  if (typeof r.salt !== 'string' || typeof r.hash !== 'string') return null
  const salt = Buffer.from(r.salt, 'base64')
  const hash = Buffer.from(r.hash, 'base64')
  if (salt.length < 16 || hash.length !== keylen || hash.length < 32) return null
  const params = { N: N as number, r: rParam as number, p: p as number }
  if (params.N <= 1 || (params.N & (params.N - 1)) !== 0 || params.r < 1 || params.p < 1) return null
  if (128 * params.r * (params.N + params.p + 2) > MAXMEM) return null
  /*
   * The signing key is derived from the stored hash, which is what makes the
   * revocation story work without any server-side session storage: change the
   * password and the hash changes, so the key changes, so every token minted
   * under the old one stops verifying. A restart changes nothing, because the
   * hash is the same. `generation` is in the `info` so `--revoke-sessions` can
   * do the same thing without changing the password.
   */
  const sessionKey = Buffer.from(
    hkdfSync('sha256', hash, salt, `swb-session-v1:${generation as number}`, 32),
  )
  return {
    stamp,
    hash,
    salt,
    params,
    keylen: keylen as number,
    generation: generation as number,
    sessionKey,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  }
}

/** Is a password set at all? Everything refuses when this is false. */
export const hasPassword = (): boolean => load() !== null

/** When it was last written, for `swb status`. Never the hash. */
export const passwordSetAt = (): number | null => load()?.updatedAt ?? null

// ---------------------------------------------------------------------------
// Verifying the password
// ---------------------------------------------------------------------------

const MAX_QUEUED = 4
let queued = 0
let chain: Promise<unknown> = Promise.resolve()

/**
 * Whether this is the password, at a bounded cost.
 *
 * **One scrypt in flight, process-wide.** Each verification pins 64MB and runs
 * on libuv's threadpool, which has four threads and is shared with every file
 * read this server does -- so four concurrent logins would be 256MB and a
 * stalled filesystem. Anything past a short queue is refused as `busy` without
 * hashing, which is what keeps a login flood from being a memory event rather
 * than merely a slow one.
 *
 * The password is normalised here and nowhere else, so the CLI that wrote the
 * hash and the browser that types it cannot disagree: an accented character can
 * arrive as one code point from one keyboard and two from another.
 */
export const verifyPassword = async (password: string): Promise<'ok' | 'no' | 'busy'> => {
  if (queued >= MAX_QUEUED) return 'busy'
  const rec = load()
  if (rec === null) return 'no'
  // Bounded before hashing: scrypt starts with PBKDF2 over the password, and a
  // megabyte of it is free work an attacker gets to choose.
  if (password.length === 0 || Buffer.byteLength(password) > 1024) return 'no'
  queued += 1
  const run = chain.then(() =>
    scrypt(password.normalize('NFC'), rec.salt, rec.keylen, { ...rec.params, maxmem: MAXMEM }),
  )
  // A rejection must not poison the chain for every later attempt.
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  try {
    const got = await run
    return got.length === rec.hash.length && timingSafeEqual(got, rec.hash) ? 'ok' : 'no'
  } catch {
    return 'no'
  } finally {
    queued -= 1
  }
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

const DOMAIN = Buffer.from('swb-session-v1')
const PAYLOAD_BYTES = 33
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000
/**
 * Tolerance for a server clock that moved.
 *
 * Both directions cost a login and neither grants one, which is the point. A
 * clock jumping forward expires tokens early; one jumping backward makes them
 * look far-future, and the `exp` ceiling below refuses those -- which is what
 * stops a box that booted believing it was 2030 from having issued five-year
 * sessions. The temptation to "just be lenient about the future" is exactly how
 * that happens.
 */
const FUTURE_GRACE_MS = 60 * 60 * 1000

const b64 = (b: Buffer): string => b.toString('base64url')

export interface Session {
  iat: number
  exp: number
}

/** @param iat carried over on a sliding refresh, so the absolute cap still bites. */
export const mintSession = (iat: number = Date.now(), now: number = Date.now()): string | null => {
  const rec = load()
  if (rec === null) return null
  const payload = Buffer.alloc(PAYLOAD_BYTES)
  payload.writeUInt8(1, 0)
  payload.writeBigUInt64BE(BigInt(iat), 1)
  payload.writeBigUInt64BE(BigInt(now + IDLE_MS), 9)
  randomBytes(16).copy(payload, 17)
  const mac = createHmac('sha256', rec.sessionKey).update(DOMAIN).update(payload).digest()
  return `v1.${b64(payload)}.${b64(mac)}`
}

export const verifySession = (token: string | undefined): Session | null => {
  if (token === undefined || token.length > 256) return null
  const rec = load()
  if (rec === null) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, payloadText, macText] = parts
  if (payloadText === undefined || macText === undefined) return null
  const payload = Buffer.from(payloadText, 'base64url')
  const mac = Buffer.from(macText, 'base64url')
  // Length first: `timingSafeEqual` throws on a mismatch rather than returning false.
  if (payload.length !== PAYLOAD_BYTES || mac.length !== 32) return null
  /*
   * One spelling per token. base64url decoding is lossy in the other direction
   * -- several texts decode to the same bytes -- and this codebase already
   * records what a decoder and a comparator disagreeing about spelling costs:
   * `GET /%61pi/snapshot` returned the whole snapshot on a real peer.
   */
  if (b64(payload) !== payloadText || b64(mac) !== macText) return null
  const expected = createHmac('sha256', rec.sessionKey).update(DOMAIN).update(payload).digest()
  if (!timingSafeEqual(expected, mac)) return null
  // Only after the MAC: nothing unauthenticated gets to steer a branch.
  if (payload.readUInt8(0) !== 1) return null
  const iat = Number(payload.readBigUInt64BE(1))
  const exp = Number(payload.readBigUInt64BE(9))
  const now = Date.now()
  if (exp <= now) return null
  if (exp > now + IDLE_MS + FUTURE_GRACE_MS) return null
  if (iat > now + FUTURE_GRACE_MS) return null
  if (now - iat > ABSOLUTE_MS) return null
  return { iat, exp }
}

// ---------------------------------------------------------------------------
// The socket's own credential
// ---------------------------------------------------------------------------

const TICKET_MS = 30_000
const MAX_TICKETS = 64
const tickets = new Map<string, number>()

/**
 * A single-use ticket for one WebSocket upgrade.
 *
 * **The socket does not accept the cookie, and this is why.** Cookies are
 * scoped by host and ignore the port, so a page on a sibling port of the same
 * hostname is same-site and the browser attaches our cookie to a socket that
 * page opens -- and a WebSocket is exempt from CORS, so nothing else is in the
 * way. That is not hypothetical for this deployment: the Caddy in front of it
 * serves five ports on one hostname, and one of them has no auth at all. It was
 * measured end to end on the previous attempt: `attach`, `focus`, `input`, and
 * a shell command ran as the user from a page they merely visited.
 *
 * A ticket is obtained over `/api`, which *is* origin-checked, so a hostile
 * same-site page cannot get one: its fetch is cross-origin, refused by the
 * Fetch Metadata rule, and unreadable to it even if it were not. Whatever the
 * browser does with the cookie on the socket is then irrelevant, because the
 * cookie is not what the socket accepts.
 *
 * It travels in the WebSocket subprotocol rather than the URL: a browser cannot
 * set a header on an upgrade, and a query string is written to every access log
 * on the way.
 */
export const newTicket = (): string => {
  const now = Date.now()
  for (const [value, expires] of tickets) if (expires <= now) tickets.delete(value)
  // A cap, because a valid session could otherwise mint these forever. Oldest
  // first, which is what `Map` iteration already gives.
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next()
    if (oldest.done === true) break
    tickets.delete(oldest.value)
  }
  const value = randomBytes(32).toString('base64url')
  tickets.set(value, now + TICKET_MS)
  return value
}

/** Spends a ticket. False for one already used, expired, or never issued. */
export const spendTicket = (value: string | undefined): boolean => {
  if (value === undefined) return false
  const expires = tickets.get(value)
  if (expires === undefined) return false
  tickets.delete(value)
  return expires > Date.now()
}

/** Every outstanding ticket, dropped. Called when the password changes. */
export const dropTickets = (): void => tickets.clear()

// ---------------------------------------------------------------------------
// What a guess costs
// ---------------------------------------------------------------------------

/**
 * The throttle, and it must cost the same whether the guess was right.
 *
 * Recovered from the previous attempt, where it was measured wrong twice:
 *
 * **It was a timing oracle.** Counting consecutive *failures* meant a correct
 * password reset the counter, so the next request came back in 86ms instead of
 * 4089ms -- which answered for the previous guess, from a page whose every
 * fetch was CORS-rejected, so hiding the response body hid nothing. The inverse
 * leaks equally. So this counts **attempts, never outcomes**, and a correct
 * password buys no relief at all.
 *
 * **And it was per batch, not per guess.** The delay was read when the promise
 * was created, so a thousand concurrent requests all slept the same interval
 * and then all failed: 0.51/s serially against 33.8/s at 1000-way concurrency,
 * ~135x what the cap implied. A slot is *claimed* now -- `nextSlot` only ever
 * moves forward -- so concurrency queues instead of overlapping.
 *
 * Attempts decay, because a hostile flood must not lock the owner out of their
 * own machine; with nobody guessing the ramp is gone within a minute. And past
 * a ceiling a guess is refused outright rather than queued, because serialising
 * an unbounded queue is itself the lockout the delay exists to avoid.
 */
const STEP_MS = 250
const MAX_STEP_MS = 5000
const DECAY_MS = 20_000
const MAX_WAIT_MS = 20_000

let attempts = 0
let decayedAt = Date.now()
let nextSlot = 0

/** @returns the epoch ms this attempt may be answered at, or null to refuse it. */
export const claimSlot = (now: number = Date.now()): number | null => {
  const forgiven = Math.floor((now - decayedAt) / DECAY_MS)
  if (forgiven > 0) {
    attempts = Math.max(0, attempts - forgiven)
    decayedAt = now
  }
  const step = Math.min(MAX_STEP_MS, STEP_MS * 2 ** Math.min(attempts, 16))
  const slot = Math.max(now, nextSlot) + step
  if (slot - now > MAX_WAIT_MS) return null
  attempts += 1
  nextSlot = slot
  return slot
}

/** Only for tests: the ramp is process-wide and otherwise leaks between them. */
export const resetSlots = (): void => {
  attempts = 0
  decayedAt = Date.now()
  nextSlot = 0
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Two names, and the port is not in either.
 *
 * `__Host-` is browser-enforced: it is refused unless the cookie is `Secure`,
 * `Path=/` and carries no `Domain`. That is what stops anything else under
 * `n-dream.com` shadowing ours with a `Domain=` cookie -- a live concern here,
 * since this deployment has sibling names. It cannot be used over plain http,
 * so a loopback instance falls back to an ordinary name.
 */
const SECURE_COOKIE = '__Host-swb'
const PLAIN_COOKIE = 'swb_session'
export const COOKIE_NAMES = [SECURE_COOKIE, PLAIN_COOKIE] as const

/**
 * Every value under `name`, in order.
 *
 * *Every*, not the first: anything able to set a `Domain=` cookie of the same
 * name on a parent domain adds a second entry, and browsers order equal-path
 * cookies by creation time, so an older plant always wins. A reader taking the
 * first match is then permanently signed out with no cure but clearing site
 * data. That is not session theft -- the plant cannot be forged into a valid
 * token -- but it is a denial of service anyone on a sibling name can perform.
 */
export const cookieValues = (header: string | undefined, name: string): string[] => {
  if (header === undefined || header.length > 8192) return []
  const found: string[] = []
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    if (part.slice(0, at).trim() !== name) continue
    const value = part.slice(at + 1).trim()
    // No percent-decoding: the token alphabet is base64url and `.`, so it never
    // needs encoding -- and decoding here would create a second spelling of
    // every token, which is the class of bug `/%61pi/snapshot` already records.
    if (value !== '') found.push(value)
  }
  return found
}

/**
 * Whether this reply's cookie may carry `Secure`.
 *
 * Keyed on the name we were addressed by, not on `x-forwarded-proto`: this
 * process deliberately does not trust headers about the connection
 * (`trustProxy` is off), and making a security attribute depend on another
 * program's configuration is how it silently stops being set. `Host` is
 * attacker-chosen too, but only on the attacker's *own* request -- they cannot
 * make somebody else's browser send a loopback Host to the public name, so the
 * only session they can downgrade is their own.
 */
export const secureFor = (host: string | undefined): boolean => {
  if (host === undefined) return true
  try {
    const name = new URL(`http://${host}`).hostname
    return !(name === 'localhost' || name === '127.0.0.1' || name === '::1')
  } catch {
    return true
  }
}

export const cookieFor = (host: string | undefined, token: string): string => {
  const secure = secureFor(host)
  return [
    `${secure ? SECURE_COOKIE : PLAIN_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Strict, not Lax. Lax still sends the cookie on a top-level cross-site
    // GET, and `GET /api/usage` execs a process. Nothing is lost: a bookmark or
    // an address-bar navigation has no initiator and counts as same-site, so
    // only following a link from another site costs a sign-in.
    'SameSite=Strict',
    secure ? 'Secure' : '',
    `Max-Age=${Math.floor(IDLE_MS / 1000)}`,
  ]
    .filter((part) => part !== '')
    .join('; ')
}

/** Both names, cleared. A clear only matches if its attributes match the set. */
export const clearedCookies = (host: string | undefined): string[] => {
  const secure = secureFor(host)
  return COOKIE_NAMES.map((name) =>
    [
      `${name}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      name === SECURE_COOKIE || secure ? 'Secure' : '',
      'Max-Age=0',
    ]
      .filter((part) => part !== '')
      .join('; '),
  )
}

// ---------------------------------------------------------------------------
// The local tool's credential
// ---------------------------------------------------------------------------

export const localFile = (): string => join(config.stateDir, 'local.json')

/**
 * A session token on disk, for the CLI on this machine.
 *
 * `swb status` and the readiness poll that `pnpm restart` waits on both call
 * `/api/server`, which is now behind the gate -- so without this, turning the
 * password on would break the deploy, and the failure would be a restart that
 * hangs and then reports the server never came back.
 *
 * It is an ordinary session token, not a new kind of credential, so there is no
 * extra branch in the gate to get wrong and no second piece of crypto to keep
 * in step. Reading it requires being the user, who can already attach to the
 * tmux socket and read `state.json`; it adds no exposure that was not already
 * there. It dies with the password, like everything else.
 */
export const writeLocalToken = (): void => {
  const token = mintSession()
  if (token === null) return
  mkdirSync(config.stateDir, { recursive: true })
  const target = localFile()
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}
