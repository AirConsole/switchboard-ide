import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import type { AppSnapshot, Session } from '@switchboard/shared'
import { PROTOCOL_VERSION } from '@switchboard/shared'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-link-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { Workspace } = await import('../src/workspace.js')
const { plainHttpAllowed } = await import('../src/remote/peer.js')
const { HttpError } = await import('../src/http-error.js')
type SessionEngine = ConstructorParameters<typeof Workspace>[1]

const engine = { list: (): Session[] => [], killForProject: async () => {} } as unknown as SessionEngine

const PASSWORD = 'the peer password'
let validToken = 'l1.first'
let requests: string[] = []

/**
 * A peer that behaves like the real login: a password buys a token, and every
 * gated read wants that token back.
 */
const peer = Fastify()
peer.addHook('onRequest', async (request) => {
  requests.push(`${request.method} ${request.url}`)
})
peer.get('/api/health', async () => ({ ok: true }))
peer.post('/api/login', async (request, reply) => {
  const body = request.body as { password?: string; machine?: boolean }
  if (body.password !== PASSWORD) {
    return reply.status(401).send({ error: 'wrong password', code: 'bad-password' })
  }
  return { token: validToken }
})
const gated = (handler: () => unknown) => async (request: { headers: Record<string, unknown> }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
  request.headers['x-swb-token'] === validToken
    ? handler()
    : reply.status(401).send({ error: 'not allowed', code: 'auth-required' })
const snapshot: AppSnapshot = {
  projects: [{ id: 'p1', name: 'ide', host: { kind: 'local' }, root: '/srv/ide', worktreeRoot: '', addedAt: 1 }],
  worktrees: [{ id: 'w1', projectId: 'p1', name: 'main', branch: 'main', path: '/srv/ide', isMain: true }],
  sessions: [],
  todos: [],
  ui: {} as AppSnapshot['ui'],
} as unknown as AppSnapshot
peer.get('/api/server', gated(() => ({ name: 'peer', protocolVersion: PROTOCOL_VERSION, instanceId: 'peer-id' })) as never)
peer.get('/api/snapshot', gated(() => snapshot) as never)
await peer.listen({ host: '127.0.0.1', port: 0 })
const peerUrl = `http://127.0.0.1:${(peer.server.address() as AddressInfo).port}`

afterAll(async () => {
  await peer.close()
  await rm(stateDir, { recursive: true, force: true })
})

let store: InstanceType<typeof StateStore>
let workspace: InstanceType<typeof Workspace>

beforeEach(async () => {
  requests = []
  validToken = 'l1.first'
  await store?.flush()
  await rm(join(stateDir, 'state.json'), { force: true })
  store = new StateStore()
  await store.load()
  workspace = new Workspace(store, engine)
})

describe('linking a machine by its password', () => {
  it('keeps the link token and never the password', async () => {
    await workspace.addServer({ baseUrl: peerUrl, password: PASSWORD })
    expect(store.server(peerUrl)?.token).toBe('l1.first')
    await store.flush()
    const onDisk = await readFile(join(stateDir, 'state.json'), 'utf8')
    expect(onDisk).not.toContain(PASSWORD)
    // Health before the password: an address that is off is found out without
    // the password ever leaving this machine.
    expect(requests.indexOf('GET /api/health')).toBeLessThan(requests.indexOf('POST /api/login'))
  })

  /*
   * Not a 401: the page that asked is signed in *here*, and a 401 is how it
   * learns that it is not -- a wrong peer password would have signed the user
   * out of their own IDE.
   */
  it('says a wrong password plainly, and links nothing', async () => {
    const failed = await workspace.addServer({ baseUrl: peerUrl, password: 'nope' }).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(HttpError)
    expect((failed as InstanceType<typeof HttpError>).status).toBe(400)
    expect((failed as InstanceType<typeof HttpError>).code).toBe('bad-password')
    expect(store.server(peerUrl)).toBeUndefined()
  })

  /*
   * One password opens a whole machine, so a typo in the address is that
   * password sent wherever the typo points. Refused before anything is sent.
   */
  it('refuses to send a password over plain http to a public address', async () => {
    const failed = await workspace
      .addServer({ baseUrl: 'http://93.184.216.34:8084', password: PASSWORD })
      .catch((e: unknown) => e)
    expect((failed as InstanceType<typeof HttpError>).code).toBe('insecure-link')
  })

  /*
   * The machine changed its password. Its worktrees stay on screen from the last
   * good read -- losing them costs panels and open files permanently -- and the
   * picker learns it can be fixed by linking again.
   */
  it('keeps a refused machine on screen and says it needs linking again', async () => {
    await workspace.addServer({ baseUrl: peerUrl, password: PASSWORD })
    const before = await workspace.snapshot()
    expect(before.worktrees.some((w) => w.path === '/srv/ide')).toBe(true)
    expect(workspace.linkRefused(peerUrl)).toBe(false)

    validToken = 'l1.second' // the peer's password changed
    workspace.invalidate()
    const after = await workspace.snapshot()
    expect(after.worktrees.some((w) => w.path === '/srv/ide')).toBe(true)
    expect(workspace.linkRefused(peerUrl)).toBe(true)

    // And linking again, with the same form, restores it.
    await workspace.addServer({ baseUrl: peerUrl, password: PASSWORD })
    workspace.invalidate()
    await workspace.snapshot()
    expect(workspace.linkRefused(peerUrl)).toBe(false)
  })
})

describe('plainHttpAllowed', () => {
  const ok = (url: string): boolean => plainHttpAllowed(new URL(url))
  it('takes https anywhere and plain http only on a network you likely own', () => {
    expect(ok('https://ide.example.com')).toBe(true)
    for (const url of [
      'http://127.0.0.1:8084',
      'http://localhost:8084',
      'http://[::1]:8084',
      'http://10.1.2.3',
      'http://172.16.0.9',
      'http://192.168.1.20',
      'http://100.101.102.103',
      'http://169.254.1.1',
      'http://[fd12:3456::1]',
      'http://box',
      'http://box.local',
      'http://box.lan',
      'http://machine.tail1234.ts.net',
    ]) {
      expect(ok(url), url).toBe(true)
    }
    for (const url of [
      'http://93.184.216.34',
      'http://172.32.0.1',
      'http://100.128.0.1',
      'http://ide.example.com',
      'http://local.example.com',
      'http://[2001:db8::1]',
      'ftp://box.local',
    ]) {
      expect(ok(url), url).toBe(false)
    }
  })
})
