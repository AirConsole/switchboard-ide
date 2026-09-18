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

/**
 * Every id this request routes by: the route's own parameters, and the body
 * fields that carry ids.
 *
 * The params rather than every path segment, because a param *is* an id by
 * construction -- every route in this API takes `:id` and nothing else -- while
 * a segment might be anything. That distinction is what lets a **bare** id be
 * read as "this machine" rather than as "no opinion".
 *
 * Only the fields that carry ids, never every string in the body. A todo's
 * prompt is a string too, and deciding which machine a request is for by
 * scanning free text is how `rm -rf ~` becomes a route to nowhere.
 */
const idsIn = (params: unknown, body: unknown): string[] => {
  const found: string[] = []
  if (typeof params === 'object' && params !== null) {
    for (const value of Object.values(params as Record<string, unknown>)) {
      /*
       * Not decoded again. Fastify has already percent-decoded a param, and a
       * second pass made routing read an id that `unscopeUrl` -- which decodes
       * once, from the raw URL -- did not: `%257E` became `~` here and stayed
       * `%7E` there, so the request was forwarded without the id that chose its
       * destination. No id needs encoding today; the extra decode was a
       * leftover from when this scanned raw path segments.
       */
      if (typeof value === 'string' && value !== '') found.push(value)
    }
  }
  if (typeof body === 'object' && body !== null) {
    for (const field of ID_FIELDS) {
      const value = (body as Record<string, unknown>)[field]
      if (typeof value === 'string' && value !== '') found.push(value)
    }
  }
  return found
}

/**
 * The only routes `?host=` may steer.
 *
 * Everything else that belongs to another machine says so in its own id, and
 * routes itself. `?host=` exists for the two reads that name no resource --
 * browsing a machine's disk and listing what it recently closed -- and for the
 * one write that creates the resource it would otherwise name.
 *
 * An allow-list, because the alternative was measured and it is destructive:
 * `PATCH /api/ui?host=B` replaced **B's stored layout** -- its panels, open
 * files and expanded trees, for the person sitting at B -- and
 * `POST /api/servers?host=B` linked B to a machine of the caller's choosing,
 * with a token the caller supplied. `ui` in particular is what
 * `PeerClient.snapshot` strips at the boundary because "the layout is the
 * viewer's"; enforcing that on the read side only was half a rule.
 */
/**
 * Routes that are answered here, whatever ids they carry.
 *
 * `/api/snapshot` is the merge of every machine rather than a question for one.
 * `/api/health` says `{ok:true}` and is reached without credentials, so it must
 * not be a lever on a machine the caller cannot otherwise reach. The other two
 * are this machine's own business and it is measurable what happens without
 * them: a `worktreeId` in a `PATCH /api/ui` body steered the patch to the peer
 * and **replaced its stored layout** -- the panels, open files and expanded
 * trees of whoever sits there -- and returned that layout to the caller, the
 * one blob `PeerClient.snapshot` strips at the boundary precisely so it never
 * travels. A body id did that while `?host=` was refused: the allow-list below
 * guarded one door of three.
 *
 * So this is checked before any of them, and `HOST_STEERABLE` narrows only the
 * door that has no resource to name.
 */
const ALWAYS_LOCAL: ReadonlySet<string> = new Set([
  '/api/snapshot',
  '/api/health',
  '/api/ui',
  '/api/servers',
  /*
   * The credential routes, and this is not a formality. `POST /api/login?host=B`
   * would forward the password to whatever machine B is -- you would be typing
   * your password into another box's log. The same shape as the two this file
   * already records: `?host=B` on `/api/servers` linked B to a machine of the
   * caller's choosing, and a body id steered `PATCH /api/ui` onto a peer.
   * A ticket is for this machine's socket and means nothing on another.
   */
  '/api/login',
  '/api/logout',
  '/api/ws-ticket',
])

/**
 * Routes whose reply is bytes rather than JSON.
 *
 * Named, rather than sniffed from the peer's `content-type`, because what to
 * do with a reply is a property of the route and guessing it would make every
 * other route's error handling depend on a header the peer chose.
 */
const RAW_ROUTES: ReadonlySet<string> = new Set(['/api/worktrees/:id/raw'])

const HOST_STEERABLE: ReadonlySet<string> = new Set([
  '/api/browse',
  '/api/recents',
  '/api/projects',
])

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
    if (ALWAYS_LOCAL.has(route)) return

    /*
     * Evaluated on every route, used on three. A `?host=` on a route that does
     * not take one is refused rather than ignored: it named a machine, and
     * quietly sending the request somewhere else -- even somewhere safe -- is
     * how a caller's mistake becomes an afternoon.
     */
    const asked = keyInQuery(request.query)
    if (asked !== null && !HOST_STEERABLE.has(route)) {
      throw new HttpError(400, 'that route does not take a server')
    }
    const steered = asked

    /*
     * Which machines this request names -- and a **bare** id names *this* one,
     * which is why it is collected too.
     *
     * Mixing a bare id with a scoped one is a cross-machine operation that no
     * route supports, and it used to be sent to the remote machine carrying the
     * local id: `PATCH /api/todos/<local>` with a remote `worktreeId` -- moving
     * a todo to a worktree on another machine -- went there and 404'd. Not
     * reachable from the dialog, which offers only the project's own worktrees,
     * and not destructive. But the same guard already refuses two *remote*
     * machines, and for the same reason: silently resolving the ambiguity is
     * what lands an operation on another machine's identically-pathed worktree.
     */
    const ids = idsIn(request.params, request.body)
    const named = new Set([
      ...ids.map((id) => unscopeId(id)?.host).filter((host): host is string => host !== undefined),
      ...(steered === null ? [] : [steered]),
    ])
    const namesThisMachine = ids.some((id) => unscopeId(id) === null)
    if (named.size > 1 || (named.size > 0 && namesThisMachine)) {
      throw new HttpError(400, 'that request names more than one machine')
    }
    const key = [...named][0] ?? null

    if (key === null) return
    const peer = workspace.peerFor(key)
    if (peer === null) throw new HttpError(404, 'no such server')
    const body = request.body

    try {
      // GET alone. A proxied DELETE is `git worktree remove --force` plus
      // killing its sessions and maybe deleting a branch -- the very shape the
      // long timeout exists for, and aborting it cancels nothing on the peer.
      if (RAW_ROUTES.has(route)) {
        const range = typeof request.headers.range === 'string' ? request.headers.range : undefined
        const raw = await peer.streamRaw(unscopeUrl(request.url), range)
        /*
         * The peer's own answer, headers and all -- including the policy it
         * chose for this file. See `RAW_HEADERS`.
         */
        void reply.status(raw.status)
        for (const [name, value] of Object.entries(raw.headers)) void reply.header(name, value)
        /*
         * Let go of the peer when the browser does. Fastify destroys the reply
         * stream, but the `fetch` upstream of it is not cancelled by that, and
         * the peer goes on writing into a pipe nobody is reading.
         *
         * Not an edge case: **every seek in a video cancels the range request
         * in flight**, so a minute of scrubbing is a minute of abandoned
         * connections and a peer-side read per seek.
         */
        reply.raw.on('close', () => {
          if (!reply.raw.writableEnded) raw.abort()
        })
        await reply.send(raw.body ?? '')
        return
      }
      const reads = request.method === 'GET'
      const result = await peer.request<unknown>(
        request.method,
        unscopeUrl(request.url),
        // `undefined` for a GET, which `fetch` refuses a body on outright.
        // A DELETE may carry one -- `DELETE /api/servers` does -- and dropping
        // it answered "expected object, received undefined".
        reads ? undefined : body,
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
