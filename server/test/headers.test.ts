import { describe, expect, it } from 'vitest'

const Fastify = (await import('fastify')).default
const { registerSecurityHeaders } = await import('../src/headers.js')

const app = async () => {
  const server = Fastify()
  registerSecurityHeaders(server)
  server.get('/page', async () => 'page')
  // Stands in for `/api/worktrees/:id/raw`, which serves arbitrary file bytes
  // under a policy far stricter than the page's own.
  server.get('/raw', async (_request, reply) =>
    reply.header('content-security-policy', "default-src 'none'; sandbox").send('bytes'),
  )
  await server.ready()
  return server
}

describe('security headers', () => {
  it('forbids framing, because clickjacking an IDE that types into shells is real', async () => {
    const server = await app()
    const res = await server.inject({ url: '/page', headers: { host: 'ide.example:84' } })
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['content-security-policy']).toContain("script-src 'self'")
    await server.close()
  })

  /*
   * Widening that policy would let a served HTML file run script in our origin,
   * where it could fetch a socket ticket and type into an agent.
   */
  it('leaves a stricter policy a route set for itself alone', async () => {
    const server = await app()
    const res = await server.inject({ url: '/raw', headers: { host: 'ide.example:84' } })
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    await server.close()
  })

  it('names the socket host outright, since not every browser reads self as covering ws', async () => {
    const server = await app()
    const res = await server.inject({ url: '/page', headers: { host: 'ide.example:84' } })
    expect(res.headers['content-security-policy']).toContain('wss://ide.example:84')
    await server.close()
  })

  it('sends HSTS for a public name and never for loopback', async () => {
    const server = await app()
    const pub = await server.inject({ url: '/page', headers: { host: 'ide.example:84' } })
    expect(pub.headers['strict-transport-security']).toBe('max-age=31536000')
    for (const host of ['127.0.0.1:8084', 'localhost:8084', '[::1]:8084']) {
      const local = await server.inject({ url: '/page', headers: { host } })
      expect(local.headers['strict-transport-security'], host).toBeUndefined()
    }
    await server.close()
  })
})
