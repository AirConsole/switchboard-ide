import { useEffect, type RefObject } from 'react'

export interface ListKeys {
  /**
   * The column: the first control of every line, in the order they are drawn.
   * Up and down walk these.
   */
  rows: string
  /**
   * The other controls on a line, where a line has more than one -- a
   * worktree's × beside its name, a todo's three actions. Left and right walk
   * these, and up and down keep the place in the line rather than dropping back
   * to its start, which is what a column of like controls should do.
   */
  cells?: string
  /** How to find a line from a control inside it. Required with `cells`. */
  line?: string
  /** Off where the pane draws something this does not describe. */
  enabled?: boolean
}

/**
 * A pane that is a list answers to the arrows: up and down walk it, left and
 * right reach across a line, Enter takes what you are on.
 *
 * The vertical sibling of `useDialogKeys` -- which takes all four arrows too,
 * so a hand that reaches for one does not have to have looked at which way the
 * thing in front of it runs. The rules are the same ones said about a column
 * instead of a row: focus *is* the selection, Enter is the browser's own on a
 * real button, and `⏎` is drawn on what it would take. What differs is the
 * reach: a dialog is modal and listens at the window, while this is one pane
 * among several, so it listens on its own box and means nothing while the
 * keyboard is somewhere else.
 *
 * **A field keeps the arrows.** A caret in a text box owns every direction it
 * can move in, so an event that starts in one is not this hook's -- which is
 * also why a todo's prompt is not in its column, and why the project pane's
 * branch box is in the column but hands the horizontal back.
 *
 * **No wrapping.** A list has a top and a bottom, and running off either end of
 * one should feel like an end rather than a loop -- unlike a dialog's two or
 * three answers, which are a ring you feel your way around.
 */
export const useListKeys = (pane: RefObject<HTMLElement | null>, keys: ListKeys): void => {
  const { rows, cells, line, enabled = true } = keys
  useEffect(() => {
    const box = pane.current
    if (!box || !enabled) return

    /** The column, read live: a pane's list is whatever it holds right now. */
    const column = (): HTMLElement[] =>
      [...box.querySelectorAll<HTMLElement>(rows)].filter(
        (el) => !(el as HTMLButtonElement).disabled,
      )

    /** The controls on one line, given anything inside it. */
    const across = (el: HTMLElement): HTMLElement[] => {
      if (cells === undefined || line === undefined) return [el]
      const own = el.closest(line)
      if (own === null) return [el]
      return [...own.querySelectorAll<HTMLElement>(cells)].filter(
        (cell) => !(cell as HTMLButtonElement).disabled,
      )
    }

    /** The column entry a control belongs to, whichever of its line it is. */
    const lineOf = (el: HTMLElement): HTMLElement => {
      if (line === undefined) return el
      return el.closest(line)?.querySelector<HTMLElement>(rows) ?? el
    }

    const keyed = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target === null || !box.contains(target)) return
      // A chord is somebody else's: Cmd+arrow walks the row, Shift+arrow
      // extends a selection.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      /*
       * A menu hung over the pane keeps its own keys. `useAnchoredMenu` draws
       * it `position: fixed` but *inside* the row it belongs to, so it is in
       * this box -- and walking the list underneath a menu somebody has open
       * would step off it and leave it hanging there.
       */
      if (target.closest('.menu') !== null) return
      // A caret owns every direction it can move in.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return
        if (target instanceof HTMLTextAreaElement) return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const all = column()
        if (all.length === 0) return
        const here = all.indexOf(lineOf(target))
        const step = event.key === 'ArrowDown' ? 1 : -1
        const to = here === -1 ? (step === 1 ? 0 : all.length - 1) : here + step
        if (to < 0 || to >= all.length) return
        const landing = all[to]
        if (landing === undefined) return
        event.preventDefault()
        /*
         * Keep the place in the line. Walking down a column of todos while
         * standing on DELETE should stay on DELETE, the way a spreadsheet keeps
         * its column -- a walk that dropped back to the first control every
         * line would make the second and third reachable only sideways.
         */
        const was = across(target).indexOf(target)
        const row = across(landing)
        ;(row[was] ?? landing).focus()
        return
      }

      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      /*
       * Taken whether or not there is anywhere to go, and that is the fix for a
       * real bug. A key this hook leaves alone gets the browser's default,
       * which for a sideways arrow is to scroll the nearest sideways scroller
       * -- and every pane is inside the row, which is one. So → on a line with
       * nothing to its right (a sleeping worktree has no ×; a todo's DELETE is
       * its last segment) slid the whole row a window along while the focus
       * stayed put: measured, `.grid` went 0 -> 397 with the keyboard still on
       * the sleeping `main`. The row moves on Cmd+arrow; a plain arrow inside a
       * list is about the list, and at its edge it is an edge.
       */
      event.preventDefault()
      const row = across(target)
      const here = row.indexOf(target)
      if (here === -1) return
      row[here + (event.key === 'ArrowRight' ? 1 : -1)]?.focus()
    }

    /*
     * Re-attached on every commit, which is why there is no dependency array.
     * The box this listens on is not always a stable node: the files panel
     * draws its list into a different element per mode, so an effect that only
     * re-ran when its options changed would go on listening to a detached div
     * the moment you switched from Changes to Commits. One listener added and
     * removed per render is nothing beside the render.
     */
    box.addEventListener('keydown', keyed)
    return () => box.removeEventListener('keydown', keyed)
  })
}
