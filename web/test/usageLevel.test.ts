import { describe, expect, it } from 'vitest'
import { usageLevel } from '../src/components/UsageBars.js'

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
