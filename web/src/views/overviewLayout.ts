/**
 * Terminal columns every tile should get if the window allows it. Below this a
 * Claude session starts wrapping its own chrome awkwardly.
 */
export const MIN_TILE_COLUMNS = 80

/** Tile border plus the padding around the terminal inside it, in px. */
export const TILE_CHROME_WIDTH = 18

/**
 * Split tiles across the width available.
 *
 * Column count is the fewest that keeps every tile at least `minCellWidth`
 * wide; the rest wrap. Leftover cells go to the rightmost columns, so the last
 * column is the first to hold two, then the one before it, and only once every
 * column holds two does any column hold three. The leftmost column therefore
 * keeps the fewest cells, and so the largest tiles.
 *
 * Returns the cells per column, left to right. Nothing scrolls and no column is
 * empty, so every tile gets the most width and height on offer.
 */
export const planOverviewColumns = <T>(
  cells: T[],
  availableWidth: number,
  minCellWidth: number,
  gap: number,
): T[][] => {
  if (cells.length === 0) return []
  // n columns occupy n * minCellWidth + (n - 1) * gap.
  const fits = Math.floor((availableWidth + gap) / (minCellWidth + gap))
  // At least one column even when the window is too narrow for the minimum --
  // one cramped tile beats no tile.
  const count = Math.max(1, Math.min(cells.length, fits))
  const base = Math.floor(cells.length / count)
  const remainder = cells.length % count

  const columns: T[][] = []
  let index = 0
  for (let column = 0; column < count; column++) {
    const size = base + (column >= count - remainder ? 1 : 0)
    columns.push(cells.slice(index, index + size))
    index += size
  }
  return columns
}

let cachedKey = ''
let cachedWidth = 0

/**
 * Width of one monospace character, measured with the same font the terminal
 * uses.
 *
 * Measured rather than estimated because the minimum tile width is derived from
 * it: a ratio that is even slightly low would hand tiles fewer than
 * MIN_TILE_COLUMNS columns, which is the one thing this layout guarantees.
 *
 * It does not match xterm's cell exactly -- canvas reports 8.429px for 14px
 * monospace where xterm lays out cells of 8.0 -- and that is the right
 * direction to be wrong in: tiles come out a few percent wider than strictly
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
