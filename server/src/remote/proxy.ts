import type { FastifyInstance } from 'fastify'
import type { Workspace } from '../workspace.js'
import { HttpError } from '../http-error.js'
import { ID_FIELDS, unscopeId } from './scope.js'
import { PeerUnreachable, type PeerClient } from './peer.js'

/**
 * Every request that names something on another machine, forwarded there.
 *
 * One hook rather than a remote branch in each of twenty-five routes, and the
 * reason it can be one hook is that **a peer runs this same program**: the path
 * that answers here answers there, with the same body and the same reply. So
 * the whole of the translation is the ids -- out of the path and the body on
 * the way there, back into the reply on the way home -- and none of it is
 * per-route. A route added later is proxied without anyone remembering to.
 *
 * Three ways a request says which machine it is for, in this order:
 *
 * 1. **A scoped id in the path.** The resource itself, and so the most
 *    specific thing available.
 * 2. **A scoped id in a body field that carries ids.** `POST /api/sessions`
 *    names its `worktreeId` that way.
 * 3. **`?host=`**, for the two reads that name no resource at all: browsing a
 *    machine's filesystem and listing what it recently closed.
 *
 * Plus one that looks like none of them: `POST /api/worktrees` carries a
 * *project* id, and a remote project's id is our pointer's and therefore bare.
 * That is resolved through the store instead -- see `remoteProject`.
 *
 * `/api/snapshot` is the one exception and is handled in `workspace.ts`: it is
 * the merge of every machine rather than a question for one of them.
 */

/** `decodeURIComponent` that answers rather than throwing on `%zz`. */
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape is not ours to interpret. Left alone, it cannot match
    // a scoped id, so the request is handled locally and the route decides --
    // which is a 404, where decoding here was a 500.
    return segment
  }
}

const pathOf = (url: string): string => url.split('?')[0] ?? ''

/** The peer named by a scoped id in the path, if any. */
const keyInPath = (url: string): string | null => {
  for (const segment of pathOf(url).split('/')) {
    const scoped = unscopeId(decode(segment))
    if (scoped) return scoped.host
  }
  return null
}

/** The peer named by a scoped id in a body field that carries ids. */
const keyInBody = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null
  // Only the fields that carry ids, never every string in the body. A todo's
  // prompt is a string too, and deciding which machine a request is for by
  // scanning free text is how `rm -rf ~` becomes a route to nowhere.
  for (const field of ID_FIELDS) {
    const value = (body as Record<string, unknown>)[field]
    if (typeof value !== 'string') continue
    const scoped = unscopeId(value)
    if (scoped) return scoped.host
  }
  return null
}

const keyInQuery = (query: unknown): string | null => {
  if (typeof query !== 'object' || query === null) return null
  const host = (query as Record<string, unknown>).host
  return typeof host === 'string' && host !== '' ? host : null
}

/**
 * The same URL with every scoped id reduced to the peer's own, and `host`
 * removed -- it addressed the peer and means nothing to it.
 */
const unscopeUrl = (url: string): string => {
  const path = pathOf(url)
    .split('/')
    .map((segment) => {
      const scoped = unscopeId(decode(segment))
      return scoped === null ? segment : encodeURIComponent(scoped.id)
    })
    .join('/')
  const rawQuery = url.split('?')[1]
  if (rawQuery === undefined) return path
  const query = new URLSearchParams(rawQuery)
  query.delete('host')
  const rest = query.toString()
  return rest === '' ? path : `${path}?${rest}`
}

export const registerProxy = (app: FastifyInstance, workspace: Workspace): void => {
  app.addHook('preHandler', async (request, reply) => {
    // The route that matched, not the URL text: the two disagree for every
    // percent-encoded or absolute-form spelling. See the gate in index.ts.
    const route = request.routeOptions.url ?? ''
    if (!route.startsWith('/api')) return
    /*
     * The snapshot is the merge of every machine, not a question for one of
     * them, and `workspace.ts` builds it. Forwarded whole it would have handed
     * back the peer's entire world -- its own unregistered projects, and the
     * `ui` blob that `PeerClient.snapshot` exists to strip at the boundary.
     */
    if (route === '/api/snapshot') return
    // An absolute-form target would be pasted straight onto the peer's base
    // URL. Nothing legitimate sends one to this server.
    if (!request.url.startsWith('/')) throw new HttpError(400, 'bad request target')

    /*
     * Every machine the request names, from all three places at once.
     *
     * Collected rather than taken in priority order, because silently
     * resolving a disagreement is the thing that lands a request on another
     * machine's identically-pathed worktree -- and worktree ids hash the bare
     * path, so the wrong peer *answering* is the normal case, not a miss.
     * `?host=B` beside a path id belonging to A used to be sent to B with A's
     * bare id. Two names is a request nobody meant to make.
     */
    const named = new Set(
      [keyInPath(request.url), keyInBody(request.body), keyInQuery(request.query)].filter(
        (key): key is string => key !== null,
      ),
    )
    if (named.size > 1) throw new HttpError(400, 'that request names two different servers')
    const key = [...named][0] ?? null

    let peer: PeerClient | null = null
    let body = request.body
    if (key !== null) {
      peer = workspace.peerFor(key)
      if (peer === null) throw new HttpError(404, 'no such server')
    } else {
      // A project id is bare even when the project is remote, so the store is
      // what knows. The peer calls the project something else -- the same root
      // hashed without a base URL -- so the body has to say the peer's name.
      const projectId = (request.body as { projectId?: unknown } | null)?.projectId
      if (typeof projectId !== 'string') return
      const remote = workspace.remoteProject(projectId)
      if (remote === null) return
      peer = remote.peer
      body = { ...(request.body as Record<string, unknown>), projectId: remote.peerProjectId }
    }

    try {
      const result = await peer.request<unknown>(
        request.method,
        unscopeUrl(request.url),
        // `undefined` for a GET: a body on one is not merely pointless, it is
        // what makes `fetch` refuse outright.
        request.method === 'GET' || request.method === 'DELETE' ? undefined : body,
      )
      await reply.send(result ?? {})
    } catch (err) {
      if (err instanceof PeerUnreachable) {
        // 504, not 500: the distinction the UI needs is "that machine did not
        // answer" rather than "this one is broken", and they are fixed in
        // different places.
        throw new HttpError(504, `${peer.baseUrl} did not answer: ${err.reason}`)
      }
      throw err
    }
  })
}
