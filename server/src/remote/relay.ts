import { WebSocket } from 'ws'
import {
  FRAME_OUTPUT,
  OUTPUT_HEADER_BYTES,
  type AttachMsg,
  type ClientMsg,
  type ServerMsg,
} from '@switchboard/shared'
import type { PeerClient } from './peer.js'
import { scopeId, unscopeId } from './scope.js'

/**
 * One browser's socket, extended to the machines its windows live on.
 *
 * There is **one upstream socket per browser socket per peer**, and that choice
 * does most of the work here:
 *
 * - The peer sees one client per browser, so its own `sizeOwner` / `inputOwner`
 *   arbitration governs two viewers of a remote terminal exactly as it governs
 *   two viewers of a local one. Nothing about multiple viewers is reimplemented
 *   at this layer, which is the part that would be subtly wrong.
 * - It keeps the peer's `clientCount() > 0`, so the peer's own git poll runs and
 *   its `invalidate` broadcasts arrive. The gateway is pushed to, not polling.
 *
 * What the relay itself does is small, because the protocol is: five message
 * kinds each way, each carrying exactly one `sessionId`, and a binary frame
 * whose only id is a `uint32` in a five-byte header. Terminal bytes are
 * forwarded without being parsed or copied.
 */

/** Ours to hand out, so a peer's numbering cannot collide with the engine's. */
const GATEWAY_STREAM_BASE = 0x40000000

export interface RelayHost {
  /** Where a frame for the browser goes. */
  sendJson(msg: ServerMsg): void
  sendBinary(data: Uint8Array): void
  /** Something on the peer changed that invalidates the merged snapshot. */
  onInvalidate(): void
}

class PeerLink {
  private socket: WebSocket | null = null
  /**
   * What this browser is attached to on this peer, by the peer's own id.
   *
   * Held rather than merely forwarded, because **a peer restarting is the
   * normal event** -- a deploy -- and the browser will not re-attach for us: it
   * re-attaches in its own socket's `onopen`, and its socket never closed. So
   * without this, one blip left every remote pane dead for the life of the
   * page: no output, and typing silently dropped because the peer no longer had
   * an attachment to own input. Re-sent on every reconnect.
   */
  private readonly attached = new Map<string, AttachMsg>()
  /** The peer's stream numbers, mapped to the ones this browser was given. */
  private readonly streams = new Map<number, number>()
  private closed = false
  private backoffMs = 500

  constructor(
    private readonly peer: PeerClient,
    private readonly host: RelayHost,
    private readonly nextStreamId: () => number,
  ) {
    this.open()
  }

  private open(): void {
    if (this.closed) return
    const url = `${this.peer.baseUrl.replace(/^http/, 'ws')}/ws`
    // A peer is authorized by the token, never by an Origin: this is not a
    // browser and must not pretend to be one.
    const socket = new WebSocket(url, { headers: this.peer.socketHeaders() })
    this.socket = socket

    socket.on('open', () => {
      this.backoffMs = 500
      // Everything this browser still has open, claimed again. The peer forgot
      // it when the connection went; the browser does not know it went.
      for (const attach of this.attached.values()) this.write(attach)
      // Whatever happened while we were away is not in any snapshot we hold.
      this.host.onInvalidate()
    })

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.forwardOutput(data)
        return
      }
      this.forwardControl(data.toString())
    })

    socket.on('error', () => {
      /* `close` follows, and reconnecting is decided there. */
    })

    socket.on('close', () => {
      this.socket = null
      // The peer will number its streams from scratch; ours stay as they are,
      // and the map is rebuilt by the `attached` frames the re-attach brings.
      this.streams.clear()
      if (this.closed) return
      // A peer can be off for a week; there is no point hammering it. Capped
      // well above the local reconnect, which is only ever a deploy.
      setTimeout(() => this.open(), this.backoffMs).unref()
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    })
  }

  /**
   * A binary frame, renumbered in place.
   *
   * Only the four bytes of the header are touched: the pty bytes behind them
   * are forwarded exactly as they arrived, never parsed and never copied. An
   * unknown stream is dropped rather than guessed -- it is output for an
   * attachment this browser has already detached from.
   */
  private forwardOutput(frame: Buffer): void {
    if (frame.length < OUTPUT_HEADER_BYTES || frame[0] !== FRAME_OUTPUT) return
    const theirs = frame.readUInt32LE(1)
    const ours = this.streams.get(theirs)
    if (ours === undefined) return
    frame.writeUInt32LE(ours, 1)
    this.host.sendBinary(frame)
  }

  private forwardControl(raw: string): void {
    let msg: ServerMsg
    try {
      msg = JSON.parse(raw) as ServerMsg
    } catch {
      return
    }
    if (msg.t === 'invalidate') {
      // Not passed through: the browser's snapshot is the merge of every
      // machine, so it re-reads ours, which re-reads the peer's.
      this.host.onInvalidate()
      return
    }
    if (msg.t === 'attached') {
      const ours = this.nextStreamId()
      this.streams.set(msg.streamId, ours)
      this.host.sendJson({
        ...msg,
        streamId: ours,
        sessionId: scopeId(this.peer.key, msg.sessionId),
      })
      return
    }
    /*
     * A peer broadcasts the state of every session it is running, including
     * ones belonging to projects nobody here opened. Only what this browser is
     * actually attached to is passed on: the rest is another machine's business
     * and the browser discards it anyway, so forwarding it was noise that grew
     * with the peer's session count. Everything a worktree's tile needs for a
     * session it is *not* attached to arrives in the snapshot.
     */
    if (msg.t === 'session-state' && !this.attached.has(msg.sessionId)) return
    this.host.sendJson({
      ...msg,
      ...(msg.sessionId === undefined
        ? {}
        : { sessionId: scopeId(this.peer.key, msg.sessionId) }),
    } as ServerMsg)
  }

  private write(msg: ClientMsg): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(msg))
  }

  send(msg: ClientMsg): void {
    const scoped = unscopeId(msg.sessionId)
    const forwarded = { ...msg, sessionId: scoped?.id ?? msg.sessionId }
    // Recorded before it is sent, so a peer that is down still gets it on the
    // next connect -- and, just as importantly, a detach *removes* it, so a
    // pane closed while the peer was away cannot be re-claimed when it returns.
    // A stale primary attachment would go on owning that session's geometry.
    if (forwarded.t === 'attach') this.attached.set(forwarded.sessionId, forwarded)
    else if (forwarded.t === 'detach') this.attached.delete(forwarded.sessionId)
    else if (forwarded.t === 'resize') {
      const open = this.attached.get(forwarded.sessionId)
      // So a reconnect re-attaches at the size the pane is now, not the size it
      // was when it first mounted.
      if (open) this.attached.set(forwarded.sessionId, { ...open, cols: forwarded.cols, rows: forwarded.rows })
    }
    this.write(forwarded)
  }

  dispose(): void {
    this.closed = true
    this.attached.clear()
    this.socket?.close()
    this.socket = null
  }
}

/**
 * The relay for one browser socket.
 *
 * Links are opened when a browser connects rather than when it first attaches,
 * because the top bar needs every machine's attention state before anything is
 * attached to at all.
 */
export class Relay {
  private readonly links = new Map<string, PeerLink>()
  private peers: PeerClient[] = []
  private nextStream = GATEWAY_STREAM_BASE

  constructor(
    private readonly readPeers: () => PeerClient[],
    private readonly host: RelayHost,
  ) {
    this.sync()
  }

  /**
   * Bring the links level with the machines that are registered now.
   *
   * Called when anything invalidates the snapshot, which is when a machine is
   * added or forgotten. Both directions matter: a machine added mid-session had
   * no link until something was attached to it, so nothing it did -- a worktree
   * going dirty, an agent blocking on you -- reached the row until a reload;
   * and a machine that was forgotten kept its socket for the life of the tab,
   * still authenticating with a credential the user had just revoked.
   *
   * It also caches the peer list, which `handle` used to rebuild -- a
   * `PeerClient` and a sha1 per registered machine -- on every keystroke.
   */
  sync(): void {
    this.peers = this.readPeers()
    const live = new Set(this.peers.map((peer) => peer.key))
    for (const [key, link] of this.links) {
      if (live.has(key)) continue
      link.dispose()
      this.links.delete(key)
    }
    for (const peer of this.peers) this.link(peer)
  }

  private link(peer: PeerClient): PeerLink {
    const existing = this.links.get(peer.key)
    if (existing) return existing
    const link = new PeerLink(peer, this.host, () => ++this.nextStream)
    this.links.set(peer.key, link)
    return link
  }

  /** True when the frame was for a peer and has been dealt with. */
  handle(msg: ClientMsg): boolean {
    const scoped = unscopeId(msg.sessionId)
    if (scoped === null) return false
    const link = this.links.get(scoped.host)
    // Claimed either way: a frame naming a machine we do not have is not one
    // the local engine can answer, and handing it over would only produce "no
    // such session" about an id that was never its.
    if (link !== undefined) link.send(msg)
    return true
  }

  dispose(): void {
    for (const link of this.links.values()) link.dispose()
    this.links.clear()
  }
}
