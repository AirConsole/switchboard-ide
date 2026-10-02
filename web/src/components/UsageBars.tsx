import { useEffect, useState } from 'react'
import type { Usage } from '@switchboard/shared'
import { api } from '../api.js'
import { resetText } from '../selectors.js'
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
 * Claude's usage limits, as bars.
 *
 * Two rows of limits, in the order `/usage` reported them -- the two most used
 * of the session, the week and a model's own allowance, see `shownLimits` --
 * and under them the switch that continues stopped agents. Grey while there is
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
 * account rather than about one worktree, and the reading it sits in is two
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

/**
 * The two limits the bar has rows for: the two most used, in the order
 * `/usage` reported them.
 *
 * The third row is the switch below, so the three limits share two rows. A tie
 * goes to the one reported first -- the session, then the week, then a model's
 * own allowance (`fable`) -- so that allowance takes a row only by being ahead
 * of one of the others, and never for sitting at 0% beside another 0%. All of
 * them are still in the tooltip and in the last rung's panel.
 */
export const shownLimits = (limits: Usage['limits']): Usage['limits'] => {
  const kept = new Set(
    limits
      .map((limit, at) => ({ limit, at }))
      // Stable, so a tie keeps the order it was reported in.
      .sort((a, b) => b.limit.percent - a.limit.percent)
      .slice(0, 2)
      .map(({ at }) => at),
  )
  return limits.filter((_, at) => kept.has(at))
}

export const UsageBars = ({
  usage,
  autoContinue,
}: {
  usage: Usage
  /** Absent from a machine too old to do it, which then shows every limit and no switch. */
  autoContinue?: boolean
}): React.ReactElement | null => {
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
  /*
   * At the last rung the readout is the percentages alone, and a click hangs
   * the whole of it under the bar; another click, Escape or a click anywhere
   * else puts it away. Wider, the whole of it is already in the bar, so the
   * click does nothing.
   *
   * Which rung it is gets read off the DOM *at the click*, not rendered from:
   * nothing React draws may depend on the rung (see the sweep in `TopBar`),
   * and the panel is hidden by CSS at every other one, so a window widened
   * with it open does not show the readout twice.
   */
  const pop = useAnchoredMenu<HTMLButtonElement>()
  /*
   * What the switch does, said in full on a click. Its title said it already,
   * but a tooltip is a sentence nobody finds: it waits for a hover held still
   * and says nothing on a phone, and the label alone is two words for a
   * behaviour that needs three sentences.
   */
  const info = useAnchoredMenu<HTMLButtonElement>()
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
  const rows = (limits: Usage['limits']): React.ReactElement[] =>
    limits.map((limit) => (
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
    ))
  const stale = usage.error === undefined ? '' : ' usage--stale'
  const on = autoContinue === true
  return (
    <div className={`usage${stale}`}>
      <button
        type="button"
        ref={pop.anchor}
        className={`usage__readout${pop.at === null ? '' : ' usage--open'}`}
        title={title}
        aria-label="Claude usage limits"
        aria-expanded={pop.at !== null}
        onClick={(event) => {
          const stage = event.currentTarget.closest<HTMLElement>('.topbar')?.dataset.stage
          if (stage === '7' || pop.at !== null) pop.toggle()
        }}
      >
        {rows(autoContinue === undefined ? usage.limits : shownLimits(usage.limits))}
      </button>
      {autoContinue !== undefined && (
        /*
         * A switch, not a checkbox inside the readout: the readout is a button
         * at the last rung, and a control inside a control is neither. All
         * three labels are always in the markup and the rung decides which one
         * shows, because nothing React renders may depend on the rung -- see
         * the sweep in `TopBar`.
         */
        <div className="usage__autorow">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={on ? 'usage__auto usage__auto--on' : 'usage__auto'}
            title={
              on
                ? 'On: an agent stopped by a usage limit is sent "continue" once the limit resets, here and on every linked machine. Click to turn it off.'
                : 'Off: an agent stopped by a usage limit waits for you. Click to continue such agents once the limit resets.'
            }
            onClick={() => {
              void api.setAutoContinue(!on).catch(() => {})
            }}
          >
            <i className="usage__box" aria-hidden="true" />
            <span className="usage__auto-long">continue automatically</span>
            <span className="usage__auto-mid">auto-continue</span>
            <span className="usage__auto-short">cont.</span>
          </button>
          <button
            type="button"
            ref={info.anchor}
            className={info.at === null ? 'usage__info' : 'usage__info usage__info--open'}
            aria-label="What continue automatically does"
            aria-expanded={info.at !== null}
            onClick={info.toggle}
          >
            i
          </button>
        </div>
      )}
      {pop.at !== null && (
        <div
          ref={pop.menu}
          className={`menu usage__pop${stale}`}
          style={{ left: pop.at.left, top: pop.at.top }}
          aria-label="Claude usage limits"
        >
          {rows(usage.limits)}
        </div>
      )}
      {info.at !== null && (
        <div
          ref={info.menu}
          className="menu usage__explain"
          style={{ left: info.at.left, top: info.at.top }}
          role="dialog"
          aria-label="Continue automatically"
        >
          <p>
            When Claude stops because a usage limit was reached, it waits for you to type
            “continue” once the limit resets.
          </p>
          <p>
            With this on, that is done for you: each agent a limit stopped is sent “continue” as
            soon as the limit resets, here and on every linked machine, with or without a browser
            open.
          </p>
          <p>
            {on ? 'It is on: the box is filled and green.' : 'It is off: the box is empty.'} Click
            the switch to change it.
          </p>
        </div>
      )}
    </div>
  )
}

