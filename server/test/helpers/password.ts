import { randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A state directory with a known password in it.
 *
 * Must be called **before** `../src/config.js` is imported, like every other
 * environment-reading fixture here: `config` reads `SWB_STATE_DIR` once, at
 * import time, and `auth.ts` derives the password file from it.
 *
 * The cost parameters are deliberately the cheapest scrypt will take rather
 * than the ones the CLI writes: these tests verify the *gate*, and 164ms per
 * hash across a suite that logs in dozens of times is a minute of nothing. The
 * record is self-describing, so the server reads these out of the file exactly
 * as it would read the real ones.
 */
export const PASSWORD = 'correct horse battery staple'

/** Write a record into a directory that already exists. */
export const writePassword = (dir: string, password = PASSWORD): void => {
  const salt = randomBytes(16)
  const hash = scryptSync(password.normalize('NFC'), salt, 32, { N: 1024, r: 8, p: 1 })
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      version: 1,
      algorithm: 'scrypt',
      N: 1024,
      r: 8,
      p: 1,
      keylen: 32,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      generation: 1,
      updatedAt: Date.now(),
    }),
    { mode: 0o600 },
  )
}

export const withPassword = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'swb-gate-'))
  mkdirSync(dir, { recursive: true })
  writePassword(dir)
  process.env.SWB_STATE_DIR = dir
  return dir
}
