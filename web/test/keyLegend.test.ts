import { describe, expect, it } from 'vitest'
import {
  LEGEND_LEARNED,
  isModHeld,
  landingHint,
  showsHere,
  showsHint,
} from '../src/views/keyLegend.js'

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

describe('showsHere', () => {
  /*
   * The line and the sentences are never on screen together. While the hints
   * are still teaching they are already unasked, one per neighbour and each
   * with a sentence beside it; a third mark added to that is one more thing to
   * read. The line starts exactly where the teaching stops -- so the two are
   * complements, not layers.
   */
  it('stays away for as long as the hints are teaching', () => {
    expect(showsHere({ steps: LEGEND_LEARNED - 1, held: true })).toBe(false)
    expect(showsHere({ steps: LEGEND_LEARNED, held: true })).toBe(true)
  })

  // Only while the key is down: with it up there is no step to be from.
  it('needs the key, not only the count', () => {
    expect(showsHere({ steps: LEGEND_LEARNED * 10, held: false })).toBe(false)
  })
})

describe('landingHint', () => {
  /** A row of stops: two worktrees, the first with a panel open beside Claude. */
  const stops = [
    { id: 'wt-1', kind: 'claude' as const },
    { id: 'wt-1', kind: 'todo' as const },
    { id: 'wt-2', kind: 'claude' as const },
  ]

  /*
   * The bug this records: the hint used to name only the window a step lands
   * in, and the window drew it at its own near edge. One of the two steps out
   * of a window with a panel open lands in that same window -- so the arrow
   * appeared at the tile's leading edge, under the Claude you had not left,
   * pointing at a pane on the other side of it.
   */
  it('names the pane a step lands in, not only its window', () => {
    expect(landingHint(stops, 0, 'wt-1')).toEqual({ dir: 'right', pane: 'todo' })
  })

  it('reaches the next window from the last pane of this one', () => {
    expect(landingHint(stops, 1, 'wt-2')).toEqual({ dir: 'right', pane: 'claude' })
    // ...and back into the pane you came from, which is Claude's own.
    expect(landingHint(stops, 1, 'wt-1')).toEqual({ dir: 'left', pane: 'claude' })
  })

  /*
   * Going left out of a window lands in the *last* pane of the one before it,
   * which is the pane against the edge you are coming from -- and, with a panel
   * open there, is not Claude. Drawn over Claude regardless, it sat at x=-40 on
   * a 1600px screen: the part of that window that has scrolled past.
   */
  it('lands in the last pane of the window on the left', () => {
    expect(landingHint(stops, 2, 'wt-1')).toEqual({ dir: 'left', pane: 'todo' })
  })

  it('draws nothing for a window neither step reaches, or from nowhere', () => {
    // Two windows away, so no step gets there and nothing is promised.
    expect(landingHint(stops, 0, 'wt-2')).toBeNull()
    /*
     * -1 is "the walk does not know where you are" -- no pane holds the
     * keyboard and nothing has been scrolled to. The row draws no arrows at
     * all then, rather than guessing at an end to count from.
     */
    expect(landingHint(stops, -1, 'wt-1')).toBeNull()
  })
})
