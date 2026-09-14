import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PROTOCOL_VERSION } from '@switchboard/shared'
import { PeerClient, PeerUnreachable } from '../src/remote/peer.js'
import { HttpError } from '../src/http-error.js'

/** A raw server, so the response can be left deliberately half-written. */
const serve = (handler: Parameters<typeof createServer>[1]): Promise<Server> =>
  new Promise((res) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => res(server))
  })

const urlOf = (server: Server): string =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const servers: Server[] = []
afterAll(() => {
  for (const server of servers) server.close()
})

const peerAt = async (handler: Parameters<typeof createServer>[1]): Promise<PeerClient> => {
  const server = await serve(handler)
  servers.push(server)
  return new PeerClient(urlOf(server), undefined)
}

describe('talking to a peer', () => {
  /*
   * The timeout has to cover the body, not just the headers.
   *
   * `finally` on the fetch alone clears the abort the instant the response head
   * arrives, and the body read is then unbounded -- so a peer that sends a
   * status line and stops holds this open for as long as the OS allows.
   * Measured before the fix: an abort set for one second was still hanging
   * after eight. That blocks the snapshot's `Promise.all`, so the whole row
   * never paints, local worktrees included, and the "a machine that is off
   * keeps its tab" fallback is never reached because nothing ever throws.
   */
  it('gives up on a peer that sends headers and then stalls', async () => {
    const peer = await peerAt((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
      res.write('{"projects":[')
      // and never finishes
    })
    const started = Date.now()
    await expect(peer.request('GET', '/api/snapshot', undefined, 400)).rejects.toBeInstanceOf(
      PeerUnreachable,
    )
    expect(Date.now() - started).toBeLessThan(3000)
  })

  /*
   * Compared on every reply, not only when the machine was added: the other
   * side is upgraded on its own schedule, and a skew is otherwise silent --
   * a field one side stopped sending reads as `undefined` on the other.
   */
  it('refuses a peer that has been upgraded past us', async () => {
    const peer = await peerAt((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-swb-protocol': String(PROTOCOL_VERSION + 98),
      })
      res.end('{"projects":[],"worktrees":[],"sessions":[],"todos":[]}')
    })
    await expect(peer.request('GET', '/api/snapshot')).rejects.toThrow(/speaks protocol/)
  })

  it('accepts a peer speaking our own version', async () => {
    const peer = await peerAt((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-swb-protocol': String(PROTOCOL_VERSION),
      })
      res.end('{"ok":true}')
    })
    await expect(peer.request('GET', '/api/health')).resolves.toEqual({ ok: true })
  })

  /* The client acts on the code, not the message. See `peerError`. */
  it('keeps a peer’s code and details', async () => {
    const peer = await peerAt((_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end('{"error":"changed under you","code":"stale-file","rev":"42"}')
    })
    const err = await peer.request('PUT', '/api/x', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ status: 409, code: 'stale-file', details: { rev: '42' } })
  })
})
