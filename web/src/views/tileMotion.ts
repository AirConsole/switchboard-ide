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
  /*
   * Each leaver carries its own deadline.
   *
   * The removal used to be one timer per batch, cancelled by this effect's own
   * cleanup whenever the set of tiles changed again -- and the "nothing left"
   * branch only dropped entries whose key had come *back*. A tile whose timer
   * was cancelled was in neither set, so it stayed in this list for the life of
   * the page: animated to zero width and invisible, but still a mounted
   * WorktreeTile, holding a WebGL context and polling for changes in a worktree
   * you had put away, with its buttons still in the tab order. Two projects
   * open and "Stop everything" on one of them was enough.
   */
  const [leaving, setLeaving] = useState<{ slot: Slot<T>; at: number; until: number }[]>([])
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

    const now = Date.now()
    setLeaving((current) => {
      // A worktree woken again while it was still closing is a live tile once
      // more, and one whose time is up is finished with either way.
      const kept = current.filter((entry) => !present.has(entry.slot.key) && entry.until > now)
      if (gone.length === 0 && kept.length === current.length) return current
      return [...kept, ...gone.map((entry) => ({ ...entry, until: now + MOTION_MS + 60 }))]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  /*
   * One sweep, armed at the earliest deadline and re-armed as the list changes.
   *
   * Keyed on the leavers rather than on the tiles, so nothing that is on its
   * way out depends on another tile arriving to be cleaned up.
   */
  useEffect(() => {
    if (leaving.length === 0) return
    const soonest = Math.min(...leaving.map((entry) => entry.until))
    const timer = setTimeout(
      () => setLeaving((current) => current.filter((entry) => entry.until > Date.now())),
      Math.max(0, soonest - Date.now()) + 20,
    )
    return () => clearTimeout(timer)
  }, [leaving])

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
