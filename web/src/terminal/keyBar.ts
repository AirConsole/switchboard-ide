/**
 * The keys a phone's keyboard does not have, as the bytes a terminal expects.
 *
 * A soft keyboard has letters, digits and Enter. It has no arrows, no Tab and
 * no Ctrl -- and those are not conveniences here: Claude's menus are walked
 * with the arrows, its dialogs answered with Escape, a shell completes with Tab
 * and everything is interrupted with Ctrl+C. Without them a phone can watch an
 * agent and not answer it.
 *
 * Pure, and tested, because every one of these is a byte sequence that is
 * either exactly right or silently wrong: the arrows in particular have two
 * forms, and which one to send is the *app's* choice, not ours.
 */

/**
 * Arrow keys have two encodings, and an app says which it wants.
 *
 * DECCKM (`CSI ? 1 h`) switches the cursor keys from the normal form,
 * `CSI A`, to the application form, `SS3 A`. Every full-screen app here turns
 * it on -- tmux does, and so do Claude's TUI and vim under it -- and one that
 * asked for the application form does not recognise the normal one: measured,
 * `ESC [ A` typed into Claude's prompt does nothing at all where `ESC O A`
 * walks its menu. xterm.js tracks it as `applicationCursorKeysMode`, which is
 * what the caller passes in here.
 */
export const arrowBytes = (
  dir: 'up' | 'down' | 'right' | 'left',
  applicationCursorKeys: boolean,
): string => {
  const final = { up: 'A', down: 'B', right: 'C', left: 'D' }[dir]
  return applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`
}

/**
 * A letter held with Ctrl, as the byte the terminal would receive.
 *
 * Ctrl clears the two high bits of the character: `a` (0x61) becomes 0x01 and
 * `c` becomes 0x03, which is the interrupt. Case does not matter, because the
 * keyboard's Shift does not reach a control character. Null for anything that
 * is not a letter -- the handful of Ctrl chords on punctuation (`Ctrl+[` is
 * Escape, `Ctrl+\` quits) are typed by Escape and the row's own keys rather
 * than invented here.
 */
export const ctrlByte = (key: string): string | null => {
  if (key.length !== 1) return null
  const code = key.toLowerCase().charCodeAt(0)
  if (code < 97 || code > 122) return null
  return String.fromCharCode(code - 96)
}

/** One key on the bar: what it says, and what it sends. */
export interface BarKey {
  /** What is drawn on it. */
  label: string
  /** What it is called, for anything that reads the interface aloud. */
  name: string
  /** The bytes, given the app's cursor-key mode. */
  bytes: (applicationCursorKeys: boolean) => string
}

/**
 * The row, in the order it is drawn.
 *
 * Escape and Tab at the leading edge, where the thumb of a hand holding the
 * phone lands, and the arrows as a cluster after them -- they are used together
 * and read as one control. Ctrl is not here: it is not a key that sends
 * anything, it is a modifier the next key is held with, so the bar draws it
 * separately and it latches (see `TerminalKeyBar`).
 */
export const BAR_KEYS: readonly BarKey[] = [
  { label: 'esc', name: 'Escape', bytes: () => '\x1b' },
  { label: '⇥', name: 'Tab', bytes: () => '\t' },
  { label: '←', name: 'Left', bytes: (app) => arrowBytes('left', app) },
  { label: '↑', name: 'Up', bytes: (app) => arrowBytes('up', app) },
  { label: '↓', name: 'Down', bytes: (app) => arrowBytes('down', app) },
  { label: '→', name: 'Right', bytes: (app) => arrowBytes('right', app) },
]
