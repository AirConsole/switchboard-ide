import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { Session } from '@switchboard/shared'

/*
 * `config` reads the environment at import time, so the allow-list has to be
 * decided before anything under src/ is loaded. See state.test.ts.
 */
process.env.SWB_PUBLIC_ORIGIN = 'https://ide.example:84'
const Fastify = (await import('fastify')).default
const fastifyWebsocket = (await import('@fastify/websocket')).default
const { registerWs } = await import('../src/routes/ws.js')

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
  await app.register(fastifyWebsocket)
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
const connect = (origin?: string): Promise<{ code: number; messages: string[] }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin })
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

  it('lets our own page in', async () => {
    const settled = connect('https://ide.example:84')
    setTimeout(() => fire(session), 20)
    const { code, messages } = await settled
    expect(code).toBe(1000)
    expect(messages.map((m) => JSON.parse(m).sessionId)).toContain('sess-secret')
  })

  /* curl, the health check, and a test: none of them is a browser. */
  it('lets a client that sends no origin in', async () => {
    const { code } = await connect()
    expect(code).toBe(1000)
  })
})
