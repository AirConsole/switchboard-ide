import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../src/api.js'
import { terminalSocket } from '../src/socket.js'

interface Reachable {
  open(): Promise<void>
  reconnectTimer: number | null
}

const inner = terminalSocket as unknown as Reachable

const attempt = async (failure: unknown): Promise<{ signedOut: boolean; retrying: boolean }> => {
  vi.spyOn(api, 'wsTicket').mockRejectedValue(failure)
  let signedOut = false
  const off = terminalSocket.onUnauthorized(() => {
    signedOut = true
  })
  await inner.open()
  off()
  return { signedOut, retrying: inner.reconnectTimer !== null }
}

afterEach(() => {
  terminalSocket.disconnect()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/*
 * A restart is every deploy, and for those seconds the ticket request fails:
 * the proxy answers 502, or the fetch has nothing to reach. Every failure was
 * read as "signed out", so each restart put up the login screen while the
 * cookie was still valid, and the password had to be typed again for nothing.
 */
describe('a socket that cannot get a ticket', () => {
  it('keeps retrying while the server is away', async () => {
    vi.useFakeTimers()
    expect(await attempt(new ApiError('502 Bad Gateway', 502))).toEqual({ signedOut: false, retrying: true })
  })

  it('keeps retrying when the fetch itself fails', async () => {
    vi.useFakeTimers()
    expect(await attempt(new TypeError('Failed to fetch'))).toEqual({ signedOut: false, retrying: true })
  })

  it('shows the login only when the server says the session is gone', async () => {
    vi.useFakeTimers()
    expect(await attempt(new ApiError('not allowed', 401, 'auth-required'))).toEqual({
      signedOut: true,
      retrying: false,
    })
  })
})
