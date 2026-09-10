/**
 * Keep the app exactly as tall as the part of the screen you can see.
 *
 * On a phone the on-screen keyboard does not shrink the page: it is drawn over
 * it, and `height: 100%` still means the whole window, so the bottom of the
 * interface -- which is where the terminal and its input live -- ends up behind
 * the keyboard. `interactive-widget=resizes-content` in the viewport meta asks
 * the browser to resize the page instead, which Chrome honours and Safari does
 * not, so the visual viewport is mirrored into a custom property as well and
 * the layout uses that.
 *
 * `offsetTop` matters too: iOS scrolls the layout viewport up to keep the caret
 * visible rather than resizing anything, and without accounting for it the app
 * is the right height in the wrong place.
 */
export const trackViewport = (): void => {
  const viewport = window.visualViewport
  const apply = (): void => {
    /*
     * Not while zoomed.
     *
     * The visual viewport shrinks for a pinch exactly as it does for a
     * keyboard, and the app's height is the pty's height: a zoom would reach
     * the ResizeObserver, resize the terminal and reflow the running TUI at
     * whatever row count the magnified view happens to have. A zoom is a way
     * of looking at something, not a geometry negotiation, so the last known
     * size stands until the pinch is released.
     */
    if (viewport != null && Math.abs(viewport.scale - 1) > 0.01) return
    const height = viewport?.height ?? window.innerHeight
    const offset = viewport?.offsetTop ?? 0
    const root = document.documentElement
    root.style.setProperty('--app-height', `${Math.round(height)}px`)
    root.style.setProperty('--app-offset', `${Math.round(offset)}px`)
  }
  apply()
  // Both, because the two browsers report a keyboard differently: one resizes
  // the visual viewport, the other scrolls it.
  viewport?.addEventListener('resize', apply)
  viewport?.addEventListener('scroll', apply)
  // And the window itself, which is the only signal there is when the visual
  // viewport is missing -- without it the fallback above is measured once at
  // load and never again, on the one browser that depends on it.
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
}
