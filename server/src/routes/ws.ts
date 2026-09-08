import type { FastifyInstance } from 'fastify'
// Imported for its declaration merging, which adds `websocket: true` to
// RouteShorthandOptions. Without this the route option does not typecheck.
import '@fastify/websocket'
import { WebSocket } from 'ws'
import type { ClientMsg, ServerMsg, Session } from '@ide-n-dream/shared'
import type { SessionEngine, Sink } from '../session/engine.js'

/**
 * One WebSocket carries every terminal in the app.
 *
 * Control messages are JSON; output is binary, tagged with a small integer
 * stream id (see the shared protocol). A single socket keeps ordering
 * predictable and avoids one connection per tile in the overview.
 */
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
): { broadcastInvalidate: () => void } => {
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
      attention: session.attention,
      lastOutputAt: session.lastOutputAt,
    })
  })

  app.get('/ws', { websocket: true }, (socket) => {
    const sink = new SocketSink(socket)
    sinks.add(sink)

    socket.on('message', (raw: Buffer | string) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg
      } catch {
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

  return { broadcastInvalidate: () => broadcast({ t: 'invalidate' }) }
}
