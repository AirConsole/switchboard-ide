import type { FastifyInstance, FastifyRequest } from 'fastify'
// Imported for its declaration merging, which adds `websocket: true` to
// RouteShorthandOptions. Without this the route option does not typecheck.
import '@fastify/websocket'
import { WebSocket } from 'ws'
import type { ClientMsg, ServerMsg, Session } from '@switchboard/shared'
import type { SessionEngine, Sink } from '../session/engine.js'
import { config } from '../config.js'
import { spendTicket } from '../auth.js'
import { allowSocket, cookieSession } from '../gate.js'
import { RELAY_HEADER } from '../remote/peer.js'
import { Relay } from '../remote/relay.js'
import type { Workspace } from '../workspace.js'

/**
 * One WebSocket carries every terminal in the app.
 *
 * Control messages are JSON; output is binary, tagged with a small integer
 * stream id (see the shared protocol). A single socket keeps ordering
 * predictable and avoids one connection per tile in the overview.
 */
/**
 * A frame, or null.
 *
 * The shape is checked rather than asserted with `as`. Nothing here is
 * defensive programming for its own sake: `JSON.parse` was guarded and the cast
 * was not, so a frame of the literal `null` reached `msg.t` and threw inside
 * ws's receive loop, which has no try/catch of its own -- and with no
 * `uncaughtException` handler that took the whole server down. Measured:
 * `ws.send('null')` and the next health check got nothing at all. `{"t":"input",
 * "data":123}` reached `data.replace`, and a resize with `cols:"x"` reached
 * `pty.resize(NaN)`, since the guard there is `cols < 2` and NaN fails every
 * comparison.
 *
 * Deliberately hand-written rather than zod: this is the one hot path in the
 * process -- every keystroke of every terminal comes through it -- and these
 * are five flat shapes.
 */
const parseClientMsg = (raw: string): ClientMsg | null => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const msg = value as Record<string, unknown>
  const id = (): boolean => typeof msg.sessionId === 'string' && msg.sessionId !== ''
  const size = (): boolean =>
    typeof msg.cols === 'number' &&
    Number.isFinite(msg.cols) &&
    typeof msg.rows === 'number' &&
    Number.isFinite(msg.rows)
  switch (msg.t) {
    case 'attach':
      return id() && size() && typeof msg.primary === 'boolean' ? (msg as unknown as ClientMsg) : null
    case 'input':
      return id() && typeof msg.data === 'string' ? (msg as unknown as ClientMsg) : null
    case 'resize':
      return id() && size() ? (msg as unknown as ClientMsg) : null
    case 'detach':
    case 'focus':
      return id() ? (msg as unknown as ClientMsg) : null
    default:
      return null
  }
}

class SocketSink implements Sink {
  constructor(private readonly socket: WebSocket) {}

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN
  }

  sendBinary(data: Uint8Array): void {
    if (this.open) this.socket.send(data, { binary: true })
  }

  sendJson(msg: ServerMsg): void {
    if (this.open) this.socket.send(JSON.stringify(msg))
  }
}


/**
 * Whether a client may open the socket.
 *
 * A missing `Origin` is not a browser -- curl, a test, a health check and any
 * server-to-server client send none -- and those are gated the way every `/api`
 * route is, by the bind address and whatever sits in front. This check exists
 * for the one thing `/api` gets for free and a socket does not: a browser will
 * open a WebSocket to any origin, no preflight, no CORS, no questions asked.
 *
 * So the rule is only about pages: if a browser named an origin, it has to be
 * one of ours. See `publicOrigins` in config.ts for why it is a list and not a
 * comparison against `Host`.
 */
/**
 * How `@fastify/websocket` must be registered for this route to work.
 *
 * Exported so `index.ts` and the tests cannot drift: the subprotocol echo is
 * what carries the socket ticket, and an app that registers the plugin without
 * it gets a handshake the browser refuses -- silently, as a socket that never
 * opens. This codebase has already paid for a test hand-copying a server rule
 * and diverging from it; there is one copy of this one.
 */
export const wsPluginOptions = {
  options: {
    // Terminal output frames are small; the default 100MB limit is pointless
    // here, and a lower cap bounds the damage from a malformed frame.
    maxPayload: 8 * 1024 * 1024,
    /*
     * Echo back whatever subprotocol the client offered.
     *
     * A browser refuses the connection unless the server names one of the
     * protocols it asked for -- and that list is the browser's only way to put
     * a credential on an upgrade, since it cannot set a header. So this is what
     * carries the single-use ticket. It is deliberately not validated here: the
     * route below spends it, because a handshake hook has nowhere to report a
     * verdict to. `false` would refuse the upgrade outright and take the
     * gateway's no-subprotocol connection down with it.
     */
    handleProtocols: (protocols: Set<string>): string | false => {
      const [first] = protocols
      return first ?? false
    },
  },
}

export const registerWs = (
  app: FastifyInstance,
  engine: SessionEngine,
  workspace: Workspace,
): { broadcastInvalidate: () => void; clientCount: () => number } => {
  const sinks = new Set<SocketSink>()
  /** Each browser's links to the other machines, so they can be kept level. */
  const relays = new Set<Relay>()

  const broadcast = (msg: ServerMsg): void => {
    for (const sink of sinks) sink.sendJson(msg)
  }

  // Session liveness and attention changes are pushed, not polled by the client.
  engine.onSessionChange((session: Session) => {
    broadcast({
      t: 'session-state',
      sessionId: session.id,
      liveness: session.liveness,
      exitStatus: session.exitStatus ?? null,
      attention: session.attention,
      lastOutputAt: session.lastOutputAt,
      ...(session.command === undefined ? {} : { command: session.command }),
    })
  })

  app.get('/ws', { websocket: true }, (socket, request) => {
    /*
     * Two ways in, and a browser has only the second.
     *
     * A gateway presents its token. A browser presents a **single-use ticket**
     * in the WebSocket subprotocol -- not the session cookie, and that is the
     * whole design. Cookies are scoped by host and ignore the port, so a page
     * on a sibling port of this hostname is same-site and the browser attaches
     * our cookie to a socket that page opens; a WebSocket is exempt from CORS,
     * so nothing else stands in the way. Measured end to end on the previous
     * attempt at a password here: from a page the user merely visited, `attach`,
     * `focus` and `input` were accepted and a shell command ran as them.
     *
     * A ticket is obtained over `/api`, where the origin *is* checked, so the
     * hostile page cannot get one -- and what the browser does with the cookie
     * on its socket stops mattering.
     */
    const offered = request.headers['sec-websocket-protocol']
    const ticket = typeof offered === 'string' ? offered.split(',')[0]?.trim() : undefined
    const byToken = allowSocket(request)
    /*
     * The origin is checked here too, even though a ticket is already proof.
     *
     * Not redundant so much as cheap: a hostile page cannot obtain a ticket at
     * all -- `/api/ws-ticket` is behind the gate's own origin rule -- so this
     * layer should never be the one that fires. It exists because the previous
     * attempt at a password here died of a *single* check being load-bearing
     * and turning out not to hold, and because a browser cannot lie about
     * `Origin` on an upgrade. A gateway sends none and takes the branch above.
     */
    const origin = request.headers.origin
    const originOk = origin === undefined || config.publicOrigins.has(origin)
    const byTicket = !byToken && originOk && spendTicket(ticket)

    // Refused *before* the sink joins `sinks`: every session's liveness and
    // attention is broadcast to everything in that set, session ids included,
    // and a refused client must not be handed one on its way out.
    if (!byToken && !byTicket) {
      /*
       * Logged, and at warn, because the other thing that reaches here is our
       * own page behind a proxy whose origin nobody configured -- and that
       * failure is otherwise invisible: the page loads, every REST call works,
       * and only the row never paints. Naming what was refused turns "the IDE
       * is broken" into one grep and one env var.
       */
      app.log.warn(
        {
          origin: request.headers.origin ?? null,
          host: request.headers.host ?? null,
          ip: request.ip,
          allowed: [...config.publicOrigins],
        },
        'refused a socket -- was --host passed, and is this machine meant to reach it?',
      )
      /*
       * 4401 when a browser asked and had no usable ticket, 1008 otherwise.
       * The distinction is the difference between two failures that were
       * indistinguishable before: a signed-out tab, which should stop retrying
       * and show a login, and a misconfigured `--host`, which should keep
       * retrying because the row will paint as soon as somebody fixes it.
       * Keyed on a code rather than a reason string, which is brittle.
       */
      if (ticket !== undefined) socket.close(4401, 'not signed in')
      // 1008 is "policy violation", said out loud rather than dropped silently.
      else socket.close(1008, 'origin not allowed')
      return
    }

    const sink = new SocketSink(socket)
    sinks.add(sink)

    /*
     * The credential is checked once, at the upgrade, and the socket then lives
     * for days -- so without this, `pnpm password` would revoke every cookie
     * and an intruder's already-open terminal would keep typing into a live
     * agent forever. `attach` plus `input` is command execution; a revocation
     * that does not reach open sockets is the appearance of one rather than the
     * thing. Re-judged against the *current* signing key, so a password change
     * closes them within the minute.
     */
    const recheck = setInterval(() => {
      const still = byToken ? allowSocket(request) : cookieSession(request) !== null
      if (!still) socket.close(4401, 'not signed in')
    }, 60_000)
    recheck.unref()
    socket.on('close', () => clearInterval(recheck))

    /*
     * This browser's own links to the other machines its windows live on.
     *
     * Per socket rather than per process, so a peer sees one client per browser
     * and its own size and input arbitration decides between two viewers of a
     * remote terminal -- the same rule, in the same place, as for a local one.
     */
    /*
     * A gateway's relay socket gets no relay of its own.
     *
     * Without this, two machines linked to each other melt down: A's relay
     * opens a socket to B, B accepts it as an ordinary client and gives it a
     * relay, which opens a socket back to A, which does the same. Measured at
     * **~55 new sockets per second in each direction**, and self-sustaining --
     * killing the only browser did not stop it, because by then the sockets
     * were each other's clients. Both machines run out of file descriptors and
     * stay there. Linking a machine to *itself* is the same mechanism in one
     * process: 1,447 sockets in five seconds.
     *
     * This is the `/ws` half of what `x-swb-peer-read` does for the snapshot:
     * a read made *by* a gateway is answered with this machine's own world and
     * nothing further. The relay says so in a header, because the token cannot:
     * an instance that is nobody's peer has no token to check, so asking "did
     * this socket present one" answered no for every socket and gave a relay to
     * the very thing that must not have one.
     */
    const relay = request.headers[RELAY_HEADER] !== undefined
      ? null
      : new Relay(() => workspace.peers(), {
          sendJson: (msg) => sink.sendJson(msg),
          sendBinary: (data) => sink.sendBinary(data),
          onInvalidate: () => sink.sendJson({ t: 'invalidate' }),
          knowsSession: (id) => workspace.knowsSession(id),
        })
    if (relay) relays.add(relay)

    socket.on('message', (raw: Buffer | string) => {
      const msg = parseClientMsg(raw.toString())
      if (msg === null) {
        sink.sendJson({ t: 'error', message: 'malformed message' })
        return
      }
      // A frame naming another machine never reaches the local engine, which
      // would answer "no such session" about an id that was never its.
      if (relay?.handle(msg) === true) return
      switch (msg.t) {
        case 'attach':
          void engine.attach(sink, msg.sessionId, msg.cols, msg.rows, msg.primary)
          break
        case 'input':
          engine.input(sink, msg.sessionId, msg.data)
          break
        case 'resize':
          engine.resize(sink, msg.sessionId, msg.cols, msg.rows)
          break
        case 'focus':
          engine.focus(sink, msg.sessionId)
          break
        case 'detach':
          engine.detach(sink, msg.sessionId)
          break
        default:
          sink.sendJson({ t: 'error', message: 'unknown message type' })
      }
    })

    socket.on('close', () => {
      // Detach from every session, or the engine would keep sending output to a
      // dead socket and hold its mirror subscriptions forever.
      engine.detachAll(sink)
      if (relay) {
        relay.dispose()
        // Out of the set as well as disposed. Left in it, the next invalidate
        // -- which is constant -- called `sync()` on a dead relay, and `sync()`
        // cheerfully opened fresh sockets to every peer that nothing would ever
        // close. One per reload, per peer, for the life of the process.
        relays.delete(relay)
      }
      sinks.delete(sink)
    })
  })

  return {
    broadcastInvalidate: () => {
      // Registering or forgetting a machine is one of the things that
      // invalidates the snapshot, so this is also where every browser's links
      // are brought level with the registry -- opening one for a machine just
      // added, closing one for a machine just forgotten.
      for (const relay of relays) relay.sync()
      broadcast({ t: 'invalidate' })
    },
    /** So work nobody would see -- polling git, say -- can simply not happen. */
    clientCount: () => sinks.size,
  }
}
