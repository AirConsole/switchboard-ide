/**
 * Setting the password, from a terminal and nowhere else.
 *
 * **Never from a web page.** An unauthenticated setup page on a public URL is a
 * race anyone on the internet can win, and there is no honest way to scope it:
 * a reverse proxy connects from loopback, so "only from this machine" is
 * satisfied by everything the proxy forwards. Two of the sixteen holes found in
 * the previous attempt at this were exactly that -- any website could claim an
 * unclaimed instance and choose its password, and two concurrent claims both
 * won. A CLI has no such surface.
 *
 * The server never writes this file and the CLI never reads a session from it,
 * so there is exactly one writer and no locking to get wrong.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ReadStream } from 'node:tty'
import { stateDir } from './instance.js'

/** Must match what `server/src/auth.ts` verifies with. Recorded in the file too. */
const N = 65536
const R = 8
const P = 1
const KEYLEN = 32
const MAXMEM = 192 * 1024 * 1024

/**
 * Twelve, and not negotiable with a flag.
 *
 * The rate limiter bounds online guessing to a few thousand a day, which is a
 * decade against a four-word passphrase and about four months against eight
 * human-chosen characters. Four months is inside the life of this deployment,
 * and this password is the whole boundary in front of a program that runs
 * shells. It is the one number the server cannot enforce, because the server
 * only ever sees a hash.
 */
export const MIN_LENGTH = 12

/** Counted in characters, not bytes or UTF-16 units, the way a person counts. */
export const tooShort = (/** @type {string} */ text) => Array.from(text).length < MIN_LENGTH

const SHORT =
  `at least ${MIN_LENGTH} characters -- this is the whole boundary in front of a program that runs shells, and there is no second factor.\n` +
  '  three or four unrelated words beats eight complicated characters.'

/** @param {string} dir */
export const passwordFileFor = (dir) => join(dir, 'auth.json')

/**
 * Named rather than written as literals, because a raw control character in
 * source is invisible in an editor, survives a careless copy-paste as nothing
 * at all, and made this very file fail a tool's control-character guard.
 */
const CTRL_C = '\u0003'
const DELETE = '\u007f'
const BACKSPACE = '\u0008'

/**
 * @typedef {{ text: string, done: boolean, cancelled: boolean }} KeyState
 */

/**
 * One keypress at a time, as a pure reducer -- the only part of a terminal
 * prompt that can be tested.
 *
 * @param {KeyState} state
 * @param {string} chunk decoded text, never raw bytes; see the caller
 * @returns {KeyState}
 */
export const feedKey = (state, chunk) => {
  let { text } = state
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') return { text, done: true, cancelled: false }
    if (ch === CTRL_C) return { text: '', done: true, cancelled: true }
    if (ch === DELETE || ch === BACKSPACE) {
      /*
       * Pop a *character*, not a byte. A pasted `u` with an umlaut is two bytes
       * in UTF-8, and popping one leaves an invalid sequence -- so the hash is
       * taken over bytes the user did not type, and they are locked out of a
       * password they entered correctly. `Array.from` splits on code points.
       */
      text = Array.from(text).slice(0, -1).join('')
      continue
    }
    // Printable only: an arrow key must not become part of the password.
    if (ch >= ' ') text += ch
  }
  return { text, done: false, cancelled: false }
}

/**
 * Read a secret with the echo off.
 *
 * `/dev/tty` rather than stdin, because this may be reached through a pipe --
 * the same reason `install.sh` opens it. The prompt goes to the tty too, so
 * `pnpm password | tee` does not capture it.
 *
 * @param {string} prompt
 * @returns {Promise<string | null>} null when cancelled
 */
export const askSecret = (prompt) =>
  new Promise((resolve, reject) => {
    /** @type {number} */
    let fd
    try {
      fd = process.stdin.isTTY ? 0 : openSync('/dev/tty', 'r+')
    } catch {
      reject(new Error('no terminal'))
      return
    }
    const out = fd === 0 ? 1 : fd
    const input = new ReadStream(fd)
    const decoder = new StringDecoder('utf8')
    /** @type {KeyState} */
    let state = { text: '', done: false, cancelled: false }
    // Restored on *every* exit path, including a throw and a signal. Leaving
    // somebody's terminal with echo off is how a tool stops being trusted.
    const restore = () => {
      try {
        input.setRawMode(false)
      } catch {
        // already closed
      }
      input.removeAllListeners('data')
      /*
       * Destroyed, not paused. A paused tty stream still holds its handle, and
       * that handle alone keeps the event loop alive -- so the password was
       * written and the command then sat there forever, which reads exactly
       * like a hang in the middle of setting it. Measured through a
       * pseudo-terminal: the record was on disk, and the process was still
       * running four seconds later.
       *
       * Destroying the stream closes the libuv handle; node never closes the
       * underlying stdio descriptors, so a second prompt can open fd 0 again.
       */
      input.destroy()
      if (fd !== 0) closeSync(fd)
      process.off('exit', restore)
    }
    process.on('exit', restore)
    try {
      input.setRawMode(true)
    } catch {
      restore()
      reject(new Error('no terminal'))
      return
    }
    writeSync(out, prompt)
    input.on('data', (buf) => {
      state = feedKey(state, decoder.write(Buffer.from(buf)))
      if (!state.done) return
      writeSync(out, '\n')
      restore()
      resolve(state.cancelled ? null : state.text)
    })
  })

/**
 * @param {string} password
 * @param {number} generation
 * @returns {string} the record, as JSON text
 */
export const recordFor = (password, generation = 1) => {
  const salt = randomBytes(16)
  const hash = scryptSync(password.normalize('NFC'), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  })
  const record = {
    version: 1,
    algorithm: 'scrypt',
    N,
    r: R,
    p: P,
    keylen: KEYLEN,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    generation,
    updatedAt: Date.now(),
  }
  return `${JSON.stringify(record, null, 2)}\n`
}

/** @param {string} dir @param {string} text */
const writeRecord = (dir, text) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = passwordFileFor(dir)
  /*
   * Temp file then rename, with the mode on the temp file rather than applied
   * after: `writeFileSync`'s mode only applies when it creates the file, so
   * there must be no instant at which this exists under the default umask. The
   * pid is in the name for the same reason it is in `state.ts`.
   */
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}

/**
 * Whether a secret can actually be prompted for.
 *
 * Openability, not existence: `/dev/tty` is present in plenty of places it
 * cannot be opened -- CI, a git hook, a container -- and testing for the file
 * sends those down the interactive path to fail with a raw errno. `install.sh`
 * learned the same thing and tests it the same way.
 */
export const usableTerminal = () => {
  if (process.stdin.isTTY === true) return true
  try {
    closeSync(openSync('/dev/tty', 'r+'))
    return true
  } catch {
    return false
  }
}

/** @param {string} dir @returns {any} */
export const readRecord = (dir) => {
  try {
    return JSON.parse(readFileSync(passwordFileFor(dir), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Does this password match the stored record?
 * @param {string} dir @param {string} password
 */
export const matches = (dir, password) => {
  const rec = readRecord(dir)
  if (rec === null) return false
  try {
    const salt = Buffer.from(rec.salt, 'base64')
    const want = Buffer.from(rec.hash, 'base64')
    const got = scryptSync(password.normalize('NFC'), salt, want.length, {
      N: rec.N,
      r: rec.r,
      p: rec.p,
      maxmem: MAXMEM,
    })
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`swb password: ${message}`)
  process.exit(1)
}

/**
 * @param {{reset?: boolean, stdin?: boolean, status?: boolean, revokeSessions?: boolean}} opts
 */
export const password = async (opts = {}) => {
  const dir = stateDir()
  const existing = readRecord(dir)

  if (opts.status) {
    if (existing === null) {
      console.log('no password set -- run `pnpm password`')
      console.log(`  it would live in ${passwordFileFor(dir)}`)
      return
    }
    console.log(`password set ${new Date(existing.updatedAt).toISOString().slice(0, 10)}`)
    console.log(`  file        ${passwordFileFor(dir)}`)
    console.log(`  generation  ${existing.generation}`)
    return
  }

  if (opts.revokeSessions) {
    if (existing === null) fail('no password is set, so there are no sessions to revoke')
    const bumped = { ...existing, generation: existing.generation + 1, updatedAt: Date.now() }
    writeRecord(dir, `${JSON.stringify(bumped, null, 2)}\n`)
    console.log('every session is signed out. The password itself is unchanged.')
    return
  }

  const { volumeState, rekey } = await import('./luks.js')
  const volume = existing === null ? 'none' : volumeState()
  const encrypted = volume === 'encrypted'

  /** @type {string} */
  let next
  /** The current password, kept only where the volume has to be re-keyed. */
  let current = null
  if (opts.stdin) {
    // `--stdin` implies a reset: scripting a change *is* a reset, and asking
    // for two lines on stdin is a shape people get wrong silently.
    next = readFileSync(0, 'utf8').replace(/\r?\n$/, '')
  } else {
    if (!usableTerminal()) {
      console.error('swb password: there is no terminal to type into.')
      console.error("  pipe it instead:  printf '%s' \"$PASSWORD\" | pnpm password --stdin")
      console.error('  nothing was changed.')
      process.exit(1)
    }
    if (existing !== null && opts.reset !== true) {
      const old = await askSecret('Current password: ')
      if (old === null) fail('cancelled; nothing was changed')
      current = old
      if (!matches(dir, old)) {
        /*
         * Asked for, and the reason is specific to this program rather than
         * generic hygiene: it runs semi-autonomous agents as you, in
         * repositories you did not write. A prompt-injected agent that could
         * run `pnpm password <something>` would otherwise own this machine
         * silently and permanently. It cannot read the old password out of a
         * scrypt hash, so requiring it turns an invisible takeover into a
         * lockout noticed the same day. `--reset` is the named way past it.
         */
        fail('that is not the current password (use --reset if you have lost it)')
      }
    }
    /*
     * The length is checked before "Again", not after. Checking after meant
     * typing a password twice to learn it was never acceptable -- and when
     * changing one, rerunning also meant typing the current password again. A
     * short one is refused where it is typed and asked for once more.
     */
    let first = await askSecret('New password: ')
    for (let tries = 1; first !== null && tooShort(first) && tries < 3; tries++) {
      console.error(SHORT)
      first = await askSecret('New password: ')
    }
    if (first === null) fail('cancelled; nothing was changed')
    if (tooShort(first)) fail(SHORT)
    const again = await askSecret('Again: ')
    if (again === null) fail('cancelled; nothing was changed')
    if (first !== again) fail('those did not match; nothing was changed')
    next = first
  }

  // Still here for `--stdin`, which never passes through the prompt above.
  if (tooShort(next)) fail(SHORT)

  /*
   * On a cloud machine this password is also the key to /home, and a key slot
   * can only be replaced by something that already opens the volume. So the
   * two routes that skip the current password -- `--reset` and `--stdin` --
   * are refused here rather than quietly leaving a machine that logs in and
   * cannot open its own disk. The recovery passphrase is the way back in.
   */
  if (volume === 'unknown') {
    fail(
      'this machine has a data volume and there is no way to tell whether it is encrypted\n' +
        '  with this password, because cryptsetup cannot be run. Changing the password now\n' +
        '  could leave a machine that logs in and cannot open its own disk. Run it with sudo.',
    )
  }

  if (encrypted) {
    if (current === null) {
      fail(
        'this machine\'s disk is encrypted with the current password, so changing it needs\n' +
          '  the current one. Run `pnpm password` without --reset or --stdin. If it is lost,\n' +
          '  unlock with the recovery passphrase and start a machine from a snapshot.',
      )
    }
    try {
      await rekey(current, next)
    } catch (err) {
      fail(
        `the disk's key could not be changed, so the password was not changed either:\n  ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  // The generation carries over: changing the password already invalidates
  // every token, because the signing key is derived from the hash.
  writeRecord(dir, recordFor(next, existing === null ? 1 : existing.generation))
  console.log('password set.')
  console.log('')
  if (encrypted) console.log('  the disk it opens has been re-keyed to match')
  console.log('  every browser session is signed out, everywhere')
  console.log('  any linked machine must be linked again with the new password')
  console.log(`  ${passwordFileFor(dir)}   0600`)
}
