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
 * It does not match xterm's cell exactly -- canvas reports 8.429px for 14px
 * monospace where xterm lays out cells of 8.0 -- and that is the right
 * direction to be wrong in: panes come out a few percent wider than strictly
 * needed, so the column floor holds with margin. Do not "correct" this by
 * shrinking the estimate without checking the rendered cols first.
 */
export const measureMonoCharWidth = (fontSize: number, fontFamily: string): number => {
  const key = `${fontSize}px ${fontFamily}`
  if (key === cachedKey && cachedWidth > 0) return cachedWidth
  const fallback = fontSize * 0.6
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return fallback
  context.font = key
  // Averaged over several characters to shrug off sub-pixel rounding.
  const width = context.measureText('M'.repeat(20)).width / 20
  if (!(width > 0)) return fallback
  cachedKey = key
  cachedWidth = width
  return width
}
