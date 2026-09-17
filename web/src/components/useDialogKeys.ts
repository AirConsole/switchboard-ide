import { useEffect, type RefObject } from 'react'

/**
 * A dialog answers to the keyboard: arrows choose, Enter does, Escape leaves.
 *
 * Every dialog here asks one question with two or three answers in a row along
 * its foot, which is a toolbar -- so it is given a toolbar's keyboard. Left and
 * right move between the answers, Enter takes the one you are on, and `⏎` is
 * drawn on it so the key never has to be guessed at (see `.dialog__foot .btn`
 * in the stylesheet, where the mark is reserved at every width so moving along
 * the row does not move the row).
 *
 * **Focus is the selection**, rather than an index beside it. The buttons carry
 * a roving `tabIndex`, so the browser's own Enter, its focus ring and any
 * screen reader all agree with the mark without being told, and this hook only
 * has to move focus.
 *
 * **Which one starts focused is a rule about damage.** The last answer is the
 * one you came for -- `Sleep`, `Close project` -- so that is where Enter
 * begins. Unless it is irreversible: in a dialog whose affirmative is
 * `--danger` the way out takes the focus instead, and reaching the red one is a
 * deliberate arrow press. Escape and the scrim still mean the same thing they
 * did.
 *
 * A dialog that is mostly a form opts out with `focus: false`: its text field
 * wants the caret and its own Enter, and a hand that has just typed a path is
 * not aiming at a button.
 */
export const useDialogKeys = (
  dialog: RefObject<HTMLElement | null>,
  { focus = true }: { focus?: boolean } = {},
): void => {
  useEffect(() => {
    const box = dialog.current
    if (!box) return

    /** The answers, in the order they are drawn; disabled ones are not answers. */
    const answers = (): HTMLButtonElement[] =>
      [...box.querySelectorAll<HTMLButtonElement>('.dialog__foot .btn')].filter(
        (button) => !button.disabled,
      )

    const roving = (): void => {
      const all = answers()
      const here = all.findIndex((button) => button === document.activeElement)
      /*
       * The one the browser would reach with Tab is the one Enter is about to
       * take, so they must not be two different buttons. Re-applied on every
       * move, and on every render that changes the row -- a dialog's answers
       * come and go (the delete door appears only where deleting is possible).
       */
      for (const [at, button] of all.entries()) {
        button.tabIndex = at === (here === -1 ? start(all) : here) ? 0 : -1
      }
    }

    /** Where Enter starts: the last answer, or the way out where that is red. */
    const start = (all: HTMLButtonElement[]): number => {
      const last = all.length - 1
      if (last < 0) return 0
      const safe = all.map((b, at) => ({ b, at })).filter(({ b }) => !b.className.includes('--danger'))
      return all[last]?.className.includes('--danger') ? (safe.at(-1)?.at ?? last) : last
    }

    const all = answers()
    if (focus && all.length > 0) all[start(all)]?.focus()
    roving()

    const keys = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      /*
       * Only a field *in this dialog* keeps its keys. One behind the scrim --
       * a terminal, the editor -- is not where the keyboard is meant to be, and
       * the whole point of a modal is that it answers first.
       */
      const inside = target !== null && box.contains(target)
      const typing =
        inside &&
        (target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLInputElement && target.type !== 'checkbox'))

      const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      const on = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      if (back || on) {
        // A caret in a field owns the arrows; the answers are not where the
        // hand is.
        if (typing) return
        const row = answers()
        if (row.length === 0) return
        const here = row.findIndex((button) => button === document.activeElement)
        /*
         * Up and down as well as left and right, though the answers are drawn
         * in a row. The hand that reaches for an arrow in a dialog has not
         * looked at which way the buttons run, and the project pane's column
         * takes the same four keys from the other side -- one interface, four
         * keys, whichever way the thing in front of you happens to be laid out.
         */
        const step = on ? 1 : -1
        // Wrapping, because a row of two or three is a ring you feel your way
        // around rather than a line you can run off the end of.
        const to = here === -1 ? start(row) : (here + step + row.length) % row.length
        event.preventDefault()
        row[to]?.focus()
        roving()
        return
      }

      if (event.key !== 'Enter') return
      // A textarea's Enter is a newline and a button's is the browser's own --
      // neither is this hook's to take, when they are this dialog's.
      if (inside && event.target instanceof HTMLTextAreaElement) return
      if (inside && event.target instanceof HTMLButtonElement) return
      /*
       * Everything else -- the body, a checkbox, a dialog nobody has touched --
       * means the answer on screen. This is the half that makes "the dialog
       * listens to Enter" true rather than "the focused button does".
       */
      const row = answers()
      const here = row.find((button) => button === document.activeElement)
      const take = here ?? row[start(row)]
      if (take === undefined) return
      event.preventDefault()
      take.click()
    }

    /*
     * On the **window**, in the capture phase, exactly as `useEscape` is -- and
     * for the same reason. A dialog is modal, so its keys are the page's keys
     * while it is up; listening on the dialog's own box would only hear a
     * keyboard that was already inside it, and it often is not. The
     * open-project dialog never takes the caret at all (its field is the point
     * of it), so focus sits wherever it was -- measured, that is the terminal
     * behind the scrim -- and Enter would have gone to an agent rather than to
     * the question on screen.
     *
     * Capture, so a field or CodeMirror underneath cannot answer first, and the
     * handler only ever prevents what it actually takes.
     */
    window.addEventListener('keydown', keys, true)
    return () => window.removeEventListener('keydown', keys, true)
    // Re-run whenever the dialog's own contents change identity, which is what
    // `dialog.current` changing means; the answers are read live either way.
  }, [dialog, focus])
}
