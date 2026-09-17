import { useEffect, useState } from 'react'
import type { Usage } from '@switchboard/shared'
import { api } from '../api.js'

/**
 * How often the browser asks for Claude's usage limits.
 *
 * The same five minutes the server caches for, so a poll that lands inside the
 * window is answered from the last reading rather than starting another
 * `claude -p /usage`. The client is what decides when a reading is taken and
 * the cache is what stops several tabs taking several -- which is also why a
 * hidden page does not ask at all, and asks once when it comes back rather
 * than on a timer nobody is watching.
 */
const USAGE_POLL_MS = 5 * 60 * 1000

export const useUsage = (): Usage | null => {
  const [usage, setUsage] = useState<Usage | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      if (document.hidden) return
      void api
        .usage()
        .then((next) => {
          if (live) setUsage(next)
        })
        // A failed read leaves the last numbers on screen; the server says so
        // itself when its own read failed, and this is only the transport.
        .catch(() => {})
    }
    read()
    const timer = window.setInterval(read, USAGE_POLL_MS)
    document.addEventListener('visibilitychange', read)
    return () => {
      live = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [])
  return usage
}

/**
 * Claude's usage limits, as bars.
 *
 * One row per limit `/usage` reported, in its order: the session, the week, and
 * the week for whichever model has its own allowance. Grey while there is
 * plenty, and then it says so in colour: see `usageLevel`.
 *
 * Every row says when it comes back, because that is the second half of the
 * question the first half raises: 90% spent matters very differently at four
 * minutes to the hour than at four days. It is a countdown and not a clock
 * time -- `5h`, `4d` -- for width, which is the reason it used to be tooltip
 * only: one short cell costs 24px where `Sep 15, 8:59am` would cost the bar
 * more room than the bars themselves. The exact moment stays in the tooltip,
 * in the reader's own zone rather than the report's.
 */
/**
 * How long until a limit comes back, in one cell.
 *
 * One unit, rounded, because this is a glance and not a stopwatch: hours until
 * a day is left, then days. Under a minute is `now` rather than `0m` -- the
 * reading is up to five minutes old, so a countdown that has just run out is
 * telling you it has already happened.
 */
const untilText = (at: number, now: number): string => {
  const ms = at - now
  if (ms < 60_000) return 'now'
  const minutes = ms / 60_000
  if (minutes < 60) return `${Math.floor(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

/** The exact moment, in the reader's zone: `Tue 08:59`, or `17:29` for today. */
const resetText = (at: number, now: number): string => {
  const when = new Date(at)
  const sameDay = when.toDateString() === new Date(now).toDateString()
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/**
 * Plenty, running out, nearly gone.
 *
 * **From 75% it is amber and from 90% it is red**, which are the two numbers a
 * reader of this bar actually acts on: three quarters spent is when it starts
 * to matter what the rest goes on, and nine tenths is when the next long
 * session is the one that ends early.
 *
 * This is the one thing in the chrome that wears amber without being an agent
 * that wants you, and it is a considered exception rather than a lapse. What
 * amber means here is the same verb -- something needs you to act -- about the
 * account rather than about one worktree, and the reading it sits in is three
 * 54px tracks in the corner of the top bar, nowhere near the row of windows the
 * colour rule is written to protect. Red is new to the chrome as a state, and
 * is `--danger`, which already means "this one is different, look before you
 * act".
 *
 * Inclusive: 75 is amber and 90 is red. The threshold is the number you say out
 * loud -- "I am at seventy-five per cent" -- and a bar that waited for 76 would
 * be a bar that disagreed with the number printed beside it.
 *
 * It replaces a step up the grey ladder at 80% -- the fill went `--bone` -- and
 * that step was the wrong instrument twice over. It arrived after the number
 * that matters, and "slightly brighter grey" is not a thing you can see without
 * the other two bars beside it to compare against.
 */
export const usageLevel = (percent: number): 'plenty' | 'low' | 'spent' =>
  percent >= 90 ? 'spent' : percent >= 75 ? 'low' : 'plenty'

export const UsageBars = ({ usage }: { usage: Usage }): React.ReactElement | null => {
  /*
   * A countdown that does not count is a small lie, and the reading itself is
   * only taken every five minutes -- so `12m` would sit there for five of them
   * and then jump to `6m`. One tick a minute is what the smallest unit shown
   * needs; nothing here is per-second. Before the early return, because a hook
   * cannot be conditional.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  if (usage.limits.length === 0) return null
  const resetsOf = (limit: Usage['limits'][number]): string => {
    if (limit.resetsAt !== null) {
      const until = untilText(limit.resetsAt, now)
      // "in now" is not a sentence; a limit that is due says so on its own.
      const left = until === 'now' ? '(now)' : `(in ${until})`
      return ` · resets ${resetText(limit.resetsAt, now)} ${left}`
    }
    // The prose did not parse, so it is repeated as it came.
    return limit.resets === null ? '' : ` · resets ${limit.resets}`
  }
  const title = [
    ...usage.limits.map((limit) => `${limit.label}: ${limit.percent}% used${resetsOf(limit)}`),
    usage.error === undefined
      ? `read ${new Date(usage.fetchedAt).toLocaleTimeString()}`
      : `last read ${new Date(usage.fetchedAt).toLocaleTimeString()} — ${usage.error}`,
  ].join('\n')
  return (
    <div
      className={usage.error === undefined ? 'usage' : 'usage usage--stale'}
      title={title}
      aria-label="Claude usage limits"
    >
      {usage.limits.map((limit) => (
        /*
         * The level goes on the row rather than on the fill, because the number
         * wears it too: the bar itself is the first thing the top bar gives up
         * as it runs out of room (rung 1), and a colour that lived only on the
         * track would go out exactly when the window is too small to show it.
         */
        <div className={`usage__row usage__row--${usageLevel(limit.percent)}`} key={limit.label}>
          <span className="usage__label">{limit.label}</span>
          <span className="usage__track">
            <i className="usage__fill" style={{ width: `${limit.percent}%` }} />
          </span>
          <span className="usage__percent">{limit.percent}%</span>
          <span className="usage__resets">
            {limit.resetsAt === null ? '' : untilText(limit.resetsAt, now)}
          </span>
        </div>
      ))}
    </div>
  )
}

