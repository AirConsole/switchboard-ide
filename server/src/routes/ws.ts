import type { FastifyInstance } from 'fastify'
// Imported for its declaration merging, which adds `websocket: true` to
// RouteShorthandOptions. Without this the route option does not typecheck.
import '@fastify/websocket'
import { WebSocket } from 'ws'
import type { ClientMsg, ServerMsg, Session } from '@switchboard/shared'
import type { SessionEngine, Sink } from '../session/engine.js'

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

export const registerWs = (
  app: FastifyInstance,
  engine: SessionEngine,
): { broadcastInvalidate: () => void; clientCount: () => number } => {
  const sinks = new Set<SocketSink>()

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

  app.get('/ws', { websocket: true }, (socket) => {
    const sink = new SocketSink(socket)
    sinks.add(sink)

    socket.on('message', (raw: Buffer | string) => {
      const msg = parseClientMsg(raw.toString())
      if (msg === null) {
        sink.sendJson({ t: 'error', message: 'malformed message' })
        return
      }
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
      sinks.delete(sink)
    })
  })

  return {
    broadcastInvalidate: () => broadcast({ t: 'invalidate' }),
    /** So work nobody would see -- polling git, say -- can simply not happen. */
    clientCount: () => sinks.size,
  }
}
