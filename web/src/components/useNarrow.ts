import { useSyncExternalStore } from 'react'
import { NARROW_MAX } from '../views/overviewLayout.js'

/**
 * Is this a phone?
 *
 * One threshold, asked once, answered for the whole interface: the top bar
 * collapses to a hamburger and the row drops its gaps at the same width, so
 * they cannot disagree about what a phone is. `NARROW_MAX` is where the number
 * lives, in TS, and CSS is told the answer -- `data-narrow` on `.app` -- rather
 * than being given the number to repeat. That is the `data-tight` arrangement
 * the tab strip already uses, and the reason is the same: two copies of a
 * breakpoint are two things to keep in step.
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
 */
const query = `(max-width: ${NARROW_MAX}px)`

const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(query)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export const useNarrow = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Nothing renders this on a server, but the third argument is not optional
    // when the first render has to agree with the second.
    () => false,
  )
