import { describe, expect, it } from 'vitest'
import { securityUpdate } from '../src/node-release.js'

/*
 * nodejs.org's own list, as it stood on 2026-11-18, cut to the lines that
 * matter: 24.14.0 was this machine's Node, five security releases behind, and
 * nothing said so.
 */
const RELEASES = [
  { version: 'v27.0.0-alpha.0.1.1', security: false },
  { version: 'v26.13.1', security: true },
  { version: 'v26.13.0', security: false },
  { version: 'v26.12.1', security: true },
  { version: 'v26.12.0', security: false },
  { version: 'v24.22.3', security: true },
  { version: 'v24.22.2', security: false },
  { version: 'v24.22.1', security: true },
  { version: 'v24.14.1', security: true },
  { version: 'v24.14.0', security: false },
  { version: 'v22.23.5', security: true },
  { version: 'v22.23.4', security: true },
  { version: 'v22.23.3', security: false },
]

describe('securityUpdate', () => {
  it('names the newest release of the running major when a security release is newer', () => {
    expect(securityUpdate(RELEASES, 'v24.14.0')).toBe('24.22.3')
    expect(securityUpdate(RELEASES, 'v22.22.1')).toBe('22.23.5')
    expect(securityUpdate(RELEASES, 'v26.12.0')).toBe('26.13.1')
  })

  it('says nothing to a machine on the newest, or behind only on releases without fixes', () => {
    expect(securityUpdate(RELEASES, 'v26.13.1')).toBeNull()
    // 26.13.0 is newer than 26.12.1 and carries no fix; 26.13.1 does.
    expect(securityUpdate(RELEASES.filter((r) => r.version !== 'v26.13.1'), 'v26.12.1')).toBeNull()
  })

  it('never sends a machine to another major, nor to a pre-release', () => {
    expect(securityUpdate(RELEASES, 'v24.22.3')).toBeNull()
    expect(securityUpdate([{ version: 'v27.0.0-alpha.1', security: true }], 'v26.13.1')).toBeNull()
  })

  it('says nothing about a version it cannot read', () => {
    expect(securityUpdate(RELEASES, 'v26.13.1-nightly')).toBeNull()
    expect(securityUpdate([], 'v24.14.0')).toBeNull()
  })
})
