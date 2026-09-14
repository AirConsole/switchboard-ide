import type { Project } from '@switchboard/shared'

/**
 * Ids a peer handed us, made unambiguous on this machine.
 *
 * A peer is an unmodified instance: it knows nothing about us and hands out its
 * own ids, which are a hash of an absolute path. `/home/andrin/src/ide` on two
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
 * Split from the **right**.
 *
 * A base URL may carry a path (a peer behind a proxy subpath) and so may
 * contain the separator; an id never can, being `wt-` or `p-` and ten hex
 * digits.
 */
const SEP = '|'

/** The empty key is this machine, whose ids are left exactly as they were. */
export type HostKey = string

export const scopeId = (host: HostKey, id: string): string =>
  host === '' ? id : `${host}${SEP}${id}`

/** `null` when the id is one of ours. */
export const unscopeId = (scoped: string): { host: HostKey; id: string } | null => {
  const cut = scoped.lastIndexOf(SEP)
  if (cut === -1) return null
  return { host: scoped.slice(0, cut), id: scoped.slice(cut + 1) }
}

export const isScoped = (id: string): boolean => id.includes(SEP)

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

/**
 * A remote project's pointer, with the credential taken out.
 *
 * `Project.host` is persisted with the peer's token in it, and the snapshot
 * goes to the browser -- so this is the one place that decides the token never
 * does. Dropped rather than blanked: a key that is absent cannot be read back
 * and written out again by a client that round-trips what it was given.
 */
export const withoutToken = (project: Project): Project =>
  project.host.kind === 'remote'
    ? { ...project, host: { kind: 'remote', baseUrl: project.host.baseUrl } }
    : project
