/**
 * Terminal columns every pane should get. Below this a Claude session starts
 * wrapping its own chrome awkwardly, so a pane that cannot have this many is
 * not shown at all.
 */
export const MIN_PANE_COLUMNS = 80

/** Tile border plus the padding around the terminal inside one pane, in px. */
export const PANE_CHROME_WIDTH = 18

/**
 * Choose which panes are shown, side by side.
 *
 * There are no rows. Every pane is a full-height column of equal width, whether
 * it holds a worktree's Claude session or one of that worktree's panels, so as
 * the window narrows panes are pushed out from the right rather than allowed to
 * shrink below MIN_PANE_COLUMNS.
 *
 * Two things are protected, in order:
 *
 *  1. `newestKey` -- the pane that just appeared because you asked for it.
 *     Pushing that one out would make your click look like it had done nothing.
 *  2. The rest of that pane's group, so a worktree brought back from the top bar
 *     returns at the width it had instead of arriving stripped of its panels.
 *
 * Everything else then fills from the left, and what is left over is dropped.
 * That is what makes switching Terminals on for a worktree displace the other
 * worktrees on a normal window, and displace its own Claude pane on a phone
 * where only one column fits -- the tile is still there, showing the one column
 * there is room for.
 *
 * No state is changed and nothing scrolls: this is only about what fits, so
 * widening the window brings the rest straight back.
 */
export const planColumns = <T>(
  cells: T[],
  keyOf: (cell: T) => string,
  groupOf: (cell: T) => string,
  newestKey: string | null,
  availableWidth: number,
  minCellWidth: number,
  gap: number,
): T[] => {
  if (cells.length === 0) return []
  /*
   * n panes occupy n * minCellWidth + (n - 1) * gap.
   *
   * Panes within one tile have no gap between them, so this asks for a little
   * more room than a multi-column tile actually needs -- erring towards showing
   * one pane fewer, which is the safe direction to be wrong in.
   *
   * At least one pane, even when the window is too narrow for the minimum: one
   * cramped pane beats an empty screen.
   */
  const capacity = Math.max(1, Math.floor((availableWidth + gap) / (minCellWidth + gap)))
  if (cells.length <= capacity) return cells

  const keep = new Set<string>()
  const newest = newestKey === null ? undefined : cells.find((cell) => keyOf(cell) === newestKey)
  if (newest) {
    keep.add(keyOf(newest))
    for (const cell of cells) {
      if (keep.size >= capacity) break
      if (groupOf(cell) === groupOf(newest)) keep.add(keyOf(cell))
    }
  }
  for (const cell of cells) {
    if (keep.size >= capacity) break
    keep.add(keyOf(cell))
  }
  return cells.filter((cell) => keep.has(keyOf(cell)))
}

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
