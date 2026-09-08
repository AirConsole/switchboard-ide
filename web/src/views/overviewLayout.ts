/**
 * Terminal columns every worktree tile should get if the window allows it.
 * Below this a Claude session starts wrapping its own chrome awkwardly.
 */
export const MIN_TILE_COLUMNS = 80

/** Tile border plus the padding around the terminal inside it, in px. */
export const TILE_CHROME_WIDTH = 18

/**
 * Order cells for the overview: minimized worktrees always last.
 *
 * Columns fill in order, so putting them last is what puts them at the bottom.
 * Both groups keep their incoming order, so minimizing a worktree moves it down
 * without reshuffling anything else.
 */
export const sortMinimizedLast = <T>(cells: T[], isMinimized: (cell: T) => boolean): T[] => [
  ...cells.filter((cell) => !isMinimized(cell)),
  ...cells.filter(isMinimized),
]

/**
 * Split cells across the width available, then fold away any column that holds
 * nothing but minimized worktrees.
 *
 * Column count is the fewest that keeps every tile at least `minCellWidth`
 * wide. Leftover cells go to the rightmost columns, so the last column is the
 * first to split in two, then the one before it, and only once every column
 * holds two does any column hold three. The leftmost column therefore keeps the
 * fewest cells, and so the largest tiles.
 *
 * Returns the cells per column, left to right. Nothing scrolls and no column is
 * empty, so every tile gets the most width and height on offer.
 */
export const planOverviewColumns = <T>(
  cells: T[],
  isMinimized: (cell: T) => boolean,
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
  return foldMinimizedColumns(columns, isMinimized)
}

/**
 * Fold away a column holding nothing but minimized worktrees.
 *
 * A minimized tile is only a title bar, so such a column is a strip of headers
 * holding a full column's width for no reason. Its cells move into the next
 * column -- or the previous one, when it is already the last, which is the usual
 * case since minimized cells sort to the end -- and the width it was holding
 * goes to the columns that remain.
 */
const foldMinimizedColumns = <T>(columns: T[][], isMinimized: (cell: T) => boolean): T[][] => {
  const result = columns.map((column) => [...column])
  let at = 0
  while (at < result.length && result.length > 1) {
    const column = result[at]!
    if (column.length === 0 || !column.every(isMinimized)) {
      at++
      continue
    }
    const into = at + 1 < result.length ? at + 1 : at - 1
    // Keep reading order: cells from a folded column go in front of the column
    // to their right, and behind the column to their left.
    result[into] = into > at ? [...column, ...result[into]!] : [...result[into]!, ...column]
    result.splice(at, 1)
    // Deliberately not advancing. After folding right, the column that shifted
    // into this slot has not been examined and may itself be all minimized.
    // Folding left can only target a column that already held an expanded cell,
    // so that one never needs re-examining.
  }
  return result
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
