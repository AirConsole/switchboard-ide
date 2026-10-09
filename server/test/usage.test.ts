import { describe, expect, it } from 'vitest'
import { parseResetAt, parseUsage } from '../src/usage.js'

/** `/usage` as it actually prints, banner and prose included. */
const REPORT = `
Claude usage

Current session: 68% used · resets Sep 9, 4:50pm (UTC)
Current week (all models): 18% used · resets Sep 15, 9am (UTC)
Current week (Fable): 0% used · resets Sep 15, 9am (UTC)

96% of your usage came from subagent-heavy sessions.
`

describe('parseUsage', () => {
  it('reads every limit, in the order they were reported', () => {
    expect(parseUsage(REPORT).map((limit) => [limit.label, limit.percent])).toEqual([
      ['session', 68],
      ['week', 18],
      ['fable', 0],
    ])
  })

  it('keeps the reset clause as Claude worded it', () => {
    expect(parseUsage(REPORT)[0]?.resets).toBe('Sep 9, 4:50pm (UTC)')
  })

  it('ignores percentages in the prose around the limits', () => {
    // `% used` is what makes this safe to run over the whole report: the rest
    // of it is full of percentages and none of them is a limit.
    expect(parseUsage('96% of your usage came from subagent-heavy sessions.')).toEqual([])
  })

  it('keeps an unrecognised limit under its own name rather than dropping it', () => {
    expect(parseUsage('Current month (Opus): 4% used')[0]?.label).toBe('month (opus)')
  })

  it('survives a limit with no reset clause', () => {
    const [limit] = parseUsage('Current session: 5% used')
    expect(limit?.percent).toBe(5)
    expect(limit?.resets).toBeNull()
    expect(limit?.resetsAt).toBeNull()
  })

  it('clamps a nonsense percentage rather than drawing a bar off the end', () => {
    expect(parseUsage('Current session: 480% used')[0]?.percent).toBe(100)
  })

  it('stops at eight limits, so a misparse cannot fill the bar', () => {
    const many = Array.from({ length: 30 }, (_, n) => `Limit ${n}: 1% used`).join('\n')
    expect(parseUsage(many)).toHaveLength(8)
  })

  it('reads nothing out of the message a signed-out claude prints', () => {
    expect(parseUsage('Invalid API key · Please run /login')).toEqual([])
  })
})

describe('parseResetAt', () => {
  /** A fixed "now" so the year-guessing is deterministic. */
  const now = Date.UTC(2026, 8, 11, 12, 0) // 11 Sep 2026

  it('reads the shape /usage prints', () => {
    expect(parseResetAt('Sep 15, 9am (UTC)', now)).toBe(Date.UTC(2026, 8, 15, 9, 0))
    expect(parseResetAt('Sep 10, 5:29pm (UTC)', now)).toBe(Date.UTC(2026, 8, 10, 17, 29))
  })

  it('reads midnight and noon the way a clock face means them', () => {
    expect(parseResetAt('Sep 15, 12am (UTC)', now)).toBe(Date.UTC(2026, 8, 15, 0, 0))
    expect(parseResetAt('Sep 15, 12:30pm (UTC)', now)).toBe(Date.UTC(2026, 8, 15, 12, 30))
  })

  it('picks the year that puts the date nearest today', () => {
    // A reset in January read in December belongs to next year, not eleven
    // months ago.
    const december = Date.UTC(2026, 11, 20, 12, 0)
    expect(parseResetAt('Jan 3, 9am (UTC)', december)).toBe(Date.UTC(2027, 0, 3, 9, 0))
    const january = Date.UTC(2026, 0, 5, 12, 0)
    expect(parseResetAt('Dec 28, 9am (UTC)', january)).toBe(Date.UTC(2025, 11, 28, 9, 0))
  })

  it('refuses a day that does not exist rather than rolling into next month', () => {
    expect(parseResetAt('Feb 31, 9am (UTC)', now)).toBeNull()
    expect(parseResetAt('Sep 0, 9am (UTC)', now)).toBeNull()
    expect(parseResetAt('Sep 32, 9am (UTC)', now)).toBeNull()
  })

  it('refuses a month it does not know', () => {
    expect(parseResetAt('Smarch 4, 9am (UTC)', now)).toBeNull()
  })

  it('refuses a shape it does not recognise, leaving the caller the prose', () => {
    expect(parseResetAt('in about three hours', now)).toBeNull()
    expect(parseResetAt('2026-09-15T09:00:00Z', now)).toBeNull()
    expect(parseResetAt('', now)).toBeNull()
  })

  it('takes GMT and Z as UTC too', () => {
    const utc = Date.UTC(2026, 8, 15, 9, 0)
    expect(parseResetAt('Sep 15, 9am (GMT)', now)).toBe(utc)
    expect(parseResetAt('Sep 15, 9am (Z)', now)).toBe(utc)
  })

  it('reads a zone it does not know as local time', () => {
    /*
     * A report that names a zone at all names the reader's own, so being wrong
     * by the offset beats being wrong by a whole day.
     */
    expect(parseResetAt('Sep 15, 9am (PST)', now)).toBe(
      new Date(2026, 8, 15, 9, 0).getTime(),
    )
  })
})
