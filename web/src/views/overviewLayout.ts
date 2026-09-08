/**
 * Terminal columns every worktree tile should get if the window allows it.
 * Below this a Claude session starts wrapping its own chrome awkwardly.
 */
export const MIN_TILE_COLUMNS = 80

/** Tile border plus the padding around the terminal inside it, in px. */
export const TILE_CHROME_WIDTH = 18

export interface OverviewLayout {
  columns: number
  /** How many cells each column holds, left to right. */
  perColumn: number[]
}

/**
 * Decide how to split `cellCount` cells across the width available.
 *
 * Use as few columns as possible while keeping every tile at least
 * `minCellWidth` wide, then stack each column's share of the cells at equal
 * heights. Leftover cells go to the rightmost columns, so the last column is
 * the first to split in two, then the one before it, and only once every column
 * holds two does any column hold three.
 *
 * The result always fills the area exactly: no column is empty and nothing
 * scrolls, so every tile gets the most width and height on offer.
 */
export const planOverviewLayout = (
  cellCount: number,
  availableWidth: number,
  minCellWidth: number,
  gap: number,
): OverviewLayout => {
  if (cellCount <= 0) return { columns: 0, perColumn: [] }
  // n columns occupy n * minCellWidth + (n - 1) * gap.
  const fits = Math.floor((availableWidth + gap) / (minCellWidth + gap))
  // At least one column even when the window is too narrow for the minimum --
  // one cramped tile beats no tile.
  const columns = Math.max(1, Math.min(cellCount, fits))
  const base = Math.floor(cellCount / columns)
  const remainder = cellCount % columns
  return {
    columns,
    // Filling from the right means the leftmost column keeps the fewest cells,
    // and so the largest tiles.
    perColumn: Array.from({ length: columns }, (_, index) =>
      base + (index >= columns - remainder ? 1 : 0),
    ),
  }
}

/** Deal `cells` into columns of the sizes the plan calls for. */
export const splitIntoColumns = <T>(cells: T[], perColumn: number[]): T[][] => {
  const columns: T[][] = []
  let index = 0
  for (const count of perColumn) {
    columns.push(cells.slice(index, index + count))
    index += count
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
