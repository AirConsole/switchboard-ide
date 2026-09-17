import { useEffect, type RefObject } from 'react'

/**
 * A pane that is a list answers to the arrows: up and down walk it, Enter takes
 * what you are on.
 *
 * The vertical sibling of `useDialogKeys` -- which takes all four arrows too,
 * so a hand that reaches for one does not have to have looked at which way the
 * thing in front of it runs. The rules are the same ones said about a column
 * instead of a row: focus *is* the selection, Enter is the
 * browser's own on a real button, and `⏎` is drawn on what it would take. What
 * differs is the axis and the reach -- a dialog is modal and listens at the
 * window, while this is one pane among several, so it listens on its own box
 * and means nothing while the keyboard is somewhere else.
 *
 * It exists because Tab could not do this job here. The project pane's lists
 * come *before* its form in the markup -- the worktrees you might jump to, then
 * the field for a new one -- and arriving puts the caret in the field, which is
 * the right place to arrive. Tabbing forward from there reaches `Close project`
 * and then leaves the pane entirely: measured, the next stop was the following
 * window's TERMINAL. Everything this pane is *for* was behind Shift+Tab, which
 * is not where anybody looks.
 *
 * **Left and right reach the second control on a line.** A worktree's row is
 * its name and the × that puts it away, which is the same shape the tabs in the
 * top bar have; up and down move between worktrees, left and right between the
 * two things you can do to one.
 */
export const useListKeys = (pane: RefObject<HTMLElement | null>): void => {
  useEffect(() => {
    const box = pane.current
    if (!box) return

    /*
     * The column, in the order it is drawn: every worktree, then the field, the
     * button beside it, and the way out. Read live, because a pane's list is
     * whatever the project has awake right now.
     */
    const column = (): HTMLElement[] =>
      [
        ...box.querySelectorAll<HTMLElement>(
          '.projpane__list .tab__body, .projpane__foot .field__input, .projpane__foot .btn, .projpane__close',
        ),
      ].filter((el) => !(el as HTMLButtonElement).disabled)

    /** The × beside a row, where the row has one. */
    const beside = (el: HTMLElement): HTMLElement | null =>
      el.closest('.tab')?.querySelector<HTMLElement>('.tab__close') ?? null

    const keys = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target === null || !box.contains(target)) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const all = column()
        if (all.length === 0) return
        /*
         * From the × back to its own row first, so a column walked through the
         * second control does not skip the line it belongs to.
         */
        const from = target.closest('.tab')?.querySelector<HTMLElement>('.tab__body') ?? target
        const here = all.indexOf(from)
        const step = event.key === 'ArrowDown' ? 1 : -1
        const to = here === -1 ? (step === 1 ? 0 : all.length - 1) : here + step
        // No wrapping: a column has a top and a bottom, and running off either
        // end of a *list* should feel like an end rather than a loop.
        if (to < 0 || to >= all.length) return
        event.preventDefault()
        all[to]?.focus()
        return
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // The caret owns the horizontal in a field.
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
        const away = beside(target)
        if (event.key === 'ArrowRight' && away !== null && target !== away) {
          event.preventDefault()
          away.focus()
          return
        }
        if (event.key === 'ArrowLeft' && target === away) {
          const body = target.closest('.tab')?.querySelector<HTMLElement>('.tab__body')
          if (body) {
            event.preventDefault()
            body.focus()
          }
        }
      }
    }

    box.addEventListener('keydown', keys)
    return () => box.removeEventListener('keydown', keys)
  }, [pane])
}
