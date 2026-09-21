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
 * The "change one, change both" rule is suspended below `narrowBelow`, where
 * `.tile__pane` drops its padding and this constant stays where it is. It is
 * allowed to, because the only thing this feeds is `units` -- and `units` is
 * pinned at its floor of 2 across that whole band, at either gap. Moving the
 * constant instead would change how many windows fit at desktop widths, which
 * is the one thing this layout exists to decide.
 *
 * It is also why the threshold is honest about what it buys: below it the pane
 * really has 2px of chrome rather than 18, so the terminal gets those sixteen
 * back on top of the two gaps -- five columns at an 8px cell, measured.
 */
export const PANE_CHROME_WIDTH = 18

/**
 * What xterm keeps back before it divides a pane into cells, in px.
 *
 * Not ours and not a scrollbar: `FitAddon.proposeDimensions` reads
 *
 *     const t = this._terminal.options.scrollback === 0
 *       ? 0
 *       : this._terminal.options.overviewRuler?.width || 14
 *
 * and subtracts it from the width it divides. It is a flat 14 for every
 * terminal that has scrollback, which every terminal here does, on every
 * platform -- so it is a constant rather than a measurement, and there is
 * nothing to probe: the row decides how wide to make a pane before a terminal
 * exists to ask.
 *
 * It is why this layout's eighty columns were seventy-eight. `PANE_CHROME_WIDTH`
 * counts what the *stylesheet* spends and stops there, so a pane sitting exactly
 * on the floor handed xterm 640px of room and xterm laid out 78 cells in it.
 * Measured at the old floor: a 658px pane, 642 inside its inset, 628 after this,
 * 78 columns. At the new one: 672, 656, 642, **80**.
 *
 * Re-measure it when xterm is upgraded, which is a three-line check: the pane's
 * width, `.xterm-screen`'s width, and the pane's padding. What is left over is
 * this, and `options.overviewRuler` is the one thing that would change it.
 */
export const XTERM_RULER_WIDTH = 14

/**
 * Everything a pane spends before a character of terminal, in px.
 *
 * The stylesheet's inset and border, plus what xterm keeps back. This is the
 * number the 80-column floor has to be built on -- `PANE_CHROME_WIDTH` alone
 * was the same arithmetic with a quarter of the chrome left out of it.
 */
export const PANE_CHROME = PANE_CHROME_WIDTH + XTERM_RULER_WIDTH

/**
 * What the files pane spends before a character of code, in px.
 *
 * Both are the stylesheet's, and must move with it: `--files-tree-min` is the
 * narrowest the tree may be -- three sentence-case mode labels measured 157px,
 * below which the switch clips -- and `--files-editor-chrome` is the editor's
 * line-number gutter plus the inset on each line, asked for on top of its 80
 * columns rather than out of them.
 *
 * They are here because the *row* decides whether the tree fits beside the
 * file, and it decides before either exists.
 */
export const FILES_TREE_MIN = 158
/*
 * The stylesheet's own `--files-editor-chrome` at three digits. The pane
 * replaces it with the gutter it measures, which only ever asks for *more* --
 * and the extra comes out of the tree, which is why this stays the number the
 * row budgets the tree against.
 */
export const FILES_EDITOR_CHROME = 52

/**
 * The narrowest bar segment that can still say its toggles in words, in px.
 *
 * Measured rather than guessed: `TERMINAL` is 86.98px (the legend's own
 * measurement, `Overview.tsx`), and the worst realistic set -- `2 TERMINALS`,
 * `3 QUEUED`, `FILES 12±` with the fork -- comes to about 295. A worktree's
 * name and its prompt want ~125 beside them, which is the point of the swap:
 * they are what gives way otherwise, being the only things in the bar that can.
 *
 * Below this the toggles are glyphs. It fires on a single-pane tile under about
 * 450px of window -- a phone, or a desktop window dragged that far -- and never
 * on a two-unit Claude segment, which is 664px at the width where three windows
 * first fit.
 */
export const TOGGLE_WORDS_MIN = 420

/**
 * What a tile spends on itself horizontally, in px: a 1px border on the right
 * and the 2px `--rail` on the left, which is the leading edge its state is
 * drawn on. `.tile__pane`'s own inset is counted in PANE_CHROME_WIDTH instead.
 */
export const TILE_CHROME = 3

/**
 * The editor's type size, from `editor/theme.ts`.
 *
 * A point smaller than the terminal's, and that is deliberate there; it is here
 * because eighty columns of editor is eighty of *this*, and measuring it at the
 * terminal's 14px would ask for 9% more room than the file needs.
 */
export const EDITOR_FONT_SIZE = 13

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
export const measureMonoCharWidth = (fontSize: number, fontFamily: string): number =>
  Math.floor(monoAdvance(fontSize, fontFamily))

/**
 * The same measurement, **unfloored**.
 *
 * The floor above is not a fudge factor, it is what xterm does -- it blits
 * glyphs from an atlas per cell, so a cell is a whole number of pixels. The
 * editor is not a grid: CodeMirror lays text out on real metrics, and its own
 * width is `calc(80ch + …)` in CSS, where `ch` is the true advance. Flooring
 * that question answers it wrong by the fraction times eighty -- 7px against
 * 7.83 is sixty-six pixels of an eighty-column measure, which is ten columns.
 *
 * So: this is what a character is, and `measureMonoCharWidth` is what a
 * terminal cell is. Ask for the one you mean.
 */
export const monoAdvance = (fontSize: number, fontFamily: string): number => {
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
 * The window width below which the interface becomes a phone's, in px.
 *
 * **It is the width at which Claude loses its eightieth column**, and it is
 * computed rather than chosen: one pane's floor, plus the tile's own edges,
 * plus the two gaps a single window pays for -- the leading inset and the
 * trailing one. At 8px a cell that is 658 + 3 + 24 = 685.
 *
 * It was 640 for a while, and 640 was a statement about a top bar that no
 * longer has a breakpoint: the strip gives things up by the rung now, measured
 * against the room it has. A number left behind by the thing it described is a
 * number nobody can check, and this one was wrong in the direction that costs
 * the most -- between 640 and 685 the row kept paying for chrome the window
 * could not afford, and the agent wrapped at 76 columns to buy a 12px gap
 * either side of a single window.
 *
 * Below it, the row drops that chrome and the pane's own 8px inset, which is
 * about 40px -- five columns at this size -- and that is the whole of what
 * "phone" means here: the window is the screen, so the spacing that says "these
 * are windows in a row" has nothing to say and the terminal takes it instead.
 *
 * Still deliberately not the 440px the todo panel uses. That one is about how
 * narrow a column of prose can be before it reads as fragments. Two questions,
 * two numbers, each free to move -- and this one moves on its own now, with the
 * font the terminal actually resolves to.
 */
export const narrowBelow = (charWidth: number): number =>
  MIN_PANE_COLUMNS * charWidth + PANE_CHROME + TILE_CHROME + 2 * GAP

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
