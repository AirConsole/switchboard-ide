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

/**
 * Marks a read made *by* a gateway rather than by a browser.
 *
 * The peer answers such a read with its own world only, which is the whole of
 * what we keep from it -- and is what stops two instances pointed at each other
 * from recursing. See `Workspace.snapshot`.
 */
export const PEER_READ_HEADER = 'x-swb-peer-read'

/** Carries `PROTOCOL_VERSION` on every reply, so every read compares it. */
export const PROTOCOL_HEADER = 'x-swb-protocol'

/** Normalized so it can be hashed into an id and compared character by character. */
export const normalizeBaseUrl = (raw: string): string => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    // `new URL('box.local:8084')` throws, and the field's own placeholder
    // invites exactly that abbreviation. Its message is the one below.
    throw new HttpError(400, 'a server is http:// or https://')
  }
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

/**
 * A peer's whole reply, with a ceiling.
 *
 * Unbounded, a mistyped base URL pointing at some large-bodied endpoint -- or a
 * peer under memory pressure -- is buffered whole in this process, and the
 * parsed tree is then deep-copied again by `scopeTree`.
 */
const MAX_REPLY_BYTES = 32 * 1024 * 1024

const readCapped = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_REPLY_BYTES) {
    await discard(response)
    throw new HttpError(502, 'that server sent too much')
  }
  /*
   * Counted as it arrives, not after.
   *
   * `response.text()` with a check afterwards is not a cap -- the whole body is
   * already in memory by the time it runs, and `content-length` is absent
   * entirely on a chunked reply. Measured against a peer streaming 1MiB chunks
   * with no length: the abort fired at five seconds, by which time resident
   * memory had gone from 64MB to **3.25GB**, under a cap that claims 32MB.
   * That needs no hostile peer -- a mistyped address pointing at some
   * large-bodied endpoint is read again on every snapshot.
   */
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let text = ''
  let seen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen += value.byteLength
    if (seen > MAX_REPLY_BYTES) {
      await reader.cancel()
      throw new HttpError(502, 'that server sent too much')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Let go of a reply we are not going to read.
 *
 * Throwing with the body unread leaves undici holding the connection until a
 * finalizer runs. Measured on a version-skewed peer, which is exactly when this
 * path is taken and taken repeatedly: 800 reads left 169 server-side
 * connections and 255 open handles, against 2 and 4 when the versions matched.
 */
const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    /* already gone; nothing to release */
  }
}

/**
 * The peer's error, kept whole -- message, `code` **and** `details`.
 *
 * It is this program, so its errors mean here what they mean there, and the
 * client acts on the code rather than the text: `path-missing` and
 * `not-a-repo` are what turn a failed open into the offer to create it, and
 * `stale-file` carries the `rev` that is the only way to resolve a save an
 * agent got to first. Dropping them left both recoveries unreachable on a
 * remote machine, which is the case the feature exists for.
 *
 * `details` is spread at the top level by the error handler, so what is left
 * after `error` and `code` is precisely what was put there.
 */
const peerError = (status: number, text: string): HttpError => {
  let message = text
  let code: string | undefined
  let details: Record<string, unknown> | undefined
  try {
    const { error, code: peerCode, ...rest } = JSON.parse(text) as Record<string, unknown>
    if (typeof error === 'string') message = error
    if (typeof peerCode === 'string') code = peerCode
    if (Object.keys(rest).length > 0) details = rest
  } catch {
    /* not JSON; the body is the message */
  }
  return new HttpError(status, message, code, details)
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
    /*
     * The timer covers the **body**, not just the headers.
     *
     * `finally` on the fetch alone clears it the instant the response head
     * arrives, and `response.text()` is then unbounded -- so a peer that sends
     * a status line and stops holds this open for as long as the OS allows.
     * Measured against a stand-in peer that writes half a body and stalls: an
     * abort set for one second was still hanging after eight. That blocks
     * `remoteSlices`' `Promise.all`, so `GET /api/snapshot` never returns and
     * the whole row never paints -- local worktrees included -- and the "a
     * machine that is off keeps its tab" fallback is never even reached,
     * because nothing ever throws.
     */
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.token === undefined ? {} : { 'x-swb-token': this.token }),
          [PEER_READ_HEADER]: '1',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(unscopeTree(body)) }),
      })
      await this.checkProtocol(response)
      const text = await readCapped(response)
      if (!response.ok) throw peerError(response.status, text)
      if (text === '') return undefined as T
      return scopeTree(this.key, JSON.parse(text) as T)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new PeerUnreachable(this.baseUrl, err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The peer's protocol version, checked on **every** reply.
   *
   * Not only when a machine is added: the other machine is upgraded on its own
   * schedule, and the failure this prevents is silent -- a field one side
   * stopped sending reads as `undefined` on the other, and a worktree simply
   * looks wrong rather than broken. Carried in a header so it costs no extra
   * request; measured before this, a peer bumped to 99 mid-session went on
   * merging as if nothing had happened.
   */
  private async checkProtocol(response: Response): Promise<void> {
    const said = response.headers.get(PROTOCOL_HEADER)
    if (said === null || Number(said) === PROTOCOL_VERSION) return
    // Released before we throw, or the connection is held until a finalizer
    // runs -- and this is the path a peer mid-upgrade takes on every read.
    await discard(response)
    throw new HttpError(
      502,
      `${this.baseUrl} speaks protocol ${said}, this one speaks ${PROTOCOL_VERSION}`,
      'protocol-mismatch',
    )
  }

  /**
   * Whether two clients would authenticate identically.
   *
   * Compared here rather than by exposing the token, so nothing outside this
   * class has to hold one to ask.
   */
  sameCredential(other: PeerClient): boolean {
    return this.baseUrl === other.baseUrl && this.token === other.token
  }

  /** What a socket to this peer must carry; see gate.ts on the peer's side. */
  socketHeaders(): Record<string, string> {
    return this.token === undefined ? {} : { 'x-swb-token': this.token }
  }

  /**
   * Who the peer is, and whether we can talk to it at all.
   *
   * The version is checked by `checkProtocol` on this reply like any other; the
   * body is read for the name, and for a peer old enough to send no header.
   */
  async identify(): Promise<PeerIdentity> {
    const identity = await this.request<PeerIdentity>('GET', '/api/server', undefined, 5_000)
    if (identity.protocolVersion !== PROTOCOL_VERSION) {
      throw new HttpError(
        502,
        `${this.baseUrl} speaks protocol ${identity.protocolVersion}, this one speaks ${PROTOCOL_VERSION}`,
        'protocol-mismatch',
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
