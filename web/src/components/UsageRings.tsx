import { useEffect, useState } from 'react'
import type { MachineUsage, Usage, UsageLimit } from '@switchboard/shared'
import { api } from '../api.js'
import { useStore } from '../store.js'
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

export const useUsage = (): MachineUsage[] | null => {
  const [usage, setUsage] = useState<MachineUsage[] | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      if (document.hidden) return
      void api
        .usageMachines()
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
 * How long each limit's window is, so that how far into it we are can be read
 * off the reset: Claude's session is five hours and every weekly limit seven
 * days. `/usage` says neither, so it is the label. A label we do not know, or
 * a reset further off than its window could be, is a window we do not know,
 * and that limit falls back to its percentage alone.
 */
const WINDOW_MS: Record<string, number> = { session: 5 * 60 * 60 * 1000 }
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const windowOf = (label: string): number => WINDOW_MS[label] ?? WEEK_MS

/*
 * Before a tenth of the window has gone, one long turn is most of the reading
 * and a projection from it says nothing: 4% in the first ten minutes of a
 * session "projects" to 120%. So the pace is never taken over less than a
 * tenth of the window -- early on it is the percentage against a tenth.
 */
const MIN_ELAPSED = 0.1

/**
 * How much of `from`..`to` falls on one of `days`, in the reader's time zone.
 *
 * Walked a local midnight at a time rather than in steps of 24 hours, so a
 * daylight-saving change -- a 23- or 25-hour day -- is counted as the day it
 * is. A week is eight steps at most.
 */
export const workedMs = (from: number, to: number, days: readonly number[]): number => {
  let total = 0
  let at = from
  while (at < to) {
    const day = new Date(at)
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
    const end = Math.min(next, to)
    if (days.includes(day.getDay())) total += end - at
    at = end
  }
  return total
}

/**
 * Where a limit ends up at its reset if it keeps being spent the way it has
 * been: the percentage over the share of the window that has gone. Null when
 * the window cannot be known (see `windowOf`).
 *
 * A weekly limit counts only the days you work (`UiState.workDays`): the
 * share gone is the working time gone over the working time in the week, so
 * a weekend off neither pads the pace on Friday nor makes Monday look
 * behind. Not the session, which is five hours and lasts as long as you are
 * working anyway. A week with none of your days in it -- every day switched
 * off is refused, but the time zone could still do it -- is paced by the
 * clock.
 *
 * Taken at `at`, the moment of the reading, rather than now: the percentage
 * is from then, and the two must be from the same moment.
 */
export const usagePace = (
  limit: UsageLimit,
  at: number,
  workDays: readonly number[] = ALL_DAYS,
): number | null => {
  if (limit.resetsAt === null) return null
  const window = windowOf(limit.label)
  const left = limit.resetsAt - at
  if (left < 0 || left > window) return null
  let gone = 1 - left / window
  if (window === WEEK_MS && workDays.length < 7) {
    const start = limit.resetsAt - window
    const working = workedMs(start, limit.resetsAt, workDays)
    if (working > 0) gone = workedMs(start, at, workDays) / working
  }
  return limit.percent / Math.max(MIN_ELAPSED, gone)
}

/**
 * On pace, running out before the reset, clearly running out.
 *
 * **By pace, not by percentage.** 60% three quarters of the way through a
 * session is fine -- it ends at 80 -- and 80% at the same point is not: it
 * runs out before the reset. A percentage alone could not tell those two
 * apart, and turned amber at 75 for a week that had a day left. So it is
 * amber when the pace ends past 100%, and red from 120% -- out with a sixth
 * of the window still to go, which is clearly over and not a rounding. A
 * limit already spent is red whatever its pace. Without a window it is the
 * percentage, at the old 75 and 90.
 *
 * On pace is grey, not green. Green is an agent that has come to rest, and a
 * ring that is green most of the day would be the one green thing in sight
 * that is not done.
 *
 * This is the one thing in the chrome that wears amber without being an agent
 * that wants you, and it is a considered exception rather than a lapse. What
 * amber means here is the same verb -- something needs you to act -- about the
 * account rather than about one worktree, and the ring it sits in is 28px in
 * the corner of the top bar, nowhere near the row of windows the colour rule
 * is written to protect. Red is `--danger`, which already means "this one is
 * different, look before you act".
 */
export const usageLevel = (
  limit: UsageLimit,
  at: number,
  workDays: readonly number[] = ALL_DAYS,
): 'plenty' | 'low' | 'spent' => {
  if (limit.percent >= 100) return 'spent'
  const pace = usagePace(limit, at, workDays)
  if (pace === null) return limit.percent >= 90 ? 'spent' : limit.percent >= 75 ? 'low' : 'plenty'
  return pace >= 120 ? 'spent' : pace > 100 ? 'low' : 'plenty'
}

/** The week as the work-days switch lays it out, Monday first. */
const WEEK = [
  { day: 1, short: 'M', name: 'Monday' },
  { day: 2, short: 'T', name: 'Tuesday' },
  { day: 3, short: 'W', name: 'Wednesday' },
  { day: 4, short: 'T', name: 'Thursday' },
  { day: 5, short: 'F', name: 'Friday' },
  { day: 6, short: 'S', name: 'Saturday' },
  { day: 0, short: 'S', name: 'Sunday' },
]

/*
 * The rings' geometry, in the SVG's own units: a 28px square, three 3px
 * strokes with a 1px gap between them, so the innermost keeps a 6px hole and
 * reads as a ring rather than a dot. At 26 it had a 4px hole, and at one
 * device pixel to the CSS pixel the inner ring rendered as a disc.
 */
const RING_SIZE = 28
const RING_STROKE = 3
const RING_RADII = [12.5, 8.5, 4.5]

/** One machine's rings: the limits nested, outermost first. */
const Rings = ({ usage, workDays }: { usage: Usage; workDays: readonly number[] }): React.ReactElement => {
  const center = RING_SIZE / 2
  return (
    <svg
      className={`usage__rings${usage.error === undefined ? '' : ' usage--stale'}`}
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      {/* A fourth limit, should `/usage` ever report one, is in the panel. */}
      {usage.limits.slice(0, RING_RADII.length).map((limit, index) => (
        <g className={`usage__ring usage__ring--${usageLevel(limit, usage.fetchedAt, workDays)}`} key={limit.label}>
          <circle className="usage__groove" cx={center} cy={center} r={RING_RADII[index]} strokeWidth={RING_STROKE} />
          {limit.percent > 0 && (
            /*
             * `pathLength` makes the dash a percentage, whatever the radius,
             * and the rotation starts it at twelve o'clock: a circle's stroke
             * begins at three.
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
  )
}

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
 * One set per machine whose limits are its own: this one first, then each
 * linked machine signed in to a different Claude account. Machines sharing an
 * account share one allowance, and the server leaves their repeats out (see
 * `distinctUsages`), so the common case -- every machine on your one
 * subscription -- is still one set of rings.
 *
 * It replaced three rows of bars, 189px of the top bar with a label, a track,
 * a percentage and a countdown each. That was the whole reading always on
 * screen and it was the bar's widest thing, so the ladder spent three of its
 * seven rungs narrowing it. A ring says what a glance needs -- how full, and
 * in colour when it matters (see `usageLevel`) -- in 28px at every width, and
 * a click hangs the whole reading under it, where it has the room to say when
 * each limit comes back as a time and not only a countdown.
 */
export const UsageRings = ({ machines }: { machines: MachineUsage[] }): React.ReactElement | null => {
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
  const workDays = useStore((state) => state.ui.workDays)
  const setUi = useStore((state) => state.setUi)
  const pop = useAnchoredMenu<HTMLButtonElement>()
  const shown = machines.filter((machine) => machine.usage.limits.length > 0)
  if (shown.length === 0) return null
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
  // Why a ring is the colour it is, for a pointer that rests on its row.
  const paceOf = (limit: UsageLimit, at: number): string | undefined => {
    const pace = usagePace(limit, at, workDays)
    return pace === null ? undefined : `at this pace, ${Math.round(pace)}% by the reset`
  }
  const clock = (at: number): string =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const readOf = (usage: Usage): string =>
    usage.error === undefined
      ? `read ${clock(usage.fetchedAt)}`
      : `last read ${clock(usage.fetchedAt)} — ${usage.error}`
  // Named only when there is more than one, since one set needs no name.
  const named = shown.length > 1
  const summary = shown
    .map((machine) => {
      const limits = machine.usage.limits.map((limit) => `${limit.label} ${limit.percent}%`).join(', ')
      return named ? `${machine.name}: ${limits}` : limits
    })
    .join('\n')
  return (
    <>
      <button
        type="button"
        ref={pop.anchor}
        className={`usage${pop.at === null ? '' : ' usage--open'}`}
        // The numbers without a click, for a pointer that rests on it.
        title={summary}
        aria-label={`Claude usage: ${summary.replace(/\n/g, '; ')}`}
        aria-expanded={pop.at !== null}
        onClick={pop.toggle}
      >
        {shown.map((machine) => (
          <Rings usage={machine.usage} workDays={workDays} key={machine.key ?? ''} />
        ))}
      </button>
      {pop.at !== null && (
        <div
          ref={pop.menu}
          className="menu usage__pop"
          style={{ left: pop.at.left, top: pop.at.top }}
          aria-label="Claude usage limits"
        >
          {shown.map((machine) => (
            <div
              className={`usage__machine${machine.usage.error === undefined ? '' : ' usage--stale'}`}
              key={machine.key ?? ''}
            >
              {named && <div className="usage__name">{machine.name}</div>}
              {machine.usage.limits.map((limit) => (
                /*
                 * The level goes on the row rather than on the fill, because
                 * the number wears it too.
                 */
                <div
                  className={`usage__row usage__row--${usageLevel(limit, machine.usage.fetchedAt, workDays)}`}
                  key={limit.label}
                  title={paceOf(limit, machine.usage.fetchedAt)}
                >
                  <span className="usage__label">{limit.label}</span>
                  <span className="usage__track">
                    <i className="usage__fill" style={{ width: `${limit.percent}%` }} />
                  </span>
                  <span className="usage__percent">{limit.percent}%</span>
                  <span className="usage__resets">{resetsOf(limit)}</span>
                </div>
              ))}
              <div className="usage__read">{readOf(machine.usage)}</div>
            </div>
          ))}
          {/*
           * Once, under every machine's reading, because it is about you and
           * not about an account. Monday first: a working week reads as the
           * first five, and the weekend as the two it ends on.
           */}
          <div className="usage__days" role="group" aria-label="Days you work, for the weekly limits">
            <span className="usage__label" title="The weekly limits are paced over these days only">
              work days
            </span>
            {WEEK.map(({ day, short, name }) => {
              const on = workDays.includes(day)
              return (
                <button
                  type="button"
                  key={day}
                  className={`usage__day${on ? ' usage__day--on' : ''}`}
                  aria-pressed={on}
                  aria-label={name}
                  // Not the last one: a week with no working time in it has
                  // no pace to read.
                  disabled={on && workDays.length === 1}
                  onClick={() =>
                    setUi({
                      workDays: on ? workDays.filter((d) => d !== day) : [...workDays, day].sort((a, b) => a - b),
                    })
                  }
                >
                  {short}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
