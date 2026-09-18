import { open } from 'node:fs/promises'
import type { FastifyReply } from 'fastify'
import { byteRange } from './range.js'

/**
 * A file's own bytes, out of the worktree and onto the wire.
 *
 * Its own module rather than a body inside the route because it is most of what
 * `/raw` is -- the headers below are the whole security posture of serving
 * arbitrary bytes from somebody's working tree on the origin the IDE runs on --
 * and because a route that can be driven with a temp file and no workspace is
 * one a test can hold.
 */

/**
 * The policy a file's own bytes are served under.
 *
 * `default-src 'none'; sandbox` for everything, which is what makes navigating
 * straight to one of these URLs inert: nothing it names may load, and the
 * document sits in an opaque origin where script cannot reach ours.
 *
 * **A PDF being shown is the one exception, and it is three words wide.** The
 * exception is `frame-ancestors 'self'` -- permission for *our own page* to
 * frame it -- and nothing else: the sandbox stays exactly as it is for every
 * other file.
 *
 * That last part was measured rather than assumed, because the obvious guess is
 * wrong. Chrome draws a PDF with a viewer that runs script, so `sandbox` looks
 * like it must block it and `allow-scripts` looks compulsory. It is not: the
 * viewer is a `chrome-extension://` frame *inside* the sandboxed document, not
 * script belonging to it, and a plain `sandbox` renders the page in full --
 * toolbar, thumbnail and text, checked side by side against `allow-scripts` on
 * a stand-in server serving one PDF two ways. So the opaque origin stays, no
 * script from the file may run, and the widening is one directive about who may
 * frame it. `allow-same-origin` would hand worktree bytes our origin and is
 * never correct here, whatever a blank frame tempts you to try.
 *
 * `X-Frame-Options: SAMEORIGIN` on the response is the other half of the pair,
 * for browsers that read it rather than `frame-ancestors`. A file being *taken
 * away* (`?download=1`) is never framed and keeps the strict policy, PDF or not.
 */
export const rawPolicy = (type: string, taking: boolean): string =>
  type === 'application/pdf' && !taking
    ? "default-src 'none'; frame-ancestors 'self'; sandbox"
    : "default-src 'none'; sandbox"

export interface RawFile {
  /** An absolute path, already contained -- see `files.ts`. */
  file: string
  /** From our own table, never from the client. */
  type: string
  /** `?download=1`: handed over rather than shown. */
  taking: boolean
  /** The client's `Range`, verbatim. */
  range: string | string[] | undefined
}

/**
 * Send `what`, answering `Range` if it asks for one.
 *
 * `accept-ranges` goes on every answer, the 416 and the HEAD Fastify generates
 * included, because that header is what makes a player try to seek at all.
 */
export const sendRaw = async (reply: FastifyReply, what: RawFile): Promise<FastifyReply> => {
  /*
   * Opened once, and the length taken from the open handle rather than from the
   * stat that found the file. An agent rewriting a file between the two would
   * otherwise have us promise a `content-length` the bytes do not keep, which
   * the browser reports as a broken connection. Invisible at the size of an
   * icon; a real window at the size of a video, where the stream is open for
   * seconds at a time.
   */
  const handle = await open(what.file)
  try {
    const { size } = await handle.stat()
    const wanted = byteRange(what.range, size)
    void reply
      .type(what.type)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', rawPolicy(what.type, what.taking))
      .header('content-disposition', what.taking ? 'attachment' : 'inline')
      /*
       * Never stored. The URL already changes whenever the file does, so a
       * cache buys one fetch per file per edit -- and the thing it would be
       * keeping on disk is the contents of someone's working tree.
       */
      .header('cache-control', 'no-store')
      .header('accept-ranges', 'bytes')
    // The one thing this origin lets itself frame, and only while it is being
    // shown rather than taken away. `SAMEORIGIN` is for the browsers that read
    // it rather than `frame-ancestors`; see `rawPolicy`.
    if (what.type === 'application/pdf' && !what.taking) {
      void reply.header('x-frame-options', 'SAMEORIGIN')
    }
    if (wanted === 'unsatisfiable') {
      await handle.close()
      return await reply.code(416).header('content-range', `bytes */${size}`).send()
    }
    if (wanted === 'whole') {
      return await reply.header('content-length', size).send(handle.createReadStream())
    }
    /*
     * Node's `end` is inclusive, which is the header's own convention, so the
     * pair goes straight through and the only `+1` in any of this is the
     * length. Getting that one wrong is invisible until a player stalls on the
     * last byte of a file.
     */
    return await reply
      .code(206)
      .header('content-range', `bytes ${wanted.start}-${wanted.end}/${size}`)
      .header('content-length', wanted.end - wanted.start + 1)
      .send(handle.createReadStream({ start: wanted.start, end: wanted.end }))
  } catch (err) {
    // The stream owns the handle once it exists; until then this does.
    await handle.close()
    throw err
  }
}
