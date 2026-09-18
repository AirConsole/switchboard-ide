/**
 * Which files the browser shows itself, and as what.
 *
 * Here rather than in the server because both sides need the same answer at
 * different times: the server decides from it how to read a file (and what to
 * serve `/raw` as), and the files panel decides from it, *before* that read
 * has answered, whether an opened file is somewhere the keyboard can go -- a
 * picture has nothing to type into or move through, so arriving at one must
 * not take the keyboard off the tree. One table, so the two cannot disagree.
 */

/**
 * Types the browser renders itself, by extension.
 *
 * The rule the panel keeps is "not text, but the browser can show it" -- so
 * this is deliberately a list of renderers, not a list of file formats. A TIFF
 * or a HEIC is every bit as much an image and is not here, because Chrome would
 * show the reader a broken-image glyph, which is worse than the note saying
 * plainly that there is nothing to see.
 *
 * By extension rather than by sniffing the bytes, because the decision has to
 * be made *before* the file is read: a 20MB photograph is over `maxFileBytes`
 * and would answer `tooLarge` for a file that costs nothing to show, and
 * nothing here wants to pull a video into the server's heap to look at its
 * first four bytes. The browser is given the type we name and told not to sniff
 * -- see the `/raw` route -- so a `.png` holding something else renders as a
 * broken image and runs nothing.
 *
 * No `.svg`, on purpose, and it is not an oversight: an SVG *is* text, it
 * decodes, and it opens in the editor like any other source file. The rule is
 * about files with no text in them. A `.m3u` playlist is text for the same
 * reason.
 *
 * **Video, audio and PDF are here now, and what let them in was `Range`.** This
 * comment used to say they could not be, because a 200 with the whole file
 * plays but cannot seek, and that seeking "is a request handler of its own
 * rather than a row in this table". That handler is `server/src/range.ts`.
 *
 * The bar for a moving picture is lower than for a still one, and that is why
 * `.mov` is admissible where a TIFF was not: a `<video>` that cannot play
 * reports `MEDIA_ERR_SRC_NOT_SUPPORTED`, which the panel turns into a plain
 * sentence, while a broken `<img>` gives the reader a glyph and nothing to
 * catch. QuickTime holding H.264 -- what every phone and screen recorder emits
 * -- plays; holding ProRes it does not, and then it says so.
 *
 * Left out, and each for the same reason the images are: **`.mkv`** (no browser
 * here demuxes Matroska, whatever the codecs inside), `.avi`, `.wmv`, `.flv`,
 * `.mpg`/`.mpeg` (no demuxer either), **`.ts`/`.m3u8`/`.mpd`** (Media Source
 * Extensions plus a JavaScript player, and a renderer we do not have is not a
 * renderer), `.mid` (no synthesiser in any browser), `.wma`, `.aiff`, `.amr`,
 * and `.ps`/`.eps`/`.epub`/`.djvu`.
 */
const MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.apng', 'image/apng'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  // `.ogg` is audio and `.ogv` is video: ambiguous by the specification,
  // unambiguous in practice. Opus travels in an Ogg container and is named as
  // one -- `audio/opus` is not a type Chrome's media stack accepts for it.
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
])

/** The media type to render `rel` as, or undefined for everything else. */
export const mediaTypeOf = (rel: string): string | undefined => {
  const dot = rel.lastIndexOf('.')
  if (dot <= rel.lastIndexOf('/')) return undefined
  return MEDIA_TYPES.get(rel.slice(dot).toLowerCase())
}

/** What kind of element shows a file: the panel's question, not the server's. */
export type MediaKind = 'image' | 'video' | 'audio' | 'pdf'

/**
 * Which element the panel should draw `rel` in, or undefined for a file it
 * cannot show at all.
 *
 * Derived from the type rather than from a second table, and it asks
 * `mediaTypeOf` rather than re-reading the string, so the dot rule and the case
 * folding have one implementation. **It is undefined exactly when `mediaTypeOf`
 * is** -- a row added later whose prefix this does not know has to fail that
 * test rather than quietly make a file unopenable, which is what the test
 * beside it asserts over the whole table.
 *
 * The server never asks. Its one exception is keyed on the concrete type
 * (`application/pdf`), because the header it changes is about a media type and
 * not about a category.
 */
export const mediaKindOf = (rel: string): MediaKind | undefined => {
  const type = mediaTypeOf(rel)
  if (type === undefined) return undefined
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return undefined
}
