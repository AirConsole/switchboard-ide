/**
 * The modifier the row's shortcuts are held with, and when the legend for them
 * is on screen.
 *
 * Its own module, and pure, because this is the part of the legend that can be
 * decided rather than looked at: which key this platform uses, what it is
 * called, and whether the hint has anything left to teach. The rest -- where
 * the glyph sits and what colour it is -- is measured in a browser.
 */

/**
 * Is this a Mac?
 *
 * Read once: nothing turns a Mac into a PC while the page is open.
 *
 * `userAgentData` first because `navigator.platform` is deprecated and frozen
 * -- it still answers, and answers correctly, but it is the one the spec has
 * given up on. Neither is offered by every browser, hence both, and an empty
 * string is not a Mac: a platform we cannot read gets the binding that does not
 * need a Command key.
 */
interface UserAgentData {
  platform?: string
}

export const IS_MAC = /mac|iphone|ipad/i.test(
  (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData?.platform ??
    navigator.platform ??
    '',
)

/**
 * What the key is called where the hint says it.
 *
 * The glyph on a Mac, because that is what is printed on the key and it is one
 * character wide; the word elsewhere, because ⎇ is printed on almost no
 * keyboard and nobody would read it as Alt.
 */
export const MOD_LABEL = IS_MAC ? '⌘' : 'Alt'

/**
 * Cmd on a Mac, Alt everywhere else, and nothing else held with it.
 *
 * **Never Ctrl**, and that is not a preference -- see PANEL_KEYS in
 * Overview.tsx. Ctrl+I *is* Tab, the same byte, so binding it would take
 * completion away from every shell in the row; Ctrl+F is forward-character and
 * Ctrl+Left and Ctrl+Right are word movement, which readline gives every prompt
 * on the machine.
 *
 * So the question off the Mac is which modifier the terminal does not already
 * own, and Alt is the only one left standing:
 *
 * - **Super** is the same `metaKey` this already reads, which would have cost
 *   nothing to support -- but the window manager takes it first. Super+Left and
 *   Super+Right tile the window on GNOME and snap it on Windows, and the page
 *   never sees the key.
 * - **Ctrl+Shift** is what terminal emulators themselves use, for exactly the
 *   reason above, so it is genuinely free of the shell. Ctrl+Shift+I is
 *   Chrome's DevTools, which no `preventDefault` reaches, so the terminals
 *   panel would need a different letter off the Mac -- a legend that says two
 *   different things on two platforms -- and it is a two-hand chord for a hint
 *   you hold a key to read.
 * - **Alt** costs the terminal Alt+F, which is readline's forward-word, and
 *   nothing else: Alt+Left and Alt+Right have no binding in a shell, and the
 *   browser's own back and forward on them is a page default, which this
 *   cancels the way the Mac build already cancels Cmd+Left.
 *
 * `altKey` is deliberately *not* accepted on a Mac. Option there is a typing
 * modifier -- Option+I is a dead key for a circumflex -- so a Mac holding it is
 * composing a character, not asking for the row.
 */
export const isModHeld = (
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean = IS_MAC,
): boolean =>
  isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey

/**
 * How many steps it takes to have learned the walk.
 *
 * Ten, which is a handful of sessions rather than a handful of minutes: the
 * hint is two glyphs in a corner, so the cost of showing it once too often is
 * far below the cost of a shortcut nobody ever finds.
 */
export const LEGEND_LEARNED = 10

/**
 * Whether the arrow hint is on screen.
 *
 * Held always shows it -- that is the legend doing its original job, answering
 * "what can I do from here" for somebody who already knows to ask. Below the
 * threshold it shows anyway, unasked, because the question cannot occur to
 * somebody who does not know there is an answer.
 *
 * Never on a phone. There is no modifier key there to teach, and the row is one
 * window per screen, so the two windows the hint would point at are not even on
 * it.
 */
export const showsHint = ({
  steps,
  held,
  narrow,
}: {
  steps: number
  held: boolean
  narrow: boolean
}): boolean => !narrow && (held || steps < LEGEND_LEARNED)
