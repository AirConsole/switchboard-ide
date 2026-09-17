import { useSyncExternalStore } from 'react'
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from '../terminal/TerminalView.js'
import { measureMonoCharWidth, narrowBelow } from '../views/overviewLayout.js'

/**
 * Is this a phone?
 *
 * One threshold, asked once, answered for the whole interface, so nothing can
 * disagree about what a phone is. The answer -- not the number -- is handed to
 * CSS as `data-narrow` on `.app`, which is the `data-tight` arrangement the tab
 * strip uses and for the same reason: two copies of a breakpoint are two things
 * to keep in step.
 *
 * **The number is the width at which Claude loses its eightieth column**, and it
 * is measured rather than chosen: `narrowBelow` asks what a cell of this
 * terminal's font actually is and adds up the chrome a single window pays for.
 * It was a flat 640 until the top bar stopped having a breakpoint of its own,
 * at which point 640 described nothing -- and it was low by 45px, so a window
 * between the two kept its gaps and wrapped the agent at 76 columns to do it.
 *
 * `useSyncExternalStore` rather than state written from an effect, which is the
 * shape this usually takes and is one render late. That render is not free
 * here: `useElementSize` is deliberately a *layout* effect so no terminal is
 * built at a size we are about to replace, and a late answer would build every
 * terminal in the row at the wrong gap and then resize every pty behind it.
 *
 * It reads the **layout** viewport, not `visualViewport`. The on-screen
 * keyboard and a pinch both change the visual one, and neither of them turns a
 * phone into a desktop -- `trackViewport()` owns those, and mixing them in here
 * would make the whole interface re-lay-out when the keyboard opened.
 *
 * The safe-area insets are not subtracted, and that is a considered omission
 * rather than an oversight: they are zero in portrait and on every desktop, and
 * the one case where they are not -- a notched phone in landscape, ~88px of
 * them -- has hundreds of pixels of clearance above this threshold anyway. A
 * media query cannot read `env()`, and the arrangement above is worth more than
 * the case it cannot reach.
 */
const query = (): string => {
  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  /*
   * A hundredth under the threshold, not a whole pixel: a viewport can be
   * fractional, and `max-width: 684px` leaves 684.5 -- which is 79.94 columns,
   * so 79 -- reading as a desktop.
   */
  return `(max-width: ${narrowBelow(charWidth) - 0.02}px)`
}

const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(query())
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export const useNarrow = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query()).matches,
    // Nothing renders this on a server, but the third argument is not optional
    // when the first render has to agree with the second.
    () => false,
  )
