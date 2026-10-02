import { describe, expect, it } from 'vitest'
import { shownLimits, usageLevel } from '../src/components/UsageBars.js'

describe('usageLevel', () => {
  /*
   * Inclusive, and that is the whole of what this test is for: the threshold is
   * the number you say out loud -- "I am at seventy-five per cent" -- so a bar
   * that waited for 76 would disagree with the number printed beside it.
   */
  it('turns at 75 and at 90, not one per cent later', () => {
    expect(usageLevel(74)).toBe('plenty')
    expect(usageLevel(75)).toBe('low')
    expect(usageLevel(89)).toBe('low')
    expect(usageLevel(90)).toBe('spent')
  })

  it('is plenty at rest and spent at the end', () => {
    expect(usageLevel(0)).toBe('plenty')
    expect(usageLevel(100)).toBe('spent')
  })
})

describe('shownLimits', () => {
  const at = (session: number, week: number, fable: number) =>
    shownLimits([
      { label: 'session', percent: session, resets: null, resetsAt: null },
      { label: 'week', percent: week, resets: null, resetsAt: null },
      { label: 'fable', percent: fable, resets: null, resetsAt: null },
    ]).map((limit) => limit.label)

  it('shows the two most used, in the order /usage reported them', () => {
    expect(at(30, 55, 0)).toEqual(['session', 'week'])
    expect(at(30, 55, 40)).toEqual(['week', 'fable'])
    expect(at(60, 20, 40)).toEqual(['session', 'fable'])
  })

  it('gives a tie to the limit reported first, so fable never wins one', () => {
    // Fable at 0% beside another 0% is the ordinary case on a fresh week.
    expect(at(0, 10, 0)).toEqual(['session', 'week'])
    expect(at(0, 0, 0)).toEqual(['session', 'week'])
    expect(at(10, 40, 10)).toEqual(['session', 'week'])
  })

  it('leaves a shorter report alone', () => {
    expect(shownLimits([{ label: 'session', percent: 5, resets: null, resetsAt: null }])).toHaveLength(1)
  })
})
