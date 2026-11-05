import { describe, expect, it } from 'vitest'
import type { UsageLimit } from '@switchboard/shared'
import { usageLevel, usagePace } from '../src/components/UsageRings.js'

const HOUR = 60 * 60 * 1000
const AT = Date.UTC(2026, 10, 5, 12)

/** A limit read at `AT`, with `left` of its window still to go. */
const limit = (label: string, percent: number, left: number | null): UsageLimit => ({
  label,
  percent,
  resets: null,
  resetsAt: left === null ? null : AT + left,
})

describe('usageLevel', () => {
  /*
   * The case that asked for this: three quarters of a session gone. 60% ends
   * the session at 80 and is fine; 80% runs out before the reset. By
   * percentage alone the first was plenty and the second amber only by the
   * accident of being past 75.
   */
  it('reads a session by where it is heading, not where it is', () => {
    expect(usageLevel(limit('session', 60, 1.25 * HOUR), AT)).toBe('plenty')
    expect(usageLevel(limit('session', 80, 1.25 * HOUR), AT)).toBe('low')
    expect(usageLevel(limit('session', 95, 1.25 * HOUR), AT)).toBe('spent')
  })

  it('lets a high reading near its reset stay grey, and a low one early go amber', () => {
    // 85% with a day of the week left ends at 99.
    expect(usageLevel(limit('week', 85, 24 * HOUR), AT)).toBe('plenty')
    // 40% two days in ends at 140.
    expect(usageLevel(limit('fable', 40, 5 * 24 * HOUR), AT)).toBe('spent')
  })

  it('turns past 100 and at 120, the pace you would say out loud', () => {
    // Half the session gone: the pace is twice the percentage.
    expect(usageLevel(limit('session', 50, 2.5 * HOUR), AT)).toBe('plenty')
    expect(usageLevel(limit('session', 51, 2.5 * HOUR), AT)).toBe('low')
    expect(usageLevel(limit('session', 59, 2.5 * HOUR), AT)).toBe('low')
    expect(usageLevel(limit('session', 60, 2.5 * HOUR), AT)).toBe('spent')
  })

  it('does not project from the first tenth of a window', () => {
    // Four per cent ten minutes in would be 120% as a straight projection.
    expect(usagePace(limit('session', 4, 5 * HOUR - HOUR / 6), AT)).toBe(40)
    expect(usageLevel(limit('session', 4, 5 * HOUR - HOUR / 6), AT)).toBe('plenty')
  })

  it('is spent at 100 whatever the pace', () => {
    expect(usageLevel(limit('session', 100, HOUR), AT)).toBe('spent')
  })

  it('falls back to the percentage when the window cannot be known', () => {
    // No reset, and a reset further off than a session can be.
    expect(usagePace(limit('session', 80, null), AT)).toBeNull()
    expect(usagePace(limit('session', 80, 6 * HOUR), AT)).toBeNull()
    expect(usageLevel(limit('session', 74, null), AT)).toBe('plenty')
    expect(usageLevel(limit('session', 75, null), AT)).toBe('low')
    expect(usageLevel(limit('session', 90, 6 * HOUR), AT)).toBe('spent')
  })
})
