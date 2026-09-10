import { useEffect, useRef } from 'react'

/**
 * Escape cancels a dialog.
 *
 * Every dialog here is modal and every one of them has a way out that changes
 * nothing -- so the key that means "never mind" should reach it, from wherever
 * the caret happens to be inside it.
 *
 * In the **capture** phase, and it stops the event there, for the same reason
 * the Cmd+arrow stepper does: a text field and CodeMirror both handle Escape at
 * the target, and the row's own listeners sit on the document. Capturing at the
 * window is above all of them, so cancelling a dialog cannot also abandon an
 * edit in the pane behind it.
 *
 * The handler is read from a ref, so a dialog passing an inline arrow -- all of
 * them do -- does not re-subscribe on every render.
 */
export const useEscape = (onEscape: () => void): void => {
  const handler = useRef(onEscape)
  handler.current = onEscape
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      handler.current()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
}
