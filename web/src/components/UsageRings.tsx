import { useEffect, useState } from 'react'
import type { Usage } from '@switchboard/shared'
import { api } from '../api.js'
import { useAnchoredMenu } from './useAnchoredMenu.js'

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

/*
 * The rings' geometry, in the SVG's own units: a 28px square, three 3px
 * strokes with a 1px gap between them, so the innermost keeps a 6px hole and
 * reads as a ring rather than a dot. At 26 it had a 4px hole, and at one
 * device pixel to the CSS pixel the inner ring rendered as a disc.
 */
const RING_SIZE = 28
const RING_STROKE = 3
const RING_RADII = [12.5, 8.5, 4.5]

/**
 * Claude's usage limits, as rings inside each other.
 *
 * The shape Claude's own web app uses for a limit -- an outline that fills
 * clockwise from twelve o'clock -- nested, one per limit in the order `/usage`
 * reports them: the session outside, the week, and the model with its own
 * allowance (Fable) in the middle. Outermost first because it is the one that
 * moves within a day, and the longest stroke is the easiest to read a change
 * in.
 *
 * It replaced three rows of bars, 189px of the top bar with a label, a track,
 * a percentage and a countdown each. That was the whole reading always on
 * screen and it was the bar's widest thing, so the ladder spent three of its
 * seven rungs narrowing it. A ring says what a glance needs -- how full, and
 * in colour when it matters (see `usageLevel`) -- in 28px at every width, and
 * a click hangs the whole reading under it, where it has the room to say when
 * each limit comes back as a time and not only a countdown.
 */
export const UsageRings = ({ usage }: { usage: Usage }): React.ReactElement | null => {
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
  const pop = useAnchoredMenu<HTMLButtonElement>()
  if (usage.limits.length === 0) return null
  const resetsOf = (limit: Usage['limits'][number]): string => {
    if (limit.resetsAt !== null) {
      const until = untilText(limit.resetsAt, now)
      // "in now" is not a sentence; a limit that is due says so on its own.
      const left = until === 'now' ? '(now)' : `(in ${until})`
      return `resets ${resetText(limit.resetsAt, now)} ${left}`
    }
    // The prose did not parse, so it is repeated as it came.
    return limit.resets === null ? '' : `resets ${limit.resets}`
  }
  const read =
    usage.error === undefined
      ? `read ${new Date(usage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : `last read ${new Date(usage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${usage.error}`
  const summary = usage.limits.map((limit) => `${limit.label} ${limit.percent}%`).join(', ')
  const stale = usage.error === undefined ? '' : ' usage--stale'
  const center = RING_SIZE / 2
  return (
    <>
      <button
        type="button"
        ref={pop.anchor}
        className={`usage${stale}${pop.at === null ? '' : ' usage--open'}`}
        // The numbers without a click, for a pointer that rests on it.
        title={summary}
        aria-label={`Claude usage: ${summary}`}
        aria-expanded={pop.at !== null}
        onClick={pop.toggle}
      >
        <svg
          className="usage__rings"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          aria-hidden="true"
        >
          {/* A fourth limit, should `/usage` ever report one, is in the panel. */}
          {usage.limits.slice(0, RING_RADII.length).map((limit, index) => (
            <g className={`usage__ring usage__ring--${usageLevel(limit.percent)}`} key={limit.label}>
              <circle className="usage__groove" cx={center} cy={center} r={RING_RADII[index]} strokeWidth={RING_STROKE} />
              {limit.percent > 0 && (
                /*
                 * `pathLength` makes the dash a percentage, whatever the radius,
                 * and the rotation starts it at twelve o'clock: a circle's
                 * stroke begins at three.
                 */
                <circle
                  className="usage__arc"
                  cx={center}
                  cy={center}
                  r={RING_RADII[index]}
                  strokeWidth={RING_STROKE}
                  pathLength={100}
                  strokeDasharray={`${limit.percent} 100`}
                  transform={`rotate(-90 ${center} ${center})`}
                />
              )}
            </g>
          ))}
        </svg>
      </button>
      {pop.at !== null && (
        <div
          ref={pop.menu}
          className={`menu usage__pop${stale}`}
          style={{ left: pop.at.left, top: pop.at.top }}
          aria-label="Claude usage limits"
        >
          {usage.limits.map((limit) => (
            /*
             * The level goes on the row rather than on the fill, because the
             * number wears it too.
             */
            <div className={`usage__row usage__row--${usageLevel(limit.percent)}`} key={limit.label}>
              <span className="usage__label">{limit.label}</span>
              <span className="usage__track">
                <i className="usage__fill" style={{ width: `${limit.percent}%` }} />
              </span>
              <span className="usage__percent">{limit.percent}%</span>
              <span className="usage__resets">{resetsOf(limit)}</span>
            </div>
          ))}
          <div className="usage__read">{read}</div>
        </div>
      )}
    </>
  )
}
