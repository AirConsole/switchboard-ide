import { describe, expect, it } from 'vitest'
import { LEGEND_LEARNED, isModHeld, showsHint } from '../src/views/keyLegend.js'

/** A keydown as the two row handlers read it. */
const key = (over: Partial<KeyboardEvent> = {}): Pick<
  KeyboardEvent,
  'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
> => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })

describe('isModHeld', () => {
  it('takes Cmd on a Mac and Alt everywhere else', () => {
    expect(isModHeld(key({ metaKey: true }), true)).toBe(true)
    expect(isModHeld(key({ altKey: true }), false)).toBe(true)
  })

  /*
   * The half that is easy to get wrong, because `metaKey || altKey` passes
   * every test above. Option on a Mac is a typing modifier -- Option+I is a
   * dead key for a circumflex -- so a Mac holding it is composing a character,
   * and the row must not take the key out of the pane it is being typed into.
   * Off the Mac, Meta is the Super key, which the window manager has already
   * taken: Super+Left tiles the window rather than stepping the row.
   */
  it('does not take the other platform’s key', () => {
    expect(isModHeld(key({ altKey: true }), true)).toBe(false)
    expect(isModHeld(key({ metaKey: true }), false)).toBe(false)
  })

  /*
   * Nothing else may be held with it. Cmd+Shift+Left is a selection in every
   * text field in the interface, and these handlers cancel the key outright in
   * the capture phase -- so a guard that ignored the other modifiers would take
   * "extend the selection to the start of the line" away from the todo prompt
   * and the editor.
   */
  it('refuses the chorded forms of itself', () => {
    expect(isModHeld(key({ metaKey: true, shiftKey: true }), true)).toBe(false)
    expect(isModHeld(key({ metaKey: true, ctrlKey: true }), true)).toBe(false)
    expect(isModHeld(key({ altKey: true, shiftKey: true }), false)).toBe(false)
    expect(isModHeld(key({ altKey: true, ctrlKey: true }), false)).toBe(false)
  })
})

describe('showsHint', () => {
  /*
   * The threshold is the whole feature: the hint teaches itself to somebody who
   * does not know the key exists, and then gets out of the way. An off-by-one
   * here is a legend that never stops, or one that stops a step early.
   */
  it('shows unasked until the walk has been used LEGEND_LEARNED times', () => {
    expect(showsHint({ steps: LEGEND_LEARNED - 1, held: false, narrow: false })).toBe(true)
    expect(showsHint({ steps: LEGEND_LEARNED, held: false, narrow: false })).toBe(false)
  })

  it('still answers the key once the walk is learned', () => {
    expect(showsHint({ steps: LEGEND_LEARNED * 100, held: true, narrow: false })).toBe(true)
  })

  /*
   * A phone has no modifier key to teach, and its row is one window per screen
   * -- the two windows the arrows point at are not even on it. Held wins over
   * everything except this, which is why `narrow` is the outer term.
   */
  it('never shows on a phone, held or not', () => {
    expect(showsHint({ steps: 0, held: false, narrow: true })).toBe(false)
    expect(showsHint({ steps: 0, held: true, narrow: true })).toBe(false)
  })
})
