import { useEffect, useRef, useState } from 'react'

/**
 * How long a tile takes to open or close. Must match `--motion` in the
 * stylesheet.
 *
 * Short on purpose. The movement is there to say "this one just woke up" in the
 * instant after you clicked; slower says it no better and makes every click
 * feel sticky.
 */
export const MOTION_MS = 140

/** How wide a tile is, and what is in it. */
export interface Slot<T> {
  key: string
  width: number
  data: T
}

export interface MovingSlot<T> extends Slot<T> {
  /** On its way out: rendered one last time, collapsing to nothing. */
  leaving: boolean
}

/**
 * Keep tiles mounted long enough to close.
 *
 * Opening needs no help: a tile mounts at its final width and a keyframe grows
 * it from nothing, because a CSS transition does not fire on an initial value.
 *
 * Closing is the part that needs state. React would unmount the node the moment
 * a worktree goes to sleep, and an element that is gone cannot animate -- so a
 * tile that has just left is rendered once more under the same key, which makes
 * React reuse the very same DOM node so its width transitions to zero, and is
 * dropped for real when the movement is over.
 *
 * The contents travel with the slot because a sleeping worktree is no longer in
 * the list that produced it: looking it up again would find nothing, and the
 * tile you are watching close would empty out halfway.
 */
export const useTileMotion = <T,>(slots: Slot<T>[]): MovingSlot<T>[] => {
  const [leaving, setLeaving] = useState<{ slot: Slot<T>; at: number }[]>([])
  const previous = useRef<Slot<T>[]>([])
  // A string, so the effect runs when the set of tiles actually changes rather
  // than on every render that rebuilds the array.
  const signature = slots.map((slot) => slot.key).join(',')

  useEffect(() => {
    const present = new Set(slots.map((slot) => slot.key))
    // Remembered with the place it held, so it can be rendered back into it.
    const gone = previous.current
      .map((slot, at) => ({ slot, at }))
      .filter((entry) => !present.has(entry.slot.key))
    previous.current = slots

    if (gone.length === 0) {
      // A worktree woken again while it was still closing is a live tile once
      // more; drop it from the exit list so it is not rendered twice.
      setLeaving((current) =>
        current.some((entry) => present.has(entry.slot.key))
          ? current.filter((entry) => !present.has(entry.slot.key))
          : current,
      )
      return
    }

    setLeaving((current) => [...current.filter((entry) => !present.has(entry.slot.key)), ...gone])
    const timer = setTimeout(() => {
      const keys = new Set(gone.map((entry) => entry.slot.key))
      setLeaving((current) => current.filter((entry) => !keys.has(entry.slot.key)))
    }, MOTION_MS + 60)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  /*
   * A closing tile is rendered back into the place it held, not on the end.
   *
   * That is not cosmetic. React reorders by moving DOM nodes, and moving a node
   * cancels the CSS transition running on it -- so a tile appended to the end
   * of the list snapped to zero width instead of closing. Left where it was,
   * the node stays put and the transition actually plays.
   */
  const out: MovingSlot<T>[] = slots.map((slot) => ({ ...slot, leaving: false }))
  for (const { slot, at } of leaving) {
    out.splice(Math.min(at, out.length), 0, { ...slot, leaving: true })
  }
  return out
}
