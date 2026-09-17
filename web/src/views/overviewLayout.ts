/**
 * Terminal columns every pane should get.
 *
 * Below this a Claude session starts wrapping its own chrome awkwardly. It is a
 * floor now rather than an admission test: panes stop shrinking at it and the
 * row overflows instead, so no pane is narrower than this unless the window
 * itself is.
 */
export const MIN_PANE_COLUMNS = 80

/**
 * Everything in one pane's width that is not terminal, in px: the 8px inset
 * either side of the character grid, plus the pane's divider or the tile's
 * border. Kept a little over the true 17 so the column floor holds with margin.
 * Change `.tile__pane`'s padding and this has to move with it.
 *
 * It describes the terminal panes, which are the ones that set the floor. The
 * files pane deliberately has no padding of its own -- it insets per row and
 * inside the editor's gutter instead -- so it simply has more room than this
 * requires. That mismatch is not a bug to fix.
 *
 * The "change one, change both" rule is suspended below NARROW_MAX, where
 * `.tile__pane` drops its padding and this constant stays where it is. It is
 * allowed to, because the only thing this feeds is `units` -- and `units` is
 * pinned at its floor of 2 across that whole band, at either gap. Moving the
 * constant instead would change how many windows fit at desktop widths, which
 * is the one thing this layout exists to decide.
 */
export const PANE_CHROME_WIDTH = 18

let cachedKey = ''
let cachedWidth = 0

/**
 * Width of one monospace character, measured with the same font the terminal
 * uses.
 *
 * Measured rather than estimated because the minimum pane width is derived from
 * it: a ratio that is even slightly low would hand panes fewer than
 * MIN_PANE_COLUMNS columns, which is the one thing this layout guarantees.
 *
 * Floored, because that is what xterm does. It rasterises glyphs into an atlas
 * and blits them per cell, so a cell is a whole number of pixels: canvas
 * reports 8.429px for 14px monospace and xterm lays out 8. Measured back from a
 * rendered terminal, 764px of pane carried 95 columns -- 8.04px each.
 *
 * Taking the unfloored figure was safe while this was only a floor, but it now
 * decides how many tiles the window is divided into, and 5% of slack is enough
 * to cost a whole tile in a band of window widths. Floor is not a fudge factor:
 * it is the cell the terminal will actually use, on whatever font this resolves
 * to, which a fixed correction would not be.
 */
export const measureMonoCharWidth = (fontSize: number, fontFamily: string): number => {
  const key = `${fontSize}px ${fontFamily}`
  if (key === cachedKey && cachedWidth > 0) return cachedWidth
  const fallback = fontSize * 0.6
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return fallback
  context.font = key
  // Averaged over several characters to shrug off sub-pixel rounding, then
  // floored to the cell the terminal will really lay out.
  const width = Math.floor(context.measureText('M'.repeat(20)).width / 20)
  if (!(width > 0)) return fallback
  cachedKey = key
  cachedWidth = width
  return width
}

/**
 * The window width at which the interface becomes a phone's, in px.
 *
 * It is a statement about the **top bar**: below this the strip cannot hold a
 * project and its tabs at a size worth reading, so it collapses to a hamburger
 * and its contents move into a sheet -- see `useNarrow`. The row changes with
 * it only in its chrome; how many windows fit is unaffected, because `units` is
 * already pinned at its floor of 2 everywhere below about 1017px.
 *
 * Deliberately not shared with the 440px the todo panel uses. That one is about
 * how narrow a column of prose can be before it reads as fragments; this one is
 * about a strip of tabs. Two questions, two numbers, each free to move.
 */
export const NARROW_MAX = 640

/**
 * Space between tiles and around the row, in px.
 *
 * It lives here rather than in the stylesheet because tile widths are computed
 * from a measured scrollport: the arithmetic and the rendered spacing have to be
 * the same number or the row does not add up to the window. The stylesheet is
 * handed this number as `--gap` rather than repeating it.
 */
export const GAP = 12

/**
 * And nothing at all on a phone, where the window is the screen.
 *
 * A gap says "these are separate windows in a row you scroll", which is worth
 * paying for when several are on screen and worth nothing when one is: at 390px
 * the leading inset and the trailing gap cost 24px of a 390px window, which is
 * three columns of terminal out of forty-three.
 */
export const gapFor = (narrow: boolean): number => (narrow ? 0 : GAP)

/**
 * How the row divides, given a measured scrollport.
 *
 * A unit is half a pane. `pitch` is one unit plus the gap that follows it, and
 * the floor is half of a pane's own -- so two units still clear
 * MIN_PANE_COLUMNS, while a pane may be three of them.
 *
 * Two units minimum, which is one pane -- and below that it is the pitch that
 * gives, not the row: `units` cannot go under two, so a window narrower than a
 * pane's own floor divides into two units smaller than half of one and the pane
 * shrinks past MIN_PANE_COLUMNS with it. The floor is a promise about how a row
 * is divided among the windows in it, not one a window smaller than a single
 * pane can keep.
 */
export const rowMetrics = (
  width: number,
  gap: number,
  minPaneWidth: number,
): { units: number; pitch: number } => {
  const unitPitch = (minPaneWidth + gap) / 2
  const units = Math.max(2, Math.floor((width - gap) / unitPitch))
  return { units, pitch: (width - gap) / units }
}

/**
 * How far off a stop the row may rest and still count as arrived, in px.
 *
 * Written down rather than inherited, which it used to be: a tile was `gap`
 * narrower than the scrollport at each end, so the test carried ±12px of
 * accidental tolerance on top of the ±1 in the code. At gap 0 the tile *is* the
 * scrollport and that tolerance is gone -- the two clauses collapse to an
 * equality within a pixel, and a row resting fractionally off a stop (a
 * fractional `pitch` at 393px, a smooth scroll still settling, a leaving tile
 * mid-collapse) reads as "not here". Everything gated on it changes character
 * then: reveal, the growth reveal, and the Cmd+arrow walk's fallback, whose own
 * comment records that falling through "threw the walk back to a tile you had
 * already left".
 */
export const EDGE_SLACK = 2

/**
 * Is the whole of a tile on screen already?
 *
 * A tile begins one gap into its own run of the row -- the leading inset, which
 * `scroll-padding-left` matches -- and ends at the far edge of the last unit it
 * covers: it swallows the gaps between the units it spans and leaves only the
 * trailing one outside itself, so `(at + units) * pitch` is its right edge.
 */
export const wholeOnScreen = (
  tile: { at: number; units: number },
  scrollLeft: number,
  pitch: number,
  width: number,
  gap: number,
): boolean =>
  gap + tile.at * pitch >= scrollLeft - EDGE_SLACK &&
  (tile.at + tile.units) * pitch <= scrollLeft + width + EDGE_SLACK

/**
 * Which offset to scroll to so a tile is wholly on screen, moving as little as
 * possible.
 *
 * A tile of u units at `at` is whole on screen for every offset from
 * `at + u - capacity` -- its right edge against the right edge of the window --
 * to `at`, its left edge against the left. The nearest of those to where the
 * row already sits is the answer: going to the worktree just off the right edge
 * moves as little as it can and keeps the one you were on beside it, rather
 * than pulling the new one to the front and taking everything else off the
 * screen with it.
 *
 * `stops` is where the row is allowed to come to rest -- every pane's leading
 * edge, plus the far end -- and the answer has to be one of them or the browser
 * would snap it somewhere else the moment it arrived, mandatory snapping being
 * a rule about programmatic scrolls too. The clamped position is what the
 * nearest is measured from rather than `from` itself, so a tile off the right
 * edge is brought to the right edge and not dragged to the front.
 *
 * The range is never empty, because a tile is never wider than the window --
 * see `panesOf` -- so it always holds `at`, which is a pane's leading edge by
 * construction. The clamp is the fallback anyway, for a row with no stops at
 * all: before the first measured render there are none.
 */
export const nearestOffset = (
  tile: { at: number; units: number },
  from: number,
  capacity: number,
  stops: readonly number[],
): number => {
  const lo = tile.at + tile.units - capacity
  const want = Math.min(Math.max(from, lo), tile.at)
  let best: number | null = null
  for (const stop of stops) {
    if (stop < lo || stop > tile.at) continue
    if (best === null || Math.abs(stop - want) < Math.abs(best - want)) best = stop
  }
  return best ?? want
}
