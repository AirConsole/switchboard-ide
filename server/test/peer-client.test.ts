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
   * A redirect is never followed. Measured before the fix: a 307 to another
   * origin sent it `x-swb-token` -- a link token that never expires -- and, at
   * link time, the login body with the password in it. `plainHttpAllowed`
   * judged only the address that was typed.
   */
  it('follows no redirect, so neither the token nor the password leaves', async () => {
    const seen: string[] = []
    const elsewhere = await serve((req, res) => {
      seen.push(`${req.method} ${req.url} token=${String(req.headers['x-swb-token'])}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"token":"x"}')
    })
    servers.push(elsewhere)
    const redirecting = await serve((req, res) => {
      res.writeHead(307, { location: `${urlOf(elsewhere)}${req.url ?? '/'}` })
      res.end()
    })
    servers.push(redirecting)
    const peer = new PeerClient(urlOf(redirecting), 'LINKTOKEN')
    await expect(peer.request('GET', '/api/snapshot')).rejects.toBeInstanceOf(PeerUnreachable)
    await expect(peer.login('hunter2')).rejects.toBeInstanceOf(PeerUnreachable)
    await expect(peer.streamRaw('/api/worktrees/w/raw', undefined)).rejects.toBeInstanceOf(
      PeerUnreachable,
    )
    expect(seen).toEqual([])
  })

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
   * `content-length` is absent on a chunked reply, so a cap that trusts it is
   * no cap at all -- and checking after `response.text()` checks something
   * already in memory. Measured against a peer streaming 1MiB chunks with no
   * length: resident memory went from 64MB to 3.25GB under a cap claiming
   * 32MB, on a path taken again on every snapshot.
   */
  it('stops reading a chunked reply that will not stop', async () => {
    const peer = await peerAt((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = 'x'.repeat(1024 * 1024)
      const pump = (): void => {
        if (res.writableEnded) return
        if (res.write(chunk)) setImmediate(pump)
        else res.once('drain', pump)
      }
      pump()
    })
    const before = process.memoryUsage().rss
    await expect(peer.request('GET', '/api/snapshot', undefined, 20_000)).rejects.toThrow(
      /too much/,
    )
    // Well under the 32MB cap's worth of slack, and nowhere near the gigabytes
    // an uncapped read reached.
    expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024)
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

  /*
   * The version numbers are true and useless on their own: nobody chose them,
   * and what the reader has to know is that a linked machine is a checkout
   * somebody must go and update. Reported from a real pair of machines, where
   * the message said only "speaks protocol 1, this one speaks 2".
   */
  it('says what to do about a skew, and on which machine', async () => {
    const behind = await peerAt((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-swb-protocol': String(PROTOCOL_VERSION - 1),
      })
      res.end('{"projects":[],"worktrees":[],"sessions":[],"todos":[]}')
    })
    // The whole sentence, because the wording is the point of this one.
    await expect(behind.request('GET', '/api/snapshot')).rejects.toThrow(
      new RegExp(
        `^http://[^ ]+ speaks protocol ${PROTOCOL_VERSION - 1}, this one speaks ` +
          `${PROTOCOL_VERSION}\\. Run pnpm pull in the Switchboard directory on that machine\\.$`,
      ),
    )

    /*
     * And the other way round, which is the case a fixed sentence would get
     * wrong: the peer is the *newer* one whenever you updated it first, and
     * sending the reader there to update it again wastes the trip.
     */
    const ahead = await peerAt((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-swb-protocol': String(PROTOCOL_VERSION + 1),
      })
      res.end('{"projects":[],"worktrees":[],"sessions":[],"todos":[]}')
    })
    await expect(ahead.request('GET', '/api/snapshot')).rejects.toThrow(
      /Run pnpm pull in the Switchboard directory here\./,
    )
  })

  /*
   * The page offers to do what the sentence says, so it needs the same
   * answer as data: which machine is behind, and the key to reach it by.
   */
  it('says which machine is behind in a form the page can act on', async () => {
    const at = (version: number) =>
      peerAt((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-swb-protocol': String(version) })
        res.end('{}')
      })
    const behind = await at(PROTOCOL_VERSION - 1)
    await expect(behind.request('GET', '/api/snapshot')).rejects.toMatchObject({
      code: 'protocol-mismatch',
      details: { outdated: 'there', host: behind.key },
    })
    const ahead = await at(PROTOCOL_VERSION + 1)
    await expect(ahead.request('GET', '/api/snapshot')).rejects.toMatchObject({
      details: { outdated: 'here' },
    })
  })

  /*
   * A machine out of step is the reason to ask it to update, so its reply to
   * that one request cannot be refused for being out of step -- the pull has
   * started over there, and reporting it as an error would say it had not.
   */
  it('asks an out-of-step machine to update without refusing its answer', async () => {
    const seen: string[] = []
    const peer = await peerAt((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      res.writeHead(202, {
        'content-type': 'application/json',
        'x-swb-protocol': String(PROTOCOL_VERSION - 1),
      })
      res.end('{"ok":true}')
    })
    await expect(peer.startUpdate()).resolves.toBeUndefined()
    expect(seen).toEqual(['POST /api/update'])
  })

  it('says to go there when that machine predates updating from here', async () => {
    const peer = await peerAt((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json', 'x-swb-protocol': '1' })
      res.end('{"error":"Route POST:/api/update not found"}')
    })
    await expect(peer.startUpdate()).rejects.toMatchObject({
      status: 409,
      code: 'peer-too-old',
      message: expect.stringMatching(/Run pnpm pull in the Switchboard directory on that machine\.$/),
    })
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
