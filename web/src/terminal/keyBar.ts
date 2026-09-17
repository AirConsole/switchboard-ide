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
  { applicationCursorKeys, ctrl }: Held,
): string => {
  const final = { up: 'A', down: 'B', right: 'C', left: 'D' }[dir]
  /*
   * Held with Ctrl it is neither form: a modified cursor key is always the
   * parameterised CSI one, `CSI 1 ; m A`, whatever DECCKM says -- there is no
   * room in `SS3 A` for a modifier. `m` is 1 plus the modifier bits, so Ctrl
   * alone is 5. That is the sequence a shell reads as word-left and word-right,
   * which is the whole reason to want it on a phone.
   */
  if (ctrl) return `\x1b[1;5${final}`
  return applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`
}

/** What is held while a key on the bar is tapped. */
export interface Held {
  /** The app asked for the application cursor-key form (DECCKM). */
  applicationCursorKeys: boolean
  /** The bar's Ctrl is latched. */
  ctrl: boolean
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
  /** The bytes, given the app's cursor-key mode and whether Ctrl is latched. */
  bytes: (held: Held) => string
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
  /*
   * Escape ignores Ctrl, because Ctrl+[ *is* Escape -- the two produce the same
   * byte, so there is nothing for the latch to change.
   */
  { label: 'esc', name: 'Escape', bytes: () => '\x1b' },
  /*
   * Ctrl+Tab has no byte of its own in the old encoding, so it goes as the
   * extended form `CSI 9 ; 5 u` -- the same shape this view already sends for
   * Shift+Enter and Ctrl+Enter, and deliverable because `tmux.conf` sets
   * `extended-keys on`. An app that does not understand it ignores it, which is
   * the same as the plain Tab it would otherwise have been given wrongly.
   */
  { label: '⇥', name: 'Tab', bytes: ({ ctrl }) => (ctrl ? '\x1b[9;5u' : '\t') },
  { label: '←', name: 'Left', bytes: (held) => arrowBytes('left', held) },
  { label: '↑', name: 'Up', bytes: (held) => arrowBytes('up', held) },
  { label: '↓', name: 'Down', bytes: (held) => arrowBytes('down', held) },
  { label: '→', name: 'Right', bytes: (held) => arrowBytes('right', held) },
]
