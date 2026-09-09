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
