/**
 * The one place a password becomes the volume's key.
 *
 * Shared by `format.js`, `server.js` and `swb password` on purpose: a machine
 * whose formatter and whose unlocker derive keys differently is a machine
 * nobody can open, and the failure arrives days later at the worst moment.
 *
 * The parameters are `auth.ts`'s -- 64MB, one at a time.
 *
 * **The salt is the volume's own LUKS UUID, and nothing is stored on the boot
 * disk.** That is not a shortcut, it is the fix for a real bug: the salt used
 * to live in /etc, which `provision.sh recreate` throws away with the rest of
 * the boot disk, so a rebuilt machine could never open the disk it was
 * rebuilt around. A UUID is 128 random bits, per volume, generated when the
 * volume is made -- which is what a salt has to be -- and it travels with the
 * thing it belongs to. It is public, as salts may be; it makes one password's
 * key specific to one volume, and that is all it is for.
 */
import { execFileSync } from 'node:child_process'
import { scrypt } from 'node:crypto'

/** 64MB per hash, which is why only one runs at a time. */
const PARAMS = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 192 * 1024 * 1024 }

/**
 * @param {string} device
 * @returns {Buffer} the salt for this volume: its LUKS UUID
 */
export const volumeSalt = (device) =>
  Buffer.from(execFileSync('cryptsetup', ['luksUUID', device], { encoding: 'utf8' }).trim(), 'utf8')

/** @param {string} device */
export const isLuks = (device) => {
  try {
    execFileSync('cryptsetup', ['isLuks', device], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The passphrase handed to cryptsetup: base64, no newline, because
 * `--key-file=-` reads to the first newline and a key cut short is a volume
 * that opens with fewer bits than anyone intended.
 *
 * @param {string} password
 * @param {Buffer} salt
 * @returns {Promise<string>}
 */
export const deriveKey = (password, salt) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, PARAMS.keylen, PARAMS, (err, key) =>
      err ? reject(err) : resolve(key.toString('base64')),
    )
  })
