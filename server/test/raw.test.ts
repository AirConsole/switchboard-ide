import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendRaw, rawPolicy } from '../src/raw.js'
import { registerSecurityHeaders } from '../src/headers.js'

/*
 * The bytes on the wire, driven through a real Fastify rather than reasoned
 * about: what `Range` means is `range.ts`'s business and is tested there, and
 * what is *sent* for each answer is this file's.
 */
let dir: string
let app: FastifyInstance
/** Ten bytes, so an off-by-one at either end is a different letter. */
const TEXT = 'abcdefghij'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swb-raw-'))
  await writeFile(join(dir, 'clip.mp4'), TEXT)
  await writeFile(join(dir, 'empty.mp4'), '')
  await writeFile(join(dir, 'doc.pdf'), TEXT)

  app = Fastify()
  // The real hook, because two of the claims below are about what it does and
  // does not overwrite.
  registerSecurityHeaders(app)
  app.get('/raw', async (request, reply) => {
    const { name = 'clip.mp4', type = 'video/mp4', taking } = request.query as Record<string, string>
    return sendRaw(reply, {
      file: join(dir, name),
      type,
      taking: taking === '1',
      range: request.headers.range,
    })
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

describe('serving a file’s own bytes', () => {
  it('says it can be seeked, on every answer', async () => {
    // Without this header a player does not try, and a video plays from the
    // start and nowhere else.
    for (const headers of [{}, { range: 'bytes=2-4' }, { range: 'bytes=99-' }]) {
      const res = await app.inject({ url: '/raw', headers })
      expect(res.headers['accept-ranges']).toBe('bytes')
    }
  })

  it('sends the whole file when nothing was asked for', async () => {
    const res = await app.inject({ url: '/raw' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(TEXT)
    expect(res.headers['content-length']).toBe('10')
    expect(res.headers['content-range']).toBeUndefined()
  })

  it('sends exactly the slice asked for, both ends inclusive', async () => {
    /*
     * The `+1`. Node's `end` is inclusive like the header's, so a slice that
     * drops its last byte -- `cd` here instead of `cde` -- is the signature of
     * treating one of the two as exclusive.
     */
    const res = await app.inject({ url: '/raw', headers: { range: 'bytes=2-4' } })
    expect(res.statusCode).toBe(206)
    expect(res.body).toBe('cde')
    expect(res.headers['content-range']).toBe('bytes 2-4/10')
    expect(res.headers['content-length']).toBe('3')
  })

  it('sends the tail for a suffix range', async () => {
    // An MP4 that is not "faststart" has its index at the end, so this is the
    // first request a player makes and the one that decides whether it plays.
    const res = await app.inject({ url: '/raw', headers: { range: 'bytes=-3' } })
    expect(res.statusCode).toBe(206)
    expect(res.body).toBe('hij')
    expect(res.headers['content-range']).toBe('bytes 7-9/10')
  })

  it('refuses a range that starts past the end, and says how long the file is', async () => {
    // `bytes */10` is what tells the player where the end actually was; without
    // it a seek past the end has nothing to recover from.
    const res = await app.inject({ url: '/raw', headers: { range: 'bytes=10-' } })
    expect(res.statusCode).toBe(416)
    expect(res.headers['content-range']).toBe('bytes */10')
    expect(res.body).toBe('')
  })

  it('sends an empty file rather than refusing every range of it', async () => {
    const res = await app.inject({ url: '/raw?name=empty.mp4', headers: { range: 'bytes=0-' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-length']).toBe('0')
  })

  it('keeps the strict headers on every answer', async () => {
    for (const headers of [{}, { range: 'bytes=2-4' }, { range: 'bytes=99-' }]) {
      const res = await app.inject({ url: '/raw', headers })
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
      // Never a filename: the client's own anchor names the file, and it can
      // only win while this header carries no name to beat it.
      expect(res.headers['content-disposition']).toBe('inline')
    }
  })
})

/*
 * A PDF is the one file this origin frames, and the exception is exactly two
 * things wide. Everything else -- including the same PDF on its way out as a
 * download -- keeps the policy above.
 */
describe('the PDF exception', () => {
  it('lets our own page frame a PDF, and only ours', async () => {
    const res = await app.inject({ url: '/raw?name=doc.pdf&type=application/pdf' })
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'")
  })

  it('widens nothing but who may frame it', async () => {
    /*
     * The obvious guess is that Chrome's viewer needs `allow-scripts`, and it
     * is wrong: the viewer is a chrome-extension frame *inside* the sandboxed
     * document rather than script belonging to it, and a plain `sandbox`
     * renders the page in full -- measured against `allow-scripts` side by
     * side. So the sandbox is untouched and the whole exception is one
     * directive about who may frame the file.
     */
    expect(rawPolicy('application/pdf', false)).toBe(
      "default-src 'none'; frame-ancestors 'self'; sandbox",
    )
    // Either of these would put worktree bytes where script can spend the
    // session, and a blank frame is not a reason to reach for them.
    expect(rawPolicy('application/pdf', false)).not.toContain('allow-same-origin')
    expect(rawPolicy('application/pdf', false)).not.toContain('allow-scripts')
  })

  it('does not extend to a PDF being downloaded, or to anything else', async () => {
    // A download is never framed, so it has no reason to be framable.
    const taken = await app.inject({ url: '/raw?name=doc.pdf&type=application/pdf&taking=1' })
    expect(taken.headers['x-frame-options']).toBe('DENY')
    expect(taken.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(taken.headers['content-disposition']).toBe('attachment')

    const video = await app.inject({ url: '/raw' })
    expect(video.headers['x-frame-options']).toBe('DENY')
  })
})
