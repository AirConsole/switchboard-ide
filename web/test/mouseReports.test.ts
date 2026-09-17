import { describe, expect, it } from 'vitest'
import { isHoverReport } from '../src/terminal/mouseReports.js'

/*
 * The hover filter replaced a capture-phase listener that hid every bare
 * mousemove from xterm, which also hid it from xterm's link detection: in a
 * pane that reports the mouse -- every Claude -- no link could be clicked. So
 * the move now reaches xterm and only its report is dropped, and what this
 * decides is exactly which reports those are. The codes are xterm's own
 * `eventCode` (CoreMouseService): 32 move, low bits the button (3 none), 64 the
 * wheel, 4/8/16 Shift/Alt/Ctrl.
 */
describe('isHoverReport', () => {
  it('drops a move with no button, whatever modifiers are held', () => {
    expect(isHoverReport('\x1b[<35;12;5M')).toBe(true)
    expect(isHoverReport('\x1b[<39;12;5M')).toBe(true) // shift
    expect(isHoverReport('\x1b[<43;12;5M')).toBe(true) // alt
    expect(isHoverReport('\x1b[<51;12;5M')).toBe(true) // ctrl
    expect(isHoverReport('\x1b[<35;1200;480M')).toBe(true) // SGR_PIXELS
  })

  it('keeps a drag, because it carries a button', () => {
    // Measured before: a drag went out as ESC[<32;38;19M.
    expect(isHoverReport('\x1b[<32;38;19M')).toBe(false)
    expect(isHoverReport('\x1b[<33;38;19M')).toBe(false)
    expect(isHoverReport('\x1b[<34;38;19M')).toBe(false)
  })

  it('keeps a click and its release', () => {
    // Measured before: a click at column 110 went out as ESC[<0;110;25M / m.
    expect(isHoverReport('\x1b[<0;110;25M')).toBe(false)
    expect(isHoverReport('\x1b[<0;110;25m')).toBe(false)
    expect(isHoverReport('\x1b[<2;4;4M')).toBe(false)
  })

  it('keeps the wheel, which is how Claude scrolls its transcript', () => {
    expect(isHoverReport('\x1b[<64;10;10M')).toBe(false)
    expect(isHoverReport('\x1b[<65;10;10M')).toBe(false)
    expect(isHoverReport('\x1b[<67;10;10M')).toBe(false)
  })

  it('leaves everything that is not an SGR mouse report alone', () => {
    expect(isHoverReport('35;12;5M')).toBe(false)
    expect(isHoverReport('hello')).toBe(false)
    expect(isHoverReport('\x1b[A')).toBe(false)
    // Two reports in one write are not a hover report; xterm sends one a time.
    expect(isHoverReport('\x1b[<35;1;1M\x1b[<35;2;1M')).toBe(false)
  })
})
