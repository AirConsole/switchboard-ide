/**
 * Which files the browser draws itself, and as what.
 *
 * Here rather than in the server because both sides need the same answer at
 * different times: the server decides from it how to read a file (and what to
 * serve `/raw` as), and the files panel decides from it, *before* that read
 * has answered, whether an opened file is somewhere the keyboard can go -- a
 * picture has nothing to type into or move through, so arriving at one must
 * not take the keyboard off the tree. One table, so the two cannot disagree.
 */

/**
 * Types the browser draws itself, by extension.
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
 * about files with no text in them.
 *
 * Video and audio are not here either. They would need `Range` to be honest --
 * a 200 with the whole file plays but cannot seek -- and that is a request
 * handler of its own rather than a row in this table.
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
])

/** The media type to render `rel` as, or undefined for everything else. */
export const mediaTypeOf = (rel: string): string | undefined => {
  const dot = rel.lastIndexOf('.')
  if (dot <= rel.lastIndexOf('/')) return undefined
  return MEDIA_TYPES.get(rel.slice(dot).toLowerCase())
}
