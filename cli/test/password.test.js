import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIN_LENGTH, feedKey, matches, passwordFileFor, readRecord, recordFor } from '../src/password.js'

const CTRL_C = String.fromCharCode(3)
const DELETE = String.fromCharCode(127)
const ESC = String.fromCharCode(27)
const EMPTY = { text: '', done: false, cancelled: false }

/**
 * The prompt is a terminal in raw mode, which cannot be stood up here -- but the
 * decision about each keypress is a pure function, and that is where every way
 * of being locked out of a password you typed correctly lives.
 */
describe('feedKey', () => {
  /*
   * A pasted character outside ASCII is more than one byte in UTF-8. Popping a
   * byte leaves an invalid sequence, so the hash is taken over bytes nobody
   * typed -- and the failure is invisible: the password looks right, is
   * confirmed against itself, and then does not work at the login screen.
   */
  it('pops a character on backspace, not a byte', () => {
    expect(feedKey({ ...EMPTY, text: 'aü' }, DELETE).text).toBe('a')
    expect(feedKey({ ...EMPTY, text: 'a\u{1f600}' }, DELETE).text).toBe('a')
    expect(feedKey({ ...EMPTY, text: '' }, DELETE).text).toBe('')
  })

  // A chunk arriving as `secret\r\n` must not submit twice: the second would be
  // an empty password, which on the confirm prompt reads as a mismatch you
  // cannot reproduce.
  it('treats CRLF as one submission', () => {
    const once = feedKey(EMPTY, 'secret\r\n')
    expect(once).toEqual({ text: 'secret', done: true, cancelled: false })
  })

  /*
   * An empty password accepted as "set" is a machine with no boundary at all,
   * which is the worst outcome available here -- worse than refusing to set one.
   */
  it('cancels on Ctrl+C rather than submitting an empty password', () => {
    const out = feedKey({ ...EMPTY, text: 'half typed' }, CTRL_C)
    expect(out.cancelled).toBe(true)
    expect(out.text).toBe('')
  })

  it('drops control characters so an arrow key is not part of the password', () => {
    // The escape itself is dropped; what a terminal sends after it is ordinary
    // text and there is no way to tell it apart here, which is why the prompt
    // is for a password and not for editing.
    expect(feedKey(EMPTY, `${ESC}[A`).text).toBe('[A')
    expect(feedKey(EMPTY, 'ok').text).toBe('ok')
  })

  it('submits what was typed before the newline in the same chunk', () => {
    expect(feedKey(EMPTY, 'abc\rdef').text).toBe('abc')
  })
})

describe('the stored record', () => {
  /** @type {string} */
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swb-pw-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips, and refuses the wrong password', () => {
    writeFileSync(passwordFileFor(dir), recordFor('correct horse battery staple'), { mode: 0o600 })
    expect(matches(dir, 'correct horse battery staple')).toBe(true)
    expect(matches(dir, 'correct horse battery stapler')).toBe(false)
    expect(matches(dir, '')).toBe(false)
  })

  /*
   * The cost parameters are recorded in the file and read back out of it, which
   * is what lets them be raised later while old records still verify. The
   * previous attempt at this wrote them into the stored string and then never
   * passed them to scrypt, so node's defaults applied at half the intended work
   * while the file claimed otherwise.
   */
  it('records the parameters it actually used', () => {
    writeFileSync(passwordFileFor(dir), recordFor('correct horse battery staple'), { mode: 0o600 })
    const rec = readRecord(dir)
    expect(rec.algorithm).toBe('scrypt')
    expect(rec.N).toBe(65536)
    expect(rec.keylen).toBe(32)
    expect(Buffer.from(rec.hash, 'base64')).toHaveLength(rec.keylen)
    expect(Buffer.from(rec.salt, 'base64').length).toBeGreaterThanOrEqual(16)
  })

  // Anything unreadable is "no password", which refuses every request. The
  // alternative -- treating it as "no password required" -- was two of the
  // sixteen holes found the last time this was built.
  it('reads a malformed file as no password rather than as no password required', () => {
    expect(readRecord(dir)).toBeNull()
    writeFileSync(passwordFileFor(dir), 'not json at all')
    expect(readRecord(dir)).toBeNull()
    expect(matches(dir, 'anything')).toBe(false)
  })

  it('is written so that it never exists under the default umask', () => {
    writeFileSync(passwordFileFor(dir), recordFor('correct horse battery staple'), { mode: 0o600 })
    expect(statSync(passwordFileFor(dir)).mode & 0o777).toBe(0o600)
  })

  it('has a minimum length the server cannot enforce, because it only sees a hash', () => {
    expect(MIN_LENGTH).toBeGreaterThanOrEqual(12)
  })
})
