import { createHash } from 'node:crypto'

/**
 * Ids a peer handed us, made unambiguous on this machine.
 *
 * A peer is an unmodified instance: it knows nothing about us and hands out its
 * own ids, which are a hash of an absolute path. `/home/you/src/ide` on two
 * machines hashes identically, so without a namespace the two would silently
 * alias -- and these ids key the state store, tmux's own metadata and every
 * route parameter, so aliasing is not a display bug, it is one worktree's
 * operations landing on another's.
 *
 * Scoping happens **here, on the server**, not in the browser. The browser then
 * never learns that a project is remote, which is what leaves `api.ts`,
 * `store.ts`, `socket.ts` and the whole layout untouched.
 */

/**
 * `~`, and the choice is not cosmetic.
 *
 * A scoped id goes in a URL path (`/api/worktrees/<scoped>/changes`), so it has
 * to survive every proxy in front of this server unchanged. `~` is unreserved
 * in RFC 3986 and needs no encoding at all; the obvious alternatives do. This
 * was `|` over a base URL, which meant `%2F` and `%3A` in a path segment --
 * and Caddy normalizes percent-encoded slashes, so the route would arrive
 * split into segments that match nothing.
 */
const SEP = '~'

/**
 * A peer, named by something short and opaque.
 *
 * Deliberately not the base URL: it would put a scheme, a colon and slashes
 * into every id, and ids travel in paths. This is a hash of the base URL, so
 * it is stable across restarts without being stored, and it says nothing about
 * the peer to anyone reading a URL.
 *
 * The empty key is this machine, whose ids are left exactly as they were --
 * they are recorded inside tmux's own metadata, so scoping one would orphan a
 * running session.
 */
export type HostKey = string

export const hostKeyFor = (baseUrl: string): HostKey =>
  `h${createHash('sha1').update(baseUrl).digest('hex').slice(0, 8)}`

export const scopeId = (host: HostKey, id: string): string =>
  host === '' ? id : `${host}${SEP}${id}`

/**
 * `null` when the id is one of ours.
 *
 * The host key has to match its exact shape, not merely "there is a separator
 * in here". Anything the client sends is run past this to decide which machine
 * a request is for, and a todo's prompt is a string like any other: `rm -rf ~`
 * would otherwise read as a scoped id and route the whole request to a peer
 * that does not exist. Measured as a 404 on a perfectly ordinary prompt.
 */
const SCOPED = /^(h[0-9a-f]{8})~(.+)$/

export const unscopeId = (scoped: string): { host: HostKey; id: string } | null => {
  const match = SCOPED.exec(scoped)
  return match === null ? null : { host: match[1] as string, id: match[2] as string }
}

export const isScoped = (id: string): boolean => SCOPED.test(id)

/**
 * The field names that carry an id, and the reason this is a list.
 *
 * Rewriting happens by field name over whatever JSON the peer sent, so that one
 * function covers every route rather than each route being mirrored by hand --
 * the peer runs this same program, so its replies are these same types.
 *
 * That is only safe because no other type in the model reuses these four names:
 * `Commit` has `hash`, and `FileChange`, `FileEntry` and `FileHit` have no id
 * at all. `test/scope.test.ts` asserts exactly that against the model, so a
 * fifth id-bearing field -- or an `id` added to a value type -- fails a test
 * rather than quietly travelling unscoped.
 */
export const ID_FIELDS = ['id', 'projectId', 'worktreeId', 'sessionId'] as const

const walk = (value: unknown, map: (id: string) => string): unknown => {
  if (Array.isArray(value)) return value.map((v) => walk(v, map))
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      typeof v === 'string' && (ID_FIELDS as readonly string[]).includes(key) ? map(v) : walk(v, map)
  }
  return out
}

/** Every id in a peer's reply, made ours. */
export const scopeTree = <T>(host: HostKey, value: T): T =>
  walk(value, (id) => scopeId(host, id)) as T

/** Every id in a request, made the peer's again. */
export const unscopeTree = <T>(value: T): T =>
  walk(value, (id) => unscopeId(id)?.id ?? id) as T
