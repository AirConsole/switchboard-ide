import { describe, expect, it, vi } from 'vitest'
import type { UsageLimit } from '@switchboard/shared'
import { usageLevel, usagePace, workedMs } from '../src/components/UsageRings.js'

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

describe('the weekly pace over the days you work', () => {
  const WEEKDAYS = [1, 2, 3, 4, 5]
  // A week that resets the Monday after next at 09:00 local, read at `at`.
  const reset = new Date(2026, 10, 16, 9).getTime()
  const week = (percent: number, at: Date): [UsageLimit, number] => [
    { label: 'week', percent, resets: null, resetsAt: reset },
    at.getTime(),
  ]

  /*
   * Friday 22:00, 60% spent by someone who does not work weekends. By the
   * clock 109 of 168 hours have gone and 60% is on course for 92; but the
   * weekend will spend nothing, and 109 of the week's 120 working hours are
   * gone (Monday from 09:00, Tuesday to Friday, Monday to 09:00).
   */
  it('reads a weekend off as no time passing', () => {
    const [friday, at] = week(60, new Date(2026, 10, 13, 22))
    expect(Math.round(usagePace(friday, at, WEEKDAYS) ?? 0)).toBe(66)
    // And the clock stops at midnight: Sunday night is where Saturday morning was.
    const [saturday, early] = week(60, new Date(2026, 10, 14, 8))
    const [sunday, late] = week(60, new Date(2026, 10, 15, 22))
    expect(usagePace(sunday, late, WEEKDAYS)).toBe(usagePace(saturday, early, WEEKDAYS))
    expect(usagePace(saturday, early, WEEKDAYS)).toBeCloseTo(60 / (111 / 120))
  })

  // The case that asked for this: amber at the end of the working week.
  it('lets a week that is on course for Friday stay grey', () => {
    const [limit, at] = week(75, new Date(2026, 10, 13, 22))
    expect(usageLevel(limit, at)).toBe('low')
    expect(usageLevel(limit, at, WEEKDAYS)).toBe('plenty')
  })

  it('leaves the session and an every-day week alone', () => {
    const [limit, at] = week(50, new Date(2026, 10, 11, 9))
    expect(usagePace(limit, at, [0, 1, 2, 3, 4, 5, 6])).toBe(usagePace(limit, at))
    const session: UsageLimit = { label: 'session', percent: 50, resets: null, resetsAt: at + 2.5 * HOUR }
    expect(usagePace(session, at, WEEKDAYS)).toBe(100)
  })

  /*
   * In a zone that has a clock change: this machine and CI run in UTC, where
   * every day is 24 hours and walking in 24-hour steps would pass. Zurich
   * goes to summer time on Sunday 29 March 2026, a day of 23 hours -- and a
   * walk in 24-hour steps counts it as 24, running an hour into Monday.
   */
  it('counts a day by the calendar, not by 24 hours, across a clock change', () => {
    vi.stubEnv('TZ', 'Europe/Zurich')
    try {
      const sundays = workedMs(new Date(2026, 2, 23).getTime(), new Date(2026, 3, 1).getTime(), [0])
      expect(sundays).toBe(23 * HOUR)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
