import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EDGE_SLACK,
  GAP,
  MIN_PANE_COLUMNS,
  PANE_CHROME_WIDTH,
  TILE_CHROME,
  XTERM_RULER_WIDTH,
  gapFor,
  measureMonoCharWidth,
  monoAdvance,
  PANE_CHROME,
  narrowBelow,
  nearestOffset,
  rowMetrics,
  wholeOnScreen,
} from '../src/views/overviewLayout.js'

/**
 * jsdom's canvas has no 2d context unless the `canvas` package is installed, so
 * `measureText` is stubbed. That is the honest thing to test in any case: what
 * this has to get right is the arithmetic on a measurement -- the floor, and
 * the fallback -- not whether a headless canvas can measure a glyph.
 */
const stubCanvas = (perChar: number | null): { font: string } => {
  const context = {
    font: '',
    measureText: (text: string) => ({ width: text.length * (perChar ?? 0) }),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    (perChar === null ? null : context) as unknown as CanvasRenderingContext2D,
  )
  return context
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('measureMonoCharWidth', () => {
  it('floors the measurement, because that is the cell xterm lays out', () => {
    /*
     * Canvas reports 8.429px for 14px monospace and xterm lays out 8: it
     * rasterises glyphs into an atlas and blits them per cell, so a cell is a
     * whole number of pixels. Taking the unfloored figure was safe while this
     * was only a floor, but it now decides how many windows the screen is
     * divided into, and 5% of slack costs a whole one in a band of widths.
     */
    stubCanvas(8.429)
    expect(measureMonoCharWidth(14, 'floor-test')).toBe(8)
  })

  it('floors the fallback too, because a cell is always whole', () => {
    stubCanvas(null)
    expect(measureMonoCharWidth(14, 'no-canvas')).toBe(Math.floor(14 * 0.6))
    // The raw one keeps the fraction, which is what an 80ch measure needs.
    expect(monoAdvance(14, 'no-canvas')).toBeCloseTo(14 * 0.6)
  })

  it('falls back rather than returning zero when the measurement is empty', () => {
    // Also floored: 14 * 0.6 is 8.4, and no terminal lays out four tenths of a
    // pixel. `monoAdvance` is where the fraction is kept.
    stubCanvas(0)
    expect(measureMonoCharWidth(14, 'zero-width')).toBe(Math.floor(14 * 0.6))
  })

  it('measures with the font it was given', () => {
    const context = stubCanvas(9)
    measureMonoCharWidth(16, 'Menlo, monospace')
    expect(context.font).toBe('16px Menlo, monospace')
  })

  it('caches one font at a time, and re-measures when it changes', () => {
    stubCanvas(8.9)
    expect(measureMonoCharWidth(14, 'cache-A')).toBe(8)
    // Same key: the cached answer stands even though the canvas now says 20.
    stubCanvas(20)
    expect(measureMonoCharWidth(14, 'cache-A')).toBe(8)
    // A different key has to go back to the canvas.
    expect(measureMonoCharWidth(14, 'cache-B')).toBe(20)
  })
})

/*
 * The row's own arithmetic, at the widths that decide things.
 *
 * It lived in `Overview` as a closure and could only be checked in a browser,
 * which is why the phone was wrong for a year: `units` is pinned at 2 below
 * about 1017px, so nothing about a narrow window was ever exercised. These are
 * the numbers measured off a rendered row at 14px Menlo, where a cell is 8px.
 */
describe('narrowBelow', () => {
  /*
   * The threshold is the width at which Claude loses its eightieth column, so
   * the test is that claim and not the number: at the threshold a single
   * window, paying both gaps and the tile's own edges, still measures 80
   * columns, and a pixel under it measures 79.
   *
   * It was a flat 640 while the top bar had a breakpoint of its own to justify
   * it. The bar gives things up by the rung now, and 640 was 45px low -- a
   * window in between kept its gaps and wrapped the agent at 76 columns to pay
   * for them.
   */
  const columnsAt = (width: number, charWidth: number, chrome: number): number => {
    const minPane = MIN_PANE_COLUMNS * charWidth + chrome
    const { pitch } = rowMetrics(width, GAP, minPane)
    // A tile of two units, less the tile's own edges and everything the pane
    // spends before a character: its inset, its border, and xterm's scrollbar.
    const pane = 2 * pitch - GAP - TILE_CHROME
    return Math.floor((pane - chrome) / charWidth)
  }

  it('is the width where the eightieth column goes', () => {
    for (const charWidth of [7, 8, 9]) {
      const at = narrowBelow(charWidth)
      expect(columnsAt(at, charWidth, PANE_CHROME)).toBe(MIN_PANE_COLUMNS)
      expect(columnsAt(at - 1, charWidth, PANE_CHROME)).toBe(MIN_PANE_COLUMNS - 1)
    }
  })

  it('moves with the font, which is the point of computing it', () => {
    // 672 + 3 + 24 at an 8px cell, and eighty px more for every px of cell.
    expect(narrowBelow(8)).toBe(699)
    expect(narrowBelow(9) - narrowBelow(8)).toBe(MIN_PANE_COLUMNS)
  })

  /*
   * The bug the pane's chrome had: `PANE_CHROME_WIDTH` counts what the
   * stylesheet spends, and xterm keeps back 14 more before it divides the rest
   * into cells -- `FitAddon`'s `overviewRuler?.width || 14`. A pane on the old
   * floor handed it 640px and got 78 columns for the 80 this layout promises.
   */
  it('reserves what xterm keeps back as well as what the stylesheet does', () => {
    expect(PANE_CHROME).toBe(PANE_CHROME_WIDTH + XTERM_RULER_WIDTH)
    expect(columnsAt(narrowBelow(8), 8, PANE_CHROME_WIDTH + 1)).toBeGreaterThan(MIN_PANE_COLUMNS)
  })
})

describe('rowMetrics', () => {
  // 80 columns of 8px, plus the 18px of pane that is not terminal.
  const minPane = MIN_PANE_COLUMNS * 8 + PANE_CHROME_WIDTH

  it('gives a phone one window, with no gap and none without', () => {
    for (const width of [390, 430, 640]) {
      expect(rowMetrics(width, 0, minPane).units).toBe(2)
      expect(rowMetrics(width, GAP, minPane).units).toBe(2)
    }
  })

  it('makes a tile the whole screen once the gap is gone', () => {
    // A tile of u units is `u * pitch - gap`, so at gap 0 two units is the
    // window itself -- which is the point of the change.
    for (const width of [390, 430, 640]) {
      const { pitch } = rowMetrics(width, 0, minPane)
      expect(2 * pitch - 0).toBeCloseTo(width, 6)
    }
  })

  it('leaves the desktop where it was', () => {
    expect(rowMetrics(641, GAP, minPane).units).toBe(2)
    expect(rowMetrics(768, GAP, minPane).units).toBe(2)
    // The first width that buys a third unit, and the band this layout was
    // designed around.
    expect(rowMetrics(1024, GAP, minPane).units).toBe(3)
    expect(rowMetrics(1920, GAP, minPane).units).toBe(5)
    expect(rowMetrics(2400, GAP, minPane).units).toBe(7)
  })

  it('never divides the row below one pane', () => {
    // A phone narrower than half a pane still gets two units; it is the pitch
    // that gives, not the row.
    expect(rowMetrics(200, 0, minPane).units).toBe(2)
    expect(rowMetrics(1, 0, minPane).units).toBe(2)
  })
})

describe('gapFor', () => {
  it('is nothing on a phone and the gap everywhere else', () => {
    expect(gapFor(true)).toBe(0)
    expect(gapFor(false)).toBe(GAP)
  })
})

/*
 * The two functions the row navigates by, at both gaps.
 *
 * The property that matters is that they agree: whatever `nearestOffset`
 * answers must be somewhere `wholeOnScreen` calls arrived, or a reveal scrolls
 * and then reports that it has not arrived -- and with mandatory snapping the
 * browser would move it again anyway.
 */
describe('nearestOffset and wholeOnScreen', () => {
  // A phone's row: a project pane and three worktrees, two units each.
  const cells = [
    { at: 0, units: 2 },
    { at: 2, units: 2 },
    { at: 4, units: 2 },
    { at: 6, units: 2 },
  ]
  const stops = [0, 2, 4, 6]

  it('answers with a stop, from wherever the row is', () => {
    for (const cell of cells) {
      for (const from of [0, 1, 1.5, 3, 5.5, 7, 99, -4]) {
        expect(stops).toContain(nearestOffset(cell, from, 2, stops))
      }
    }
  })

  it('answers with an offset that is actually arrived', () => {
    const width = 390
    const { units, pitch } = rowMetrics(width, 0, MIN_PANE_COLUMNS * 8 + PANE_CHROME_WIDTH)
    for (const cell of cells) {
      const offset = nearestOffset(cell, 0, units, stops)
      expect(wholeOnScreen(cell, offset * pitch, pitch, width, 0)).toBe(true)
    }
  })

  /*
   * The slack is the whole reason `EDGE_SLACK` is written down. At gap 12 a
   * tile was 24px narrower than the scrollport, so this test passed on
   * tolerance nobody had asked for; at gap 0 the tile *is* the scrollport and
   * the only tolerance left is the one in the code. A row resting a pixel and a
   * half off -- a fractional pitch, a smooth scroll still settling -- is still
   * there.
   */
  it('still counts as arrived a pixel and a half off the stop', () => {
    const width = 393
    const { pitch } = rowMetrics(width, 0, MIN_PANE_COLUMNS * 8 + PANE_CHROME_WIDTH)
    const cell = { at: 2, units: 2 }
    expect(wholeOnScreen(cell, cell.at * pitch + 1.5, pitch, width, 0)).toBe(true)
    expect(wholeOnScreen(cell, cell.at * pitch - 1.5, pitch, width, 0)).toBe(true)
    // And not somewhere it plainly is not: half a screen off is not arrived.
    expect(wholeOnScreen(cell, (cell.at + 1) * pitch, pitch, width, 0)).toBe(false)
    expect(EDGE_SLACK).toBeGreaterThan(1)
  })

  it('brings a tile to the right edge rather than the front', () => {
    // From the left, the least movement that shows the last tile whole is to
    // put its right edge against the window's -- which at one tile per screen
    // is its own start.
    expect(nearestOffset({ at: 6, units: 2 }, 0, 2, stops)).toBe(6)
    // With room for more, the row moves as little as it can.
    const wide = [0, 2, 4, 6]
    expect(nearestOffset({ at: 6, units: 2 }, 0, 4, wide)).toBe(4)
  })
})

/*
 * The two questions a monospace measurement can answer, and why they are not
 * the same function.
 *
 * A terminal cell is a whole number of pixels because xterm blits glyphs from
 * an atlas per cell. A character in the editor is not: CodeMirror lays out on
 * real metrics, and `.files__file` asks for `calc(80ch + …)`, where `ch` is the
 * true advance. Answering the second question with the first is wrong by the
 * fraction times eighty -- ten columns of an eighty-column measure.
 */
describe('monoAdvance against measureMonoCharWidth', () => {
  it('keeps the fraction where the cell floors it', () => {
    stubCanvas(7.83)
    expect(monoAdvance(13, 'split-a')).toBeCloseTo(7.83)
    expect(measureMonoCharWidth(13, 'split-b')).toBe(7)
  })

  it('agrees when the measurement is already whole', () => {
    stubCanvas(8)
    expect(monoAdvance(14, 'whole-a')).toBe(8)
    expect(measureMonoCharWidth(14, 'whole-b')).toBe(8)
  })

  it('is what an eighty-column measure must be built on', () => {
    stubCanvas(7.83)
    // 80 columns is 626px, not the 560 the floored cell would claim -- and the
    // 66px between them is the whole question of whether a tree fits beside it.
    expect(Math.round(80 * monoAdvance(13, 'eighty-a'))).toBe(626)
    expect(Math.round(80 * measureMonoCharWidth(13, 'eighty-b'))).toBe(560)
  })
})
