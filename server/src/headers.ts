import type { FastifyInstance } from 'fastify'
import { secureFor } from './auth.js'

/**
 * Headers that make the page harder to misuse once it is on the internet.
 *
 * None of these is authentication. They narrow what a *compromised* page, or a
 * page that frames ours, can do -- which matters more than it used to, because
 * the password is now the only thing in front of this server and anything that
 * runs script inside our origin can spend the session without ever reading it.
 */
const policy = (host: string | undefined): string => {
  // The socket is opened against the page's own host. `'self'` covers ws: and
  // wss: to the same host in current browsers, but not in every one still in
  // use, so the host is named outright.
  const sockets = host === undefined ? '' : ` ws://${host} wss://${host}`
  return [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror and React set style attributes and inject style elements.
    "style-src 'self' 'unsafe-inline'",
    // Icons and the Markdown preview use data: images; the files panel shows
    // a file through `/api/worktrees/:id/raw`, which is 'self'.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${sockets}`,
    // Nothing may frame this page. An IDE that types into shells is the one
    // page where clickjacking is not a theoretical concern.
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

export const registerSecurityHeaders = (app: FastifyInstance): void => {
  app.addHook('onSend', async (request, reply, payload) => {
    /*
     * A route that set its own policy keeps it. `/api/worktrees/:id/raw`
     * serves arbitrary file bytes with `default-src 'none'; sandbox`, which is
     * far stricter than this and must not be widened by it.
     */
    if (reply.getHeader('content-security-policy') === undefined) {
      void reply.header('content-security-policy', policy(request.headers.host))
    }
    void reply.header('x-frame-options', 'DENY')
    void reply.header('x-content-type-options', 'nosniff')
    void reply.header('referrer-policy', 'same-origin')
    /*
     * HSTS only for a name that is not loopback. Browsers ignore it over plain
     * HTTP anyway; this keeps it off local development entirely. It applies to
     * every port of the host, which is fine for a host whose every port is
     * served over TLS -- and without it, the first plaintext visit after a
     * hostile network is the one the password crosses in clear.
     */
    if (secureFor(request.headers.host)) {
      void reply.header('strict-transport-security', 'max-age=31536000')
    }
    return payload
  })
}
