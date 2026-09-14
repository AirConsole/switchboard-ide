import { PROTOCOL_VERSION, type AppSnapshot } from '@switchboard/shared'
import { HttpError } from '../http-error.js'
import { hostKeyFor, scopeTree, unscopeTree, type HostKey } from './scope.js'

/**
 * One peer, spoken to over its ordinary API.
 *
 * A peer is this same program on another machine. It is not modified to be a
 * peer and has no idea anyone remote is asking -- which is the point: there is
 * one server program, and "gateway" is a role this process plays for a project
 * whose files live elsewhere, not a second kind of build.
 *
 * Everything here is server-to-server. No browser ever talks to a peer, so
 * there is no CORS, no cookie, no preflight and no login page in this design --
 * the credential is a token this process holds and the user's browser never
 * sees. That is most of what a direct browser-to-peer design has to build.
 */

/** Normalized so it can be hashed into an id and compared character by character. */
export const normalizeBaseUrl = (raw: string): string => {
  const url = new URL(raw.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'a server is http:// or https://')
  }
  // Query and fragment are not part of a base, and a trailing slash would make
  // `http://h:8210` and `http://h:8210/` two peers for one machine -- they are
  // hashed into a project id, so that is two projects that never reconcile.
  url.search = ''
  url.hash = ''
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export interface PeerIdentity {
  name: string
  protocolVersion: number
}

/**
 * Unreachable is a result, not a throw.
 *
 * A peer is another machine: it is switched off, rebooting, or mid-deploy as a
 * matter of course, and none of that is an error in *this* server. The
 * distinction matters at the snapshot, where "that machine did not answer" must
 * leave its worktrees on screen rather than deleting them -- see the pruning
 * note in workspace.ts.
 */
export class PeerUnreachable extends Error {
  constructor(readonly baseUrl: string, readonly reason: string) {
    super(`${baseUrl}: ${reason}`)
  }
}

export class PeerClient {
  /** Short, opaque, and derived -- so nothing has to store or reconcile it. */
  readonly key: HostKey

  constructor(
    readonly baseUrl: string,
    private readonly token: string | undefined,
  ) {
    this.key = hostKeyFor(baseUrl)
  }

  /**
   * One request, with our ids translated out and the peer's translated in.
   *
   * `signal` rather than a bare await: a peer that accepts a connection and
   * then says nothing would otherwise hold the snapshot open for as long as the
   * OS allows, and the snapshot is what paints the whole row.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.token === undefined ? {} : { 'x-swb-token': this.token }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(unscopeTree(body)) }),
      })
    } catch (err) {
      throw new PeerUnreachable(this.baseUrl, err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    if (!response.ok) {
      // The peer's own message, kept: it is this program, so "no such worktree"
      // means the same thing here and is more use than "the peer said 404".
      let message = text
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text
      } catch {
        /* not JSON; the body is the message */
      }
      throw new HttpError(response.status, message)
    }
    if (text === '') return undefined as T
    return scopeTree(this.key, JSON.parse(text) as T)
  }

  /** What a socket to this peer must carry; see gate.ts on the peer's side. */
  socketHeaders(): Record<string, string> {
    return this.token === undefined ? {} : { 'x-swb-token': this.token }
  }

  /**
   * Who the peer is, and whether we can talk to it at all.
   *
   * The version is compared on every read rather than only when a peer is
   * added, because the other machine is upgraded on its own schedule.
   */
  async identify(): Promise<PeerIdentity> {
    const identity = await this.request<PeerIdentity>('GET', '/api/server', undefined, 5_000)
    if (identity.protocolVersion !== PROTOCOL_VERSION) {
      throw new HttpError(
        502,
        `${this.baseUrl} speaks protocol ${identity.protocolVersion}, this one speaks ${PROTOCOL_VERSION}`,
      )
    }
    return identity
  }

  /**
   * The peer's whole world, with its `ui` dropped.
   *
   * The layout is the viewer's: `ui` is read and written only on the server
   * that served the page, so a peer's copy is not merged, not shown and not
   * written back. It is dropped here, at the boundary, rather than anywhere
   * that would have to remember to.
   */
  async snapshot(timeoutMs = 5_000): Promise<Omit<AppSnapshot, 'ui'>> {
    const snapshot = await this.request<AppSnapshot>('GET', '/api/snapshot', undefined, timeoutMs)
    return {
      projects: snapshot.projects,
      worktrees: snapshot.worktrees,
      sessions: snapshot.sessions,
      todos: snapshot.todos,
    }
  }
}
