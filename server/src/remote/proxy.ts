import type { FastifyInstance } from 'fastify'
import type { Workspace } from '../workspace.js'
import { HttpError } from '../http-error.js'
import { ID_FIELDS, unscopeId, unscopeTree } from './scope.js'
import { PeerUnreachable } from './peer.js'

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
 * What decides the peer is the *scoped id in the request itself*, wherever it
 * appears: `/api/worktrees/<id>/diff` carries it in the path, `POST
 * /api/sessions` carries it in `worktreeId`, and `POST /api/worktrees` carries
 * it in `projectId`. Nothing has to know which is which.
 *
 * `/api/snapshot` is the one exception and is handled in `workspace.ts`: it is
 * the merge of every machine rather than a question for one of them.
 *
 * `?host=<key>` is the other way in, for the two reads that name no worktree at
 * all: browsing a machine's filesystem and listing what it recently closed. The
 * open dialog walks the peer's disk that way, through our own API, so the
 * browser still speaks to one origin.
 */

/** The first scoped id in the path, the query, or a top-level body field. */
const peerKeyOf = (url: string, query: unknown, body: unknown): string | null => {
  if (typeof query === 'object' && query !== null) {
    const host = (query as Record<string, unknown>).host
    if (typeof host === 'string' && host !== '') return host
  }
  for (const segment of url.split('?')[0]?.split('/') ?? []) {
    const scoped = unscopeId(decodeURIComponent(segment))
    if (scoped) return scoped.host
  }
  if (typeof body === 'object' && body !== null) {
    // Only the fields that carry ids, never every string in the body. A todo's
    // prompt is a string too, and deciding which machine a request is for by
    // scanning free text is how `rm -rf ~` becomes a route to nowhere.
    for (const field of ID_FIELDS) {
      const value = (body as Record<string, unknown>)[field]
      if (typeof value !== 'string') continue
      const scoped = unscopeId(value)
      if (scoped) return scoped.host
    }
  }
  return null
}

/**
 * The same URL with every scoped id reduced to the peer's own, and `host`
 * removed -- it addressed the peer and means nothing to it.
 */
const unscopeUrl = (url: string): string => {
  const [rawPath = '', rawQuery] = url.split('?')
  const path = rawPath
    .split('/')
    .map((segment) => {
      const scoped = unscopeId(decodeURIComponent(segment))
      return scoped === null ? segment : encodeURIComponent(scoped.id)
    })
    .join('/')
  if (rawQuery === undefined) return path
  const query = new URLSearchParams(rawQuery)
  query.delete('host')
  const rest = query.toString()
  return rest === '' ? path : `${path}?${rest}`
}

export const registerProxy = (app: FastifyInstance, workspace: Workspace): void => {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api')) return
    const key = peerKeyOf(request.url, request.query, request.body)
    if (key === null) return

    const peer = workspace.peerFor(key)
    if (peer === null) throw new HttpError(404, 'no such server')

    try {
      const result = await peer.request<unknown>(
        request.method,
        unscopeUrl(request.url),
        // `undefined` for a GET: a body on one is not merely pointless, it is
        // what makes `fetch` refuse outright.
        request.method === 'GET' || request.method === 'DELETE'
          ? undefined
          : unscopeTree(request.body),
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
