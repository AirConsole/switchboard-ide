import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureMonoCharWidth } from '../src/views/overviewLayout.js'

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

  it('falls back to a ratio when there is no canvas to measure with', () => {
    stubCanvas(null)
    expect(measureMonoCharWidth(14, 'no-canvas')).toBeCloseTo(14 * 0.6)
  })

  it('falls back rather than returning zero when the measurement is empty', () => {
    stubCanvas(0)
    expect(measureMonoCharWidth(14, 'zero-width')).toBeCloseTo(14 * 0.6)
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
