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
 * `POST /api/worktrees` needs no fourth way, and that is worth saying because
 * it used to: a remote project's id is now the peer's own, scoped like every
 * other id, so the route that addresses a project routes itself. When the
 * gateway minted its own id for a remote project, nothing about that id said
 * "another machine" and the request was answered locally and refused -- so
 * creating a worktree on a remote project was simply unreachable.
 *
 * `/api/snapshot` is the one exception and is handled in `workspace.ts`: it is
 * the merge of every machine rather than a question for one of them.
 */

const READ_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 120_000

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

/** Every peer named by a scoped id in the path. */
const keysInPath = (url: string): string[] =>
  pathOf(url)
    .split('/')
    .map((segment) => unscopeId(decode(segment))?.host)
    .filter((host): host is string => host !== undefined)

/**
 * Every peer named by a scoped id in a body field that carries ids.
 *
 * All of them, not the first: two ids from different machines in one body would
 * otherwise go to whichever came first in `ID_FIELDS`, with the other reduced
 * to a bare id and delivered to a machine it does not belong to -- and because
 * ids hash the bare path, the wrong peer *answering* is the normal case.
 *
 * Only the fields that carry ids, never every string in the body. A todo's
 * prompt is a string too, and deciding which machine a request is for by
 * scanning free text is how `rm -rf ~` becomes a route to nowhere.
 */
const keysInBody = (body: unknown): string[] => {
  if (typeof body !== 'object' || body === null) return []
  const found: string[] = []
  for (const field of ID_FIELDS) {
    const value = (body as Record<string, unknown>)[field]
    if (typeof value !== 'string') continue
    const scoped = unscopeId(value)
    if (scoped) found.push(scoped.host)
  }
  return found
}

const keyInQuery = (query: unknown): string | null => {
  if (typeof query !== 'object' || query === null) return null
  const host = (query as Record<string, unknown>).host
  if (host === undefined) return null
  /*
   * Anything but one string is refused, not ignored. Fastify yields an *array*
   * for a repeated key, and returning null for it meant `?host=A&host=A` was
   * answered by this machine instead of A -- measured, `POST /api/projects`
   * with `create` then made the directory and the repository here rather than
   * there, which is the one mistake the open dialog carries three guards
   * against. Every other ambiguity in this hook fails closed; this one failed
   * open.
   */
  if (typeof host !== 'string' || host === '') {
    throw new HttpError(400, 'that request names a server more than once')
  }
  return host
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
    /*
     * And `/api/health`, which the gate lets through unauthenticated. Left
     * proxyable, an anonymous caller could make a token-holding gateway open a
     * credentialed request to a registered machine -- `GET /api/health?host=…`
     * reached the hook and answered "no such server", which is a liveness
     * oracle on a route that is meant to say nothing but `{ok:true}`. The two
     * exemption lists have to agree.
     */
    if (route === '/api/health') return
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
    const named = new Set([
      ...keysInPath(request.url),
      ...keysInBody(request.body),
      ...(keyInQuery(request.query) === null ? [] : [keyInQuery(request.query) as string]),
    ])
    if (named.size > 1) throw new HttpError(400, 'that request names two different servers')
    const key = [...named][0] ?? null

    if (key === null) return
    const peer = workspace.peerFor(key)
    if (peer === null) throw new HttpError(404, 'no such server')
    const body = request.body

    try {
      // GET alone. A proxied DELETE is `git worktree remove --force` plus
      // killing its sessions and maybe deleting a branch -- the very shape the
      // long timeout exists for, and aborting it cancels nothing on the peer.
      const reads = request.method === 'GET'
      const result = await peer.request<unknown>(
        request.method,
        unscopeUrl(request.url),
        // `undefined` for a GET or a DELETE: `fetch` refuses a body on a GET
        // outright, and no proxied DELETE carries one.
        reads || request.method === 'DELETE' ? undefined : body,
        /*
         * A mutation gets far longer than a read, because the wait is a
         * different kind. `POST /api/worktrees` is a `git worktree add` -- a
         * whole checkout -- plus starting an agent, and on a large repository
         * that passes ten seconds routinely. Aborting here cancels nothing on
         * the peer: it finishes the worktree while we answer "did not answer",
         * and the retry then fails with "branch already exists".
         */
        reads ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
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
