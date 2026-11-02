/**
 * URLs that Claude Code broke across lines itself.
 *
 * Claude Code lays its output out at the pane's width and writes the line
 * breaks into the stream, indenting each continuation line to the message's
 * margin. A URL too long for the line is broken mid-token, and what reaches the
 * terminal is two ordinary lines with a newline between them. Nothing marks the
 * second as a continuation -- `isWrapped` is false, and `tmux capture-pane -J`
 * leaves them apart -- so xterm's web-links addon, which only follows soft
 * wraps, linked the first line's half on its own: a click opened a URL cut off
 * at the right edge. Measured in a builders pane 82 columns wide, a GitHub
 * settings URL: line one 82 cells and ending `.../n-dr`, line two `  eam-...`.
 *
 * What gives the break away is that it is mid-token: Claude Code wraps at
 * spaces, so a line ends in its last cell only when a word was too long to
 * fit. A URL running into the last cell, followed by a line that is a margin
 * and then more URL, is one URL. The one it gets wrong is a URL that happens to
 * end in exactly the last cell, which then borrows the next line's first word
 * -- rarer than the break it fixes, which happens to every URL longer than the
 * room left on its line.
 *
 * A soft-wrapped URL -- a shell printing one longer than the terminal -- is the
 * addon's, and this leaves it alone: those lines are `wrapped`.
 */

export interface Row {
  /** The line's text, trailing blanks trimmed. */
  text: string
  /** Whether the line's last cell holds something. */
  full: boolean
  /** Whether the terminal itself wrapped this line onto the one before. */
  wrapped: boolean
}

/** 1-based, end inclusive -- xterm's `ILink` range. */
export interface BrokenUrl {
  url: string
  start: { x: number; y: number }
  end: { x: number; y: number }
}

// The web-links addon's own pattern, so a URL ends where it would have ended
// had it fitted on one line -- a trailing full stop or comma is not part of it.
const URL_RE = /^https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/
const TAIL = /https?:\/\/\S*$/
// A margin, then the URL going on. Claude Code's margin is two columns, more
// inside a list; a line indented further than this is not its continuation.
const CONTINUATION = /^( {0,12})([A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/
// How far above the hovered line a broken URL may have begun. A long OAuth URL
// at 80 columns is five or six lines.
const LOOKBACK = 32

const follow = (row: (y: number) => Row | undefined, y: number, cols: number): BrokenUrl | undefined => {
  const first = row(y)
  if (first === undefined || !first.full || first.wrapped) return undefined
  const tail = TAIL.exec(first.text)?.[0]
  if (tail === undefined) return undefined
  // The tail ends in the last cell and URLs are single-width, so it starts
  // tail.length cells from the right -- whatever widths came before it.
  const pieces = [{ y, x: cols - tail.length + 1, text: tail }]
  for (let at = y + 1; ; at++) {
    const next = row(at)
    if (next === undefined || next.wrapped) break
    const match = CONTINUATION.exec(next.text)
    if (match === null) break
    const margin = match[1] ?? ''
    const more = match[2] ?? ''
    pieces.push({ y: at, x: margin.length + 1, text: more })
    if (!next.full || margin.length + more.length < next.text.length) break
  }
  if (pieces.length < 2) return undefined
  const url = URL_RE.exec(pieces.map((p) => p.text).join(''))?.[0]
  if (url === undefined || url.length <= tail.length) return undefined
  const start = { x: cols - tail.length + 1, y }
  let left = url.length
  for (const piece of pieces) {
    if (left <= piece.text.length) return { url, start, end: { x: piece.x + left - 1, y: piece.y } }
    left -= piece.text.length
  }
  return undefined
}

/** The broken URLs that cross line `y`. */
export const brokenUrlsAt = (row: (y: number) => Row | undefined, y: number, cols: number): BrokenUrl[] => {
  const found: BrokenUrl[] = []
  for (let from = Math.max(1, y - LOOKBACK); from <= y; from++) {
    const link = follow(row, from, cols)
    if (link === undefined) continue
    if (link.end.y >= y) found.push(link)
    from = link.end.y
  }
  return found
}
