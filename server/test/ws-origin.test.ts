import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { Session } from '@switchboard/shared'

/*
 * `config` reads its flags at import time, so the allow-list has to be decided
 * before anything under src/ is loaded -- the same reason state.test.ts sets
 * its environment there. A bare name, which is what a deployment passes, and
 * which the server expands to both schemes.
 */
process.argv.push('--host', 'ide.example:84')
const { withPassword } = await import('./helpers/password.js')
withPassword()
const Fastify = (await import('fastify')).default
const fastifyWebsocket = (await import('@fastify/websocket')).default
const { registerWs, wsPluginOptions } = await import('../src/routes/ws.js')
const { newTicket } = await import('../src/auth.js')

type Engine = Parameters<typeof registerWs>[1]

/** Only what the route touches; nothing here spawns a pty or a tmux server. */
const fakeEngine = (): { engine: Engine; fire: (session: Session) => void } => {
  const listeners: ((session: Session) => void)[] = []
  const engine = {
    onSessionChange: (fn: (session: Session) => void) => listeners.push(fn),
    attach: async () => {},
    input: () => {},
    resize: () => {},
    focus: () => {},
    detach: () => {},
    detachAll: () => {},
  } as unknown as Engine
  return { engine, fire: (session) => listeners.forEach((fn) => fn(session)) }
}

const session = { id: 'sess-secret', liveness: 'live', attention: 'idle', lastOutputAt: 0 } as Session

const app = Fastify()
const { engine, fire } = fakeEngine()
let clients: () => number
let url: string

beforeAll(async () => {
  // The same options the server uses, not a hand-copied subset: the
  // subprotocol echo is what carries the ticket.
  await app.register(fastifyWebsocket, wsPluginOptions)
  // No peers registered: the relay has nothing to link to, which is exactly
  // the shape of every instance that is not a gateway.
  const workspace = { peers: () => [] } as unknown as Parameters<typeof registerWs>[2]
  clients = registerWs(app, engine, workspace).clientCount
  await app.listen({ host: '127.0.0.1', port: 0 })
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`
})

afterAll(async () => {
  await app.close()
})

/** Resolves with everything that happened, once the socket settles either way. */
const connect = (
  origin?: string,
  ticket?: string,
): Promise<{ code: number; messages: string[] }> =>
  new Promise((resolve, reject) => {
    const opts = origin === undefined ? {} : { origin }
    // The ticket rides the subprotocol, which is the only thing a browser can
    // put on an upgrade -- it cannot set a header.
    const ws = ticket === undefined ? new WebSocket(url, opts) : new WebSocket(url, [ticket], opts)
    const messages: string[] = []
    ws.on('message', (data: Buffer) => messages.push(data.toString()))
    // Given a moment on purpose: the claim is not just "it closed" but "it was
    // never sent anything", and a frame racing the close would be the bug.
    ws.on('open', () => setTimeout(() => ws.close(1000), 60))
    ws.on('close', (code: number) => resolve({ code, messages }))
    ws.on('error', reject)
  })

describe('/ws origin', () => {
  /*
   * A WebSocket is exempt from CORS, so before this check any page the user
   * visited could open one, read a session id off the state broadcast every
   * client gets, and type a prompt and a Return into a running Claude.
   *
   * Measured on master: the socket opened, `clientCount()` went to 1, and a
   * `session-state` frame carrying `sess-secret` arrived unasked.
   */
  it('refuses a page from an origin that is not ours, and tells it nothing', async () => {
    const settled = connect('https://evil.example')
    // Fired while the refused client is connecting, which is when the real
    // attack would collect its id: the broadcast is unsolicited.
    setTimeout(() => fire(session), 20)
    const { code, messages } = await settled
    expect(code).toBe(1008)
    expect(messages).toEqual([])
    // The stronger claim, and the one the fix actually makes: it never joined
    // the set that gets broadcast to, so there was no frame to lose a race with.
    expect(clients()).toBe(0)
  })

  /*
   * Our own page gets in with a **ticket**, not with an origin and not with a
   * cookie. Cookies ignore the port, so a page on a sibling port of this
   * hostname is same-site and the browser hands it ours -- and a socket is
   * exempt from CORS, so nothing else stands there. The previous attempt at a
   * password here died of exactly that: `attach`, `focus`, `input`, and a shell
   * command ran as the user from a page they had merely visited.
   */
  it('lets our own page in when it brings a ticket', async () => {
    const settled = connect('https://ide.example:84', newTicket())
    setTimeout(() => fire(session), 20)
    const { code, messages } = await settled
    expect(code).toBe(1000)
    expect(messages.map((m) => JSON.parse(m).sessionId)).toContain('sess-secret')
  })

  it('refuses our own origin with no ticket, and tells it nothing', async () => {
    const settled = connect('https://ide.example:84')
    setTimeout(() => fire(session), 20)
    const { code, messages } = await settled
    expect(code).toBe(1008)
    expect(messages).toEqual([])
    expect(clients()).toBe(0)
  })

  /*
   * The two refusals say different things, and `swb` relies on the difference
   * to check `--host` without a session: a ticket that was never issued is
   * "not signed in" from a page we serve and "origin not allowed" from one we
   * do not. Before this, the probe could not tell a right name from a wrong one
   * once sockets needed a ticket, and reported the first deploy behind the
   * password as misconfigured.
   */
  it('tells a page we serve from one we do not, even with a bogus ticket', async () => {
    expect((await connect('https://ide.example:84', 'never-issued')).code).toBe(4401)
    expect((await connect('https://evil.example', 'never-issued')).code).toBe(1008)
    // A real ticket from a foreign origin is still refused as a foreign origin.
    expect((await connect('https://evil.example', newTicket())).code).toBe(1008)
  })

  /* One use. A replayed ticket is a ticket somebody else may be holding. */
  it('spends a ticket exactly once', async () => {
    const ticket = newTicket()
    expect((await connect('https://ide.example:84', ticket)).code).toBe(1000)
    expect((await connect('https://ide.example:84', ticket)).code).toBe(4401)
  })

  /*
   * A bare `--host` means both schemes, because which one the browser sends
   * depends on how the proxy terminates -- and the person passing the flag
   * should not have to know. Getting it wrong costs a page that loads over a
   * row that never paints, which is a bad thing to learn from the browser.
   */
  it('accepts either scheme for a name given without one', async () => {
    for (const origin of ['https://ide.example:84', 'http://ide.example:84']) {
      const { code } = await connect(origin, newTicket())
      expect([origin, code]).toEqual([origin, 1000])
    }
  })

  /*
   * A client with no origin used to be waved through as "not a browser, so it
   * must be local". There is a credential now, so it is simply refused -- and
   * `1008` rather than `4401`, because nothing here claimed to be signed in.
   */
  it('refuses a client that sends no origin and no ticket', async () => {
    const { code } = await connect()
    expect(code).toBe(1008)
  })
})
