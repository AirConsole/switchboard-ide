import type { FastifyInstance, FastifyRequest } from 'fastify'
// Imported for its declaration merging, which adds `websocket: true` to
// RouteShorthandOptions. Without this the route option does not typecheck.
import '@fastify/websocket'
import { WebSocket } from 'ws'
import type { ClientMsg, ServerMsg, Session } from '@switchboard/shared'
import type { SessionEngine, Sink } from '../session/engine.js'
import { config } from '../config.js'
import { allowSocket, hasPeerToken } from '../gate.js'
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
    // Refused *before* the sink joins `sinks`: every session's liveness and
    // attention is broadcast to everything in that set, session ids included,
    // and a refused client must not be handed one on its way out.
    if (!allowSocket(request)) {
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
      // 1008 is "policy violation", said out loud rather than dropped silently.
      socket.close(1008, 'origin not allowed')
      return
    }

    const sink = new SocketSink(socket)
    sinks.add(sink)

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
     * nothing further. A peer is recognised the same way it is anywhere else,
     * by the token -- and it has no use for a relay, because it is the thing
     * being relayed to.
     */
    const relay = hasPeerToken(request)
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
