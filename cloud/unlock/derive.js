/**
 * The one place a password becomes the volume's key.
 *
 * Shared by `format.js` and `server.js` on purpose: a machine whose formatter
 * and whose unlocker derive keys differently is a machine nobody can open, and
 * the failure arrives days later at the worst moment.
 *
 * The parameters are `auth.ts`'s -- 64MB, one at a time -- and the salt is
 * *not* the login salt. Two keys from one password must not be derivable from
 * each other, and `auth.json` lives on the encrypted volume anyway, so the
 * salt used here has to be somewhere the locked machine can read: it is on the
 * boot disk, in the clear, which is what a salt is for.
 */
import { randomBytes, scrypt } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SALT_FILE = process.env.SWB_UNLOCK_SALT ?? '/etc/switchboard/unlock.json'

/** 64MB per hash, which is why only one runs at a time. */
const PARAMS = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 192 * 1024 * 1024 }

export const readSalt = () => {
  const { salt } = JSON.parse(readFileSync(SALT_FILE, 'utf8'))
  return Buffer.from(salt, 'base64')
}

export const writeSalt = () => {
  const salt = randomBytes(32)
  mkdirSync(dirname(SALT_FILE), { recursive: true })
  // 0600 even though a salt is not a secret: this file names the device too,
  // and an unreadable salt fails loudly where a readable one invites editing.
  writeFileSync(SALT_FILE, JSON.stringify({ salt: salt.toString('base64') }, null, 2), { mode: 0o600 })
  return salt
}

/**
 * The passphrase handed to cryptsetup: base64, no newline, because
 * `--key-file=-` reads to the first newline and a key cut short is a volume
 * that opens with fewer bits than anyone intended.
 */
/**
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
