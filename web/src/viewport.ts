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
  window.addEventListener('orientationchange', apply)
}
