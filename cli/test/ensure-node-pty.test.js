import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHelpersExecutable } from '../src/ensure-node-pty.js'

/**
 * node-pty 1.1.0 publishes `prebuilds/darwin-*\/spawn-helper` as mode 0644, and
 * on macOS every session is started through that file. Measured from the
 * registry tarball: `-rw-r--r-- package/prebuilds/darwin-arm64/spawn-helper`.
 * Left alone, a fresh Mac install loads node-pty and then fails every spawn
 * with `posix_spawnp failed.`
 */
describe('makeHelpersExecutable', () => {
  /** @type {string} */
  let pkg
  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), 'swb-pty-'))
  })
  afterEach(() => {
    rmSync(pkg, { recursive: true, force: true })
  })

  /** @param {string} rel @param {number} mode */
  const file = (rel, mode) => {
    const path = join(pkg, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'binary')
    chmodSync(path, mode)
    return path
  }

  it('sets the bit on the helper the package shipped without it', () => {
    const arm = file('prebuilds/darwin-arm64/spawn-helper', 0o644)
    const x64 = file('prebuilds/darwin-x64/spawn-helper', 0o644)
    expect(makeHelpersExecutable(pkg).sort()).toEqual([arm, x64].sort())
    expect(statSync(arm).mode & 0o777).toBe(0o755)
    expect(statSync(x64).mode & 0o777).toBe(0o755)
  })

  it('covers a helper compiled from source too', () => {
    const built = file('build/Release/spawn-helper', 0o644)
    expect(makeHelpersExecutable(pkg)).toEqual([built])
  })

  it('leaves an executable helper and every other file alone', () => {
    file('prebuilds/darwin-arm64/spawn-helper', 0o755)
    const node = file('prebuilds/darwin-arm64/pty.node', 0o644)
    expect(makeHelpersExecutable(pkg)).toEqual([])
    expect(statSync(node).mode & 0o777).toBe(0o644)
  })

  it('does nothing where there is nothing', () => {
    expect(makeHelpersExecutable(pkg)).toEqual([])
  })
})
