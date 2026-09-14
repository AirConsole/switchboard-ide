import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface AnchoredMenu<A extends HTMLElement> {
  /** Where to draw it, or null when it is closed. */
  at: { left: number; top: number } | null
  /** Put this on the control it hangs from. */
  anchor: React.RefObject<A | null>
  /** Put this on the menu itself, so a click inside it is not a click outside. */
  menu: React.RefObject<HTMLDivElement | null>
  /** The anchor's own onClick: open it, or close it if it is already open. */
  toggle: () => void
  close: () => void
}

/** How close to an edge of the window a menu may be drawn. */
const MARGIN = 8

/**
 * A small panel hung under the control that opened it.
 *
 * Three things here are not obvious, and each was a bug:
 *
 * It is positioned against the viewport rather than against its anchor, because
 * the things it hangs from live in scrollers -- the tab strip, a todo list --
 * and a scroller clips what overflows it in *both* directions: `overflow-x:
 * auto` computes `overflow-y` to auto as well. An absolutely positioned menu
 * was there in the markup, at the right coordinates, and cut off entirely.
 *
 * It hangs from a rect measured when it was opened, so a scroll or a resize
 * left it pointing at something that had moved. Re-measured rather than
 * dismissed, because dismissing something you did not click is its own surprise.
 *
 * And it is kept inside the window. Hanging it from the anchor's left corner is
 * right for a control at the left of the top bar and wrong for one at the right
 * of the last window in the row -- measured, a 180px menu on the todo panel's
 * Move to ran 140px past the edge of the screen, with nothing to scroll it back.
 * So it is measured once drawn and pulled back in, and flips above its anchor
 * rather than running off the bottom of a long list.
 */
export const useAnchoredMenu = <A extends HTMLElement>(): AnchoredMenu<A> => {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const anchor = useRef<A | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)

  /**
   * Where the menu should be, given where its anchor is and how big it came out.
   *
   * Before the first paint the menu has no size, so this falls back to the
   * anchor's own corner -- which is what it settles on anyway wherever there is
   * room, so nothing is seen to move.
   */
  const place = useCallback((): void => {
    const box = anchor.current?.getBoundingClientRect()
    if (!box) return
    const size = menu.current?.getBoundingClientRect()
    const width = size?.width ?? 0
    const height = size?.height ?? 0
    const left = Math.max(MARGIN, Math.min(box.left, window.innerWidth - width - MARGIN))
    // Under the anchor, or above it when there is no room under -- and if it
    // fits neither way, as far down as it can go, so the top of the list is
    // reachable rather than the bottom.
    const under = box.bottom
    const top =
      under + height <= window.innerHeight - MARGIN
        ? under
        : box.top - height >= MARGIN
          ? box.top - height
          : Math.max(MARGIN, window.innerHeight - height - MARGIN)
    setAt((was) =>
      was !== null && Math.abs(was.left - left) < 0.5 && Math.abs(was.top - top) < 0.5
        ? was
        : { left, top },
    )
  }, [])

  // Measured only once it is on screen, so the first placement is a correction
  // of the rough one `toggle` made rather than a frame of the menu somewhere
  // else. `place` bails out when nothing moved, so this settles in one pass.
  useLayoutEffect(() => {
    if (at !== null) place()
  }, [at, place])

  // A dropdown that only closes by pressing the thing that opened it is a
  // dropdown you get stuck with.
  useEffect(() => {
    if (at === null) return
    const dismiss = (event: Event): void => {
      const target = event.target as Node
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return
      setAt(null)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAt(null)
    }
    window.addEventListener('resize', place)
    // Capture, so a scroll of the strip itself is heard as well as the window's.
    document.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', key)
    }
  }, [at, place])

  return {
    at,
    anchor,
    menu,
    toggle: () => {
      const box = anchor.current?.getBoundingClientRect()
      setAt((was) =>
        was !== null || box === undefined ? null : { left: box.left, top: box.bottom },
      )
    },
    close: () => setAt(null),
  }
}
