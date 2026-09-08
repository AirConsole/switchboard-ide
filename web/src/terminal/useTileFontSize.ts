import { useEffect, useState, type RefObject } from 'react'

/**
 * Rough metrics for a monospace cell as a fraction of font size. These are
 * estimates, so a safety factor keeps a slight underestimate from clipping the
 * rightmost column -- the tile clips rather than scrolls, so overflow silently
 * eats content.
 */
const CHAR_WIDTH_RATIO = 0.62
const LINE_HEIGHT_RATIO = 1.2
const SAFETY = 0.97

export const MIN_TILE_FONT = 5
export const MAX_TILE_FONT = 13

/**
 * Font size that makes a `cols`x`rows` terminal fit inside an element.
 *
 * Overview tiles shrink the font rather than CSS-scaling the terminal: glyphs
 * are then rasterised at their real size instead of being bitmap-scaled, which
 * stays legible at small sizes where a transform turns to mush. Crucially,
 * neither approach changes cols/rows, so looking at the overview never reflows
 * a running TUI.
 */
export const useTileFontSize = (
  ref: RefObject<HTMLElement | null>,
  cols: number,
  rows: number,
): number => {
  const [fontSize, setFontSize] = useState(MIN_TILE_FONT + 2)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect()
      if (width < 8 || height < 8) return
      const byWidth = width / (cols * CHAR_WIDTH_RATIO)
      const byHeight = height / (rows * LINE_HEIGHT_RATIO)
      const next = Math.floor(Math.min(byWidth, byHeight) * SAFETY * 10) / 10
      setFontSize(Math.max(MIN_TILE_FONT, Math.min(MAX_TILE_FONT, next)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, cols, rows])

  return fontSize
}
