import { useEffect, useState } from 'react'

/**
 * How much the visible viewport has to lose before it is a keyboard.
 *
 * A soft keyboard takes a third of a phone's screen -- measured on a 780px
 * viewport, 360px of it. What else moves the visual viewport is the browser's
 * own chrome hiding as you scroll, which is tens of pixels, and a pinch, which
 * `trackViewport` already refuses to read. 120px is clear of the first and well
 * under the second.
 */
export const SOFT_KEYBOARD_MIN = 120

/** Is this shrunken viewport a keyboard, against the tallest we have seen? */
export const keyboardShown = (visible: number, tallest: number): boolean =>
  tallest - visible >= SOFT_KEYBOARD_MIN

/**
 * Whether the on-screen keyboard is up.
 *
 * There is no API that says so -- `navigator.virtualKeyboard` reports only a
 * keyboard the page asked to own, which this one does not, because
 * `interactive-widget=resizes-content` is the arrangement the rest of the
 * layout is built on (see `viewport.ts`). What is observable is the height: the
 * keyboard resizes the visual viewport, so the answer is how much shorter the
 * viewport is than the tallest it has been at this width.
 *
 * **Per width**, which is how orientation is handled: turning the phone is a
 * new width and a new tallest, rather than a landscape viewport being read as a
 * keyboard covering half of a portrait one.
 *
 * The tallest is remembered rather than derived from the screen: `screen.height`
 * is the device, not the browser's share of it, and the difference is the
 * browser's own chrome -- which is exactly the size of the thing this has to
 * not mistake for a keyboard.
 */
export const useSoftKeyboard = (): boolean => {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const viewport = window.visualViewport
    /** The tallest viewport seen at each width. */
    const tallest = new Map<number, number>()
    const read = (): void => {
      if (viewport != null && Math.abs(viewport.scale - 1) > 0.01) return
      const height = Math.round(viewport?.height ?? window.innerHeight)
      const width = Math.round(viewport?.width ?? window.innerWidth)
      const seen = Math.max(tallest.get(width) ?? 0, height)
      tallest.set(width, seen)
      setShown(keyboardShown(height, seen))
    }
    read()
    viewport?.addEventListener('resize', read)
    window.addEventListener('resize', read)
    window.addEventListener('orientationchange', read)
    return () => {
      viewport?.removeEventListener('resize', read)
      window.removeEventListener('resize', read)
      window.removeEventListener('orientationchange', read)
    }
  }, [])
  return shown
}

/**
 * Is the keyboard in front of the reader drawn on the glass?
 *
 * A coarse pointer is the honest test available: nothing reports whether a
 * physical keyboard is attached, and `(pointer: coarse)` is true of exactly the
 * devices whose keyboard takes half the screen when it appears. Read at the
 * moment it is needed rather than once, since a tablet gains and loses a mouse.
 */
export const softKeys = (): boolean => window.matchMedia('(pointer: coarse)').matches
