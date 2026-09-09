import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether an element is on screen, or nearly.
 *
 * This is what keeps the filmstrip affordable. Every awake worktree has a tile
 * whether or not you can see it, and a tile that mounted its terminal would
 * cost a WebGL context -- of which a browser grants a page around sixteen
 * before it starts taking them away again -- plus an xterm render loop and a
 * five-thousand-line scrollback, for content nobody is looking at.
 *
 * Unmounting a terminal is safe here in a way it would not be in most
 * applications: the server keeps a headless mirror of every session and
 * serialises it on attach, so a terminal that comes back paints exactly what it
 * would have shown. And with nothing attached, the server leaves that session's
 * geometry alone rather than resizing the pty to whatever last looked at it.
 *
 * The margin is generous because scrolling should not be a race: by the time a
 * tile reaches the edge of the scrollport its terminal has already painted.
 */
export const useNearViewport = (
  target: RefObject<Element | null>,
  scroller: RefObject<Element | null>,
  rootMargin = '100%',
): boolean => {
  const [near, setNear] = useState(false)

  useEffect(() => {
    const element = target.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting)
      },
      // A null root falls back to the viewport, which is the right answer while
      // the scroller is still mounting.
      { root: scroller.current, rootMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [target, scroller, rootMargin])

  return near
}
