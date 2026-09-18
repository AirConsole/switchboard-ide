import { describe, expect, it } from 'vitest'
import { downloadSource } from '../src/views/FilesPane.js'

/** A panel with nothing open, which each case below fills in one field of. */
const nothing = {
  worktreeId: 'wt-1',
  path: '',
  file: null,
  media: null,
  refusal: null,
  dirty: false,
  draft: (): string | null => null,
}

describe('where a download comes from', () => {
  it('hands over what is on screen, not what is on disk', () => {
    // Preview's rule, applied to the download: the draft wins while there is
    // one, because downloading something other than what you are looking at is
    // a surprise a download cannot be taken back from.
    const disk = { ...nothing, path: 'a.ts', file: { path: 'a.ts', text: 'on disk' } }
    expect(downloadSource(disk)).toEqual({ text: 'on disk' })
    expect(downloadSource({ ...disk, dirty: true, draft: () => 'typed' })).toEqual({
      text: 'typed',
    })
  })

  it('asks the server for a file the panel would not open', () => {
    /*
     * The bug: "if a file is too large to be displayed, there is no download
     * button". A refused file has no text in the browser and is not an image,
     * so both of the other two sources are empty -- and the button was drawn
     * from those two alone, which is why there was none.
     */
    const refused = { ...nothing, path: 'logs/huge.log', refusal: '9000 KB — too large' }
    expect(downloadSource(refused)).toEqual({
      url: '/api/worktrees/wt-1/raw?path=logs%2Fhuge.log&download=1',
    })
    // Not text either: same answer, and the same reason for it.
    expect(downloadSource({ ...refused, path: 'a.bin', refusal: 'This is not a text file.' })).toEqual(
      { url: '/api/worktrees/wt-1/raw?path=a.bin&download=1' },
    )
  })

  it('reuses the URL an image is already drawn from', () => {
    const media = {
      ...nothing,
      path: 'art/logo.png',
      media: { path: 'art/logo.png', type: 'image/png', url: '/api/raw?x=1', size: 12 },
    }
    expect(downloadSource(media)).toEqual({ url: '/api/raw?x=1' })
  })

  it('does the same for anything else the browser shows itself', () => {
    /*
     * A video, a sound file and a PDF are the same case as the image and must
     * not fall through to the text arm, which would hand over an empty blob
     * named after a 700 MB file.
     */
    for (const [path, type] of [
      ['clip.mp4', 'video/mp4'],
      ['tone.mp3', 'audio/mpeg'],
      ['spec.pdf', 'application/pdf'],
    ]) {
      const shown = {
        ...nothing,
        path: path as string,
        media: { path: path as string, type: type as string, url: `/api/raw?p=${path}`, size: 9 },
      }
      expect(downloadSource(shown)).toEqual({ url: `/api/raw?p=${path}` })
    }
  })

  it('offers nothing while there is nothing', () => {
    // Nothing open, and a file whose read has not come back yet. Without the
    // second, the button would hand over an empty file as the file.
    expect(downloadSource(nothing)).toBe(null)
    expect(downloadSource({ ...nothing, path: 'a.ts' })).toBe(null)
  })
})
