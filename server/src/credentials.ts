import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

/**
 * The password, and nothing else.
 *
 * Hand-rolled rather than pulled in, and the list of what that actually means is
 * short enough to justify it: one derivation, one comparison. `node:crypto` has
 * both, and the alternative is a dependency in a repository that has kept to a
 * handful.
 *
 * What is *not* hand-rolled is the hard part. `scrypt` is the key derivation
 * with node's own implementation; the comparison is `timingSafeEqual`. Nothing
 * here invents cryptography, it only arranges it.
 *
 * Most of this file is recovered from a previous attempt at a password on branch
 * `remote`, which was abandoned -- but not because of anything in here. Four of
 * the comments below record bugs that were found and fixed there, and rewriting
 * this from scratch would have thrown all four away.
 */

interface ScryptParams {
  N: number
  r: number
  p: number
  /**
   * Node refuses a derivation needing more than this, and its default is exactly
   * 32MB -- which `N=32768, r=8` needs to the byte, so parameters at that scale
   * throw `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` unless this is raised. Measured on
   * the previous attempt, which is how that bug was found.
   */
  maxmem: number
}

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptParams,
) => Promise<Buffer>

/**
 * Cost parameters, recorded in the stored string rather than assumed.
 *
 * A hash that does not say how it was made cannot be re-read after the numbers
 * change -- and they should change, upward, as machines get faster. Storing them
 * means an old hash still verifies while a new one is written stronger.
 *
 * N=2^16 measured 164ms and 64MB on the machine this was written for. The
 * deliberate choice not to go higher: scrypt's cost defends a *stolen* hash, and
 * the hash lives in a 0600 file on a machine where anything able to read it can
 * already read the tmux socket. What defends against online guessing is the
 * throttle, which bounds attempts to a fraction per second whatever this is set
 * to. 64MB per verification is also a smaller thing for a flood to demand.
 */
const SCRYPT_N = 65536
const SCRYPT_r = 8
const SCRYPT_p = 1
const KEY_BYTES = 32
const SALT_BYTES = 16

/**
 * Room to raise the costs later without this becoming the next bug.
 *
 * OpenSSL needs `128 * r * (N + p + 2)`, not the `128 * N * r` an earlier guard
 * used -- which passed `N=65536, r=8` and then threw, meaning raising `SCRYPT_N`
 * would have written hashes that could never verify.
 */
const MAXMEM = 192 * 1024 * 1024

/** What OpenSSL will actually want for these parameters, in bytes. */
const memoryFor = (N: number, r: number, p: number): number => 128 * r * (N + p + 2)

/**
 * These numbers must be *passed*, not merely recorded.
 *
 * They were written into the stored label and never handed to `scrypt`, which
 * silently used node's defaults -- half the intended work, while the file
 * claimed otherwise. Worse, the migration story the format exists for did not
 * work either: passing the labelled parameters threw at node's default `maxmem`,
 * so the first attempt to honour them would have failed outright. Both measured.
 */
const paramsFor = (N: number, r: number, p: number): ScryptParams => ({ N, r, p, maxmem: MAXMEM })

/** `scrypt$N$r$p$salt$key`, all base64url. Self-describing on purpose. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, KEY_BYTES, paramsFor(SCRYPT_N, SCRYPT_r, SCRYPT_p))
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

/**
 * Whether this password produces that hash.
 *
 * Returns false rather than throwing on a malformed stored value: a hash this
 * build cannot parse is one nobody can log in with, which is the safe reading.
 */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nText, rText, pText, saltText, keyText] = parts
  if (saltText === undefined || keyText === undefined) return false
  // Read back out of the stored string, which is the entire point of recording
  // them: a hash written with one set of costs has to keep verifying after the
  // constants above go up.
  const N = Number(nText)
  const r = Number(rText)
  const p = Number(pText)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (N <= 1 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return false
  // A stored value naming costs beyond our ceiling cannot be checked; refusing
  // is the safe reading, and it cannot happen to a hash this build wrote.
  if (memoryFor(N, r, p) > MAXMEM) return false
  try {
    const salt = Buffer.from(saltText, 'base64url')
    const expected = Buffer.from(keyText, 'base64url')
    if (salt.length === 0 || expected.length === 0) return false
    const actual = await scrypt(password, salt, expected.length, paramsFor(N, r, p))
    // Lengths must match before `timingSafeEqual`, which throws otherwise -- and
    // a length mismatch is already a definitive no.
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
export const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
