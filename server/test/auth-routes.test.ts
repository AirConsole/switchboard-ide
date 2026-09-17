import { describe, expect, it } from 'vitest'

/* `config` reads the environment at import time. */
process.argv.push('--host', 'ide.example:84')
const { withPassword, PASSWORD } = await import('./helpers/password.js')
withPassword()
const Fastify = (await import('fastify')).default
const { registerAuth } = await import('../src/routes/auth.js')
const { resetSlots } = await import('../src/auth.js')

const app = async () => {
  const server = Fastify()
  registerAuth(server)
  await server.ready()
  return server
}

describe('logout', () => {
  /*
   * Found by an adversarial pass: from a page on another port, a no-cors POST
   * to `/api/logout` cleared the session, and a page left open could keep doing
   * it. `SameSite` governs sending a cookie, not storing one, so the
   * `Set-Cookie` that clears it is honoured whoever asked.
   */
  it('refuses another site, and another origin', async () => {
    const server = await app()
    const crossSite = await server.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:9999' },
    })
    expect(crossSite.statusCode).toBe(403)
    expect(crossSite.headers['set-cookie']).toBeUndefined()
    const foreign = await server.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { origin: 'https://evil.example' },
    })
    expect(foreign.statusCode).toBe(403)
    await server.close()
  })

  it('still signs out our own page', async () => {
    const server = await app()
    const res = await server.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { 'sec-fetch-site': 'same-origin', origin: 'https://ide.example:84', host: 'ide.example:84' },
    })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0')
    await server.close()
  })
})

describe('login', () => {
  it('hands a machine a link token and a browser a cookie', async () => {
    resetSlots()
    const server = await app()
    const machine = await server.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: PASSWORD, machine: true },
    })
    expect(machine.json().token).toMatch(/^l1\./)
    expect(machine.headers['set-cookie']).toBeUndefined()
    resetSlots()
    const browser = await server.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: PASSWORD },
      headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1:8084' },
    })
    expect(String(browser.headers['set-cookie'])).toContain('HttpOnly')
    expect(browser.json().token).toBeUndefined()
    await server.close()
  })
})
