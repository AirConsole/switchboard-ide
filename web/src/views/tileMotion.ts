import { useEffect, useRef, useState } from 'react'

/**
 * How long a tile takes to enter, leave, or slide to a new place.
 *
 * Short on purpose. The animation exists to answer "which one moved, and where
 * did it go" -- a question you ask in the instant after clicking, and which a
 * slower movement answers no better while making every click feel sticky. Must
 * match the durations in the stylesheet.
 */
export const MOTION_MS = 140

/**
 * Where a tile sits, in px within the grid, and what is in it.
 *
 * The contents travel with the slot because a tile on its way out is no longer
 * in the layout that produced it -- looking it up again would find nothing, and
 * the tile you are watching leave would turn into whatever the fallback is
 * halfway across the screen.
 */
export interface Slot<T> {
  key: string
  left: number
  width: number
  data: T
}

export interface MovingSlot<T> extends Slot<T> {
  /** On its way out: rendered one last time, off the edge it fell past. */
  leaving: boolean
  /**
   * Which edge it leaves by.
   *
   * A tile normally goes right, having been pushed along by something arriving
   * at the left. But a tile that grows pushes the others the other way, and one
   * shoved off the left edge has to leave by the left -- sending it right would
   * fly it back across the whole grid it was just pushed out of.
   */
  exit: 'left' | 'right'
}

/**
 * Keep tiles on screen long enough to animate out.
 *
 * Entry needs no help here: a tile mounts at its final `left`, and CSS
 * transitions do not fire on an initial value, so the slide-in is a keyframe
 * animation in the stylesheet and nothing has to be staged across frames.
 *
 * Leaving is the part that needs state. React would unmount the node the
 * moment the tile stops being shown, and an element that is gone cannot
 * animate, so a tile that has just disappeared is rendered once more -- same
 * key, so React reuses the very same DOM node and the transform transitions
 * from where it was to off the right edge -- and dropped for real when the
 * movement is over.
 */
export const useTileMotion = <T,>(slots: Slot<T>[]): MovingSlot<T>[] => {
  const [leaving, setLeaving] = useState<(Slot<T> & { exit: 'left' | 'right' })[]>([])
  const previous = useRef<Slot<T>[]>([])
  // A string, so the effect runs when the placement actually changes rather
  // than on every render that rebuilds the array.
  const signature = slots.map((s) => `${s.key}@${Math.round(s.left)}+${Math.round(s.width)}`).join(',')

  useEffect(() => {
    const present = new Set(slots.map((s) => s.key))
    const wasAt = new Map(previous.current.map((s, index) => [s.key, index]))
    /*
     * Which way a tile left is read from where the survivors used to be. If
     * every one of them was to its right, it was pushed off the left; if every
     * one was to its left, off the right. Anything else -- a tile taken out of
     * the middle -- goes right, which is the grid's default direction.
     */
    const survivorPositions = slots
      .map((s) => wasAt.get(s.key))
      .filter((index): index is number => index !== undefined)
    const gone = previous.current
      .filter((s) => !present.has(s.key))
      .map((s) => {
        const at = wasAt.get(s.key) ?? 0
        const pushedLeft =
          survivorPositions.length > 0 && survivorPositions.every((index) => index > at)
        return { ...s, exit: pushedLeft ? ('left' as const) : ('right' as const) }
      })
    previous.current = slots

    if (gone.length === 0) {
      // A tile that came back while it was still animating out is a live tile
      // again; drop it from the exit list so it is not rendered twice.
      setLeaving((current) =>
        current.some((s) => present.has(s.key)) ? current.filter((s) => !present.has(s.key)) : current,
      )
      return
    }

    setLeaving((current) => [...current.filter((s) => !present.has(s.key)), ...gone])
    const timer = setTimeout(() => {
      const keys = new Set(gone.map((s) => s.key))
      setLeaving((current) => current.filter((s) => !keys.has(s.key)))
    }, MOTION_MS + 60)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return [
    ...slots.map((s) => ({ ...s, leaving: false, exit: 'right' as const })),
    // Kept exactly where they were, at the width they had: the stylesheet
    // slides them out, so there is one mechanism for the exit and the tile does
    // not reflow on its way off screen.
    ...leaving.map((s) => ({ ...s, leaving: true })),
  ]
}
