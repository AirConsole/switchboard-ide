/**
 * Terminal columns every tile should get. Below this a Claude session starts
 * wrapping its own chrome awkwardly, so a tile that cannot have this many is
 * not shown at all.
 */
export const MIN_TILE_COLUMNS = 80

/** Tile border plus the padding around the terminal inside it, in px. */
export const TILE_CHROME_WIDTH = 18

export interface TilePlan<T> {
  /** Tiles that fit, in display order. */
  visible: T[]
  /** Tiles pushed out for want of width, in display order. */
  hidden: T[]
  /** How many tiles fit at the minimum width. */
  capacity: number
}

/**
 * Choose which tiles are shown, side by side.
 *
 * There are no rows: every tile is a full-height column. So as the window
 * narrows, rather than letting columns shrink below MIN_TILE_COLUMNS, tiles are
 * pushed out from the right until the rest fit.
 *
 * The exception is `newestKey` -- the tile that just appeared because you asked
 * for it. Pushing that one out would mean your click appeared to do nothing, so
 * it is kept and something else goes instead. On a phone, where only one tile
 * fits, opening a worktree's terminals therefore displaces its Claude tile.
 *
 * Nothing is scrolled and no state is changed: this is only about what fits, so
 * widening the window brings the rest straight back.
 */
export const planTiles = <T>(
  cells: T[],
  keyOf: (cell: T) => string,
  newestKey: string | null,
  availableWidth: number,
  minCellWidth: number,
  gap: number,
): TilePlan<T> => {
  if (cells.length === 0) return { visible: [], hidden: [], capacity: 0 }
  // n tiles occupy n * minCellWidth + (n - 1) * gap.
  // At least one, even when the window is too narrow for the minimum: one
  // cramped tile beats no tile.
  const capacity = Math.max(1, Math.floor((availableWidth + gap) / (minCellWidth + gap)))
  if (cells.length <= capacity) return { visible: cells, hidden: [], capacity }

  const keep = new Set<string>()
  // The newest tile claims its place first; the set then dedupes it when the
  // fill below reaches it.
  if (cells.some((cell) => keyOf(cell) === newestKey) && newestKey !== null) keep.add(newestKey)
  for (const cell of cells) {
    if (keep.size >= capacity) break
    keep.add(keyOf(cell))
  }
  return {
    visible: cells.filter((cell) => keep.has(keyOf(cell))),
    hidden: cells.filter((cell) => !keep.has(keyOf(cell))),
    capacity,
  }
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
