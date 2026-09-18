import { describe, expect, it } from 'vitest'
import { byteRange } from '../src/range.js'

/*
 * Every case here is a way a player breaks, not a way the specification reads.
 * A hundred-byte file throughout, so the last byte is 99 and an off-by-one is
 * visible at a glance.
 */
describe('what a Range header asks for', () => {
  it('asks for nothing when there is no header', () => {
    // A 206 for every request would mean a download that never completes.
    expect(byteRange(undefined, 100)).toBe('whole')
  })

  it('reads an ordinary range inclusively, both ends', () => {
    expect(byteRange('bytes=0-49', 100)).toEqual({ start: 0, end: 49 })
    // One byte, not zero: `content-length` is end - start + 1, and this is the
    // case where forgetting the +1 sends an empty body that looks like an end.
    expect(byteRange('bytes=0-0', 100)).toEqual({ start: 0, end: 0 })
  })

  it('takes an open end to mean the end of the file', () => {
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
  })

  it('clamps a range that reaches past the end rather than refusing it', () => {
    // A player that knows roughly where a frame is asks generously; a 416 here
    // would stall it on a file it could have played.
    expect(byteRange('bytes=0-9999', 100)).toEqual({ start: 0, end: 99 })
  })

  it('reads a suffix as the last N bytes, not as a negative start', () => {
    /*
     * The one that decides whether a video plays at all: an MP4 that is not
     * "faststart" keeps its moov atom at the end, so this is Chrome's *first*
     * request. Read as a negative offset it reaches createReadStream as
     * ERR_OUT_OF_RANGE and answers 500.
     */
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('takes a suffix longer than the file to be the whole file', () => {
    // `size - suffix` is negative here, which is the bug this guards.
    expect(byteRange('bytes=-99999', 10)).toEqual({ start: 0, end: 9 })
  })

  it('refuses only a range that starts past the end', () => {
    // The sole 416. A 206 of nothing wedges a player for ever on a seek past
    // the end, because it never learns there is nothing there.
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=100-200', 100)).toBe('unsatisfiable')
    // A zero-length suffix satisfies nothing either.
    expect(byteRange('bytes=-0', 100)).toBe('unsatisfiable')
  })

  it('ignores a malformed field instead of failing on it', () => {
    // §14.1.1: an invalid ranges-specifier is ignored. Refusing would answer
    // 416 to a client that merely sent nonsense; sending the whole file is
    // always legal. `5-1` read literally is a negative content-length.
    expect(byteRange('bytes=5-1', 100)).toBe('whole')
    expect(byteRange('bytes=abc', 100)).toBe('whole')
    expect(byteRange('bytes=', 100)).toBe('whole')
    expect(byteRange('bytes=-', 100)).toBe('whole')
    expect(byteRange('', 100)).toBe('whole')
  })

  it('ignores a unit it does not speak, and more than one range', () => {
    expect(byteRange('items=0-5', 100)).toBe('whole')
    // Several ranges would mean generating multipart/byteranges. Answering the
    // whole file is legal (§14.2) and no player here asks for two.
    expect(byteRange('bytes=0-9,20-29', 100)).toBe('whole')
  })

  it('ignores a repeated header, which does not say which one was meant', () => {
    expect(byteRange(['bytes=0-9', 'bytes=20-29'], 100)).toBe('whole')
  })

  it('does not let a huge number through as arithmetic', () => {
    // Past Number.MAX_SAFE_INTEGER the comparisons stop meaning anything, and
    // NaN reaching createReadStream is a 500.
    expect(byteRange('bytes=99999999999999999999-', 100)).toBe('whole')
    expect(byteRange('bytes=0-99999999999999999999', 100)).toBe('whole')
  })

  it('sends an empty file whole rather than refusing every range of it', () => {
    /*
     * A deliberate deviation: the specification says 416 for any range of a
     * zero-byte representation. An empty file is a legitimate file and
     * `bytes=0-` is a routine probe -- a 416 makes the browser report a broken
     * source for a file whose only crime is being empty.
     */
    expect(byteRange('bytes=0-', 0)).toBe('whole')
    expect(byteRange('bytes=-10', 0)).toBe('whole')
  })
})
