import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ServerMsg } from '@switchboard/shared'
import { Relay } from '../src/remote/relay.js'
import { PeerClient } from '../src/remote/peer.js'
import { hostKeyFor } from '../src/remote/scope.js'

/**
 * A stand-in peer's socket, over real ws.
 *
 * Real sockets rather than a mock, because what is under test is what survives
 * a connection going away -- which is the thing a mock would decide for us.
 */
class FakePeer {
  private wss: WebSocketServer | null = null
  readonly seen: Record<string, unknown>[] = []
  port = 0
  connections = 0

  async up(port = 0): Promise<void> {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port })
    this.wss.on('connection', (socket: WS) => {
      this.connections++
      socket.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        this.seen.push(msg)
        if (msg.t === 'attach') {
          const reply: ServerMsg = {
            t: 'attached',
            sessionId: msg.sessionId as string,
            streamId: 1,
            cols: 80,
            rows: 24,
            snapshot: '',
          }
          socket.send(JSON.stringify(reply))
        }
      })
    })
    await new Promise<void>((res) => this.wss?.on('listening', () => res()))
    this.port = (this.wss.address() as AddressInfo).port
  }

  async down(): Promise<void> {
    const wss = this.wss
    this.wss = null
    await new Promise<void>((res) => {
      if (!wss) return res()
      for (const client of wss.clients) client.terminate()
      wss.close(() => res())
    })
  }
}

const settle = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
const attaches = (peer: FakePeer): unknown[] => peer.seen.filter((m) => m.t === 'attach')

let peer: FakePeer
let relay: Relay
const sent: ServerMsg[] = []

const host = { sendJson: (m: ServerMsg) => sent.push(m), sendBinary: () => {}, onInvalidate: () => {} }

beforeEach(async () => {
  peer = new FakePeer()
  await peer.up()
  sent.length = 0
})

afterEach(async () => {
  relay?.dispose()
  await peer.down()
})

const clientFor = (token = 'tok'): PeerClient =>
  new PeerClient(`http://127.0.0.1:${peer.port}`, token)

describe('a browser’s links to other machines', () => {
  it('re-claims its attachments when a peer comes back', async () => {
    const client = clientFor()
    relay = new Relay(() => [client], host)
    await settle(150)
    relay.handle({ t: 'attach', sessionId: `${client.key}~s-1`, cols: 80, rows: 24, primary: true })
    await settle(100)
    expect(attaches(peer)).toHaveLength(1)

    /*
     * A peer restarting is the ordinary event -- it is a deploy -- and the
     * browser will not re-attach: it re-attaches in its own socket's `onopen`,
     * and its socket never closed. Without the re-claim the pane produced
     * nothing ever again, and typing was dropped in silence because the peer no
     * longer had an attachment to own input.
     */
    const port = peer.port
    await peer.down()
    peer.seen.length = 0
    await peer.up(port)
    await settle(1200)
    expect(attaches(peer)).toHaveLength(1)
    expect((attaches(peer)[0] as { sessionId: string }).sessionId).toBe('s-1')
  })

  it('does not re-claim a pane that was closed while the peer was away', async () => {
    const client = clientFor()
    relay = new Relay(() => [client], host)
    await settle(150)
    relay.handle({ t: 'attach', sessionId: `${client.key}~s-1`, cols: 80, rows: 24, primary: true })
    await settle(100)

    const port = peer.port
    await peer.down()
    // The window is closed while the machine is unreachable.
    relay.handle({ t: 'detach', sessionId: `${client.key}~s-1` })
    peer.seen.length = 0
    await peer.up(port)
    await settle(1200)
    // Re-claimed, it would be a primary attachment nobody is looking at, owning
    // that session's geometry for every other viewer.
    expect(attaches(peer)).toHaveLength(0)
  })

  /*
   * A disposed relay that still syncs re-opens every socket it just closed, and
   * nothing is left holding it to close them again: one self-reconnecting
   * socket per peer, per browser reload, for the life of the process.
   */
  it('opens nothing more once the browser is gone', async () => {
    relay = new Relay(() => [clientFor()], host)
    await settle(150)
    expect(peer.connections).toBe(1)

    relay.dispose()
    await settle(100)
    relay.sync()
    relay.sync()
    await settle(300)
    expect(peer.connections).toBe(1)
  })

  it('drops a machine that has been forgotten', async () => {
    let registered = [clientFor()]
    relay = new Relay(() => registered, host)
    await settle(150)
    expect(peer.connections).toBe(1)

    registered = []
    relay.sync()
    await settle(400)
    // Gone, and not reconnecting: it would still be using a credential the user
    // has just revoked.
    expect(peer.connections).toBe(1)
    relay.handle({ t: 'attach', sessionId: `${hostKeyFor(`http://127.0.0.1:${peer.port}`)}~s-1`, cols: 80, rows: 24, primary: true })
    await settle(200)
    expect(attaches(peer)).toHaveLength(0)
  })

  /*
   * The link captures its credential at construction and the key is a hash of
   * the base URL, so a rotated token left the socket retrying the old one
   * forever -- while REST, which builds a client per request, worked perfectly.
   */
  it('rebuilds a link when the credential changes', async () => {
    let registered = [clientFor('old')]
    relay = new Relay(() => registered, host)
    await settle(150)
    expect(peer.connections).toBe(1)

    registered = [clientFor('new')]
    relay.sync()
    await settle(300)
    expect(peer.connections).toBe(2)
  })
})
