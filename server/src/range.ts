/**
 * What a `Range` header asks for, and nothing about how it is answered.
 *
 * Pure, and at the top level beside `media.ts` for the same reason that one is:
 * it is a fact about HTTP rather than about this server, and it is testable
 * with no route, no file and no Fastify.
 *
 * It exists because a `<video>` is not a picture: the browser opens a file by
 * asking for a slice of it, and a server that answers 200 with the whole thing
 * gives you a clip that plays from the start and cannot be seeked. Worse for
 * the common case than that sounds -- an MP4 that was not written "faststart"
 * keeps its `moov` atom at the *end*, so Chrome's opening move is a suffix
 * range for the tail, and a server that cannot answer it shows no picture at
 * all rather than a slow one.
 */

/**
 * A range, or the two ways there is not one.
 *
 * `start` and `end` are both **inclusive**, which is the header's own
 * convention and also Node's for `createReadStream` -- so the pair passes
 * straight through with no arithmetic, and `content-length` is the one place a
 * `+1` belongs.
 */
export type Wanted = { start: number; end: number } | 'whole' | 'unsatisfiable'

/** `bytes=` and then one range of it. Anything else is not a range we answer. */
const ONE_RANGE = /^bytes=(\d*)-(\d*)$/

/**
 * What `header` asks for of a file of `size` bytes.
 *
 * Every arm of this is written to fail *towards* sending the whole file, which
 * is always a legal answer (RFC 9110 §14.2: a server may ignore `Range`), and
 * never towards an error. The one exception is a range that begins past the end
 * of the file, which has to be 416 -- a 206 of nothing wedges a player on a
 * seek past the end for ever.
 */
export const byteRange = (header: string | string[] | undefined, size: number): Wanted => {
  /*
   * A repeated header arrives as an array, which is ambiguous about which one
   * the sender meant. Ambiguity is answered with the whole file, like every
   * other malformed case here.
   */
  if (typeof header !== 'string') return 'whole'
  const parts = ONE_RANGE.exec(header.trim())
  /*
   * This also takes care of a unit we do not speak (`items=0-5`), of a header
   * with several ranges in it (`bytes=0-9,20-29`), and of whitespace inside the
   * value. Several ranges would mean generating `multipart/byteranges`, which
   * is a parser and an encoder for a case no player here produces.
   */
  if (parts === null) return 'whole'
  const [, first = '', last = ''] = parts
  /*
   * A zero-length file. The specification says 416, and this deliberately does
   * not: an empty file is a legitimate file, `bytes=0-` is a routine opening
   * probe, and a 416 makes the browser report a broken source for a file whose
   * only crime is having nothing in it.
   */
  if (size === 0) return 'whole'

  // `bytes=-500` is a *suffix* -- the last 500 bytes -- and not a negative
  // start. Read naively it produces a negative offset, which reaches
  // `createReadStream` as ERR_OUT_OF_RANGE and answers 500 to a legal request.
  if (first === '') {
    if (last === '') return 'whole'
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix)) return 'whole'
    // A zero-length suffix satisfies nothing; a suffix longer than the file is
    // the whole file, which is the specification's own answer.
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(first)
  if (!Number.isSafeInteger(start)) return 'whole'
  // The only 416: there is no byte at that offset to begin from.
  if (start >= size) return 'unsatisfiable'
  if (last === '') return { start, end: size - 1 }
  const asked = Number(last)
  if (!Number.isSafeInteger(asked)) return 'whole'
  // Last before first is not a range at all. §14.1.1 says an invalid
  // ranges-specifier must be ignored, not refused -- refusing it would be a 416
  // for a client that merely sent nonsense, and the whole file answers it.
  if (asked < start) return 'whole'
  // Asking past the end is ordinary: a player that knows roughly where a frame
  // is asks generously. Clamp rather than refuse.
  return { start, end: Math.min(asked, size - 1) }
}
