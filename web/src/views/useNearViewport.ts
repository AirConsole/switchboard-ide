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
 *
 * Wider sideways than up and down, and that 10% is not a cushion -- it is the
 * difference between mounting and not. The row scrolls sideways, so the
 * neighbour that matters is the one a screen to the left or right; with no gap
 * between tiles its leading edge lands *exactly* on the edge of the expanded
 * root rect, and an intersection rectangle of zero width is not an
 * intersection. At a plain `100%` the next worktree along stays unmounted until
 * the scroll actually begins, and you arrive at a terminal that is only then
 * attaching and repainting.
 */
export const useNearViewport = (
  target: RefObject<Element | null>,
  scroller: RefObject<Element | null>,
  rootMargin = '100% 110%',
): boolean => {
  const [near, setNear] = useState(false)
  /*
   * The root, as an element rather than a ref.
   *
   * An IntersectionObserver's root is fixed when it is constructed, and a ref
   * is empty on the render that fills it -- so reading `scroller.current`
   * inside the observer effect alone would leave every tile observed against
   * the viewport for the life of the row if the scroller ever mounted second.
   * The viewport is the wrong root here: it does not know where the row is
   * clipped, so tiles scrolled out of the strip but still inside the window
   * read as near and mount terminals nobody can see. Holding it in state is
   * what gives the effect something to depend on.
   */
  const [root, setRoot] = useState<Element | null>(null)
  // No dependency array on purpose: a ref filling in is not a render input, so
  // there is nothing to key on. The body is a reference comparison, and the
  // state is set only when the answer actually changed.
  useEffect(() => {
    setRoot((was) => (was === scroller.current ? was : scroller.current))
  })

  useEffect(() => {
    const element = target.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting)
      },
      { root, rootMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [target, root, rootMargin])

  return near
}
