import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  claimSlot,
  clearedCookies,
  cookieFor,
  hasPassword,
  mintSession,
  newTicket,
  verifyPassword,
} from '../auth.js'
import { config } from '../config.js'
import { cookieSession, isOwnPage } from '../gate.js'

const loginBody = z.object({
  password: z.string().min(1, 'a password'),
  /** A linked machine asks for the token in the body instead of a cookie. */
  machine: z.boolean().optional(),
})

const sleepUntil = async (at: number): Promise<void> => {
  const wait = at - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

/**
 * Obtaining a credential, and giving it back.
 *
 * These three are the only `/api` routes reachable without one, so each carries
 * its own rule rather than leaning on the gate.
 */
export const registerAuth = (app: FastifyInstance): void => {
  /**
   * The one public oracle in the server, which is why it is the most carefully
   * written route in it.
   *
   * The reply is held until the slot the throttle hands out, rather than the
   * work being delayed before it starts: the response then lands at a time
   * fixed when the request *arrived*, which also hides the few milliseconds a
   * successful login spends minting. Nothing below branches on whether the
   * password was right before that wait is over.
   */
  app.post('/api/login', { bodyLimit: 4096 }, async (request, reply) => {
    /*
     * A smaller origin rule than the gate's, because this route cannot require
     * a session. `curl` and a linked machine send no Fetch Metadata at all and
     * must still be able to log in; what has to be refused is a *browser* on
     * somebody else's page, which reports `cross-site`.
     */
    const site = request.headers['sec-fetch-site']
    if (site !== undefined && !isOwnPage(request)) {
      return reply.status(403).send({ error: 'not allowed', code: 'bad-origin' })
    }
    const origin = request.headers.origin
    if (origin !== undefined && !config.publicOrigins.has(origin)) {
      return reply.status(403).send({ error: 'not allowed', code: 'bad-origin' })
    }

    if (!hasPassword()) {
      return reply
        .status(503)
        .send({ error: 'no password is set on this server', code: 'password-not-set' })
    }

    // Claimed before the body is even looked at, so a malformed one costs a
    // slot too -- otherwise the cheapest way to probe is to send garbage.
    const slot = claimSlot()
    if (slot === null) {
      return reply
        .status(429)
        .header('retry-after', '20')
        .send({ error: 'too many attempts', code: 'too-many-attempts' })
    }

    const parsed = loginBody.safeParse(request.body)
    if (!parsed.success) {
      await sleepUntil(slot)
      return reply.status(400).send({ error: 'a password', code: 'bad-request' })
    }

    const verdict = await verifyPassword(parsed.data.password)
    await sleepUntil(slot)

    if (verdict === 'busy') {
      return reply
        .status(429)
        .header('retry-after', '5')
        .send({ error: 'too many attempts', code: 'too-many-attempts' })
    }
    if (verdict === 'no') {
      // The only record that anyone has been trying. There is no other audit
      // trail in this system, and without it a successful intrusion is silent.
      request.log.warn(
        { host: request.headers.host, agent: request.headers['user-agent'] },
        'login refused',
      )
      return reply.status(401).send({ error: 'wrong password', code: 'bad-password' })
    }

    const token = mintSession()
    if (token === null) {
      return reply.status(503).send({ error: 'no password is set', code: 'password-not-set' })
    }
    request.log.info(
      { host: request.headers.host, agent: request.headers['user-agent'] },
      'login accepted',
    )
    if (parsed.data.machine === true) {
      // No cookie: a linked machine is not a browser and has no jar to put one
      // in. It presents this in `x-swb-token` from here on.
      return reply.send({ token })
    }
    return reply.header('set-cookie', cookieFor(request.headers.host, token)).send({ ok: true })
  })

  /**
   * Clearing the cookie, and nothing more.
   *
   * Say plainly what this is not: the token stays valid until it expires. A copy
   * already taken is unaffected. Real revocation is `pnpm password` or
   * `pnpm password --revoke-sessions`, both of which change the signing key.
   */
  app.post('/api/logout', async (request, reply) =>
    reply.header('set-cookie', clearedCookies(request.headers.host)).send({ ok: true }),
  )

  /**
   * A single-use ticket for one socket upgrade.
   *
   * Behind the gate, so a caller must already hold a session *and* satisfy the
   * origin rule -- which is exactly what a hostile same-site page cannot do,
   * and why the socket takes a ticket rather than the cookie. See `newTicket`.
   */
  app.post('/api/ws-ticket', async (request, reply) => {
    if (cookieSession(request) === null) {
      return reply.status(401).send({ error: 'not allowed', code: 'auth-required' })
    }
    return reply.send({ ticket: newTicket() })
  })
}
