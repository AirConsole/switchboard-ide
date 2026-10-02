import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateStatus } from '@switchboard/shared'
import { api } from '../api.js'

/**
 * How often the page asks whether there is a newer Switchboard.
 *
 * The server fetches at most once per ten minutes whoever asks, so this is the
 * same interval and a poll lands on a fresh answer rather than starting a
 * fetch of its own. A hidden page does not ask; it asks once on coming back.
 */
const POLL_MS = 10 * 60 * 1000

/**
 * While an update runs. The server is about to go away and come back as a
 * different instance, and a second or two after it does is when the page
 * should reload -- a request that fails in between is the restart, not a
 * fault, so it is simply asked again.
 */
const UPDATING_POLL_MS = 2000

/** The newest commit somebody said "Later" to, so the banner stays away until there is a newer one. */
const LATER_KEY = 'swb.update.later'

/**
 * The failure somebody dismissed. The server keeps the last one until the next
 * attempt, and without this every reload -- and every other tab -- would show
 * it again.
 */
const SEEN_KEY = 'swb.update.failure-seen'

const recall = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const remember = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode: it lasts as long as the page does.
  }
}

const short = (sha: string): string => sha.slice(0, 7)

const UPDATE_EVENT = 'swb:update'

/**
 * Update this machine from somewhere other than the banner -- a window saying
 * a linked machine is newer than this one. Through the banner all the same,
 * because the banner is what waits for the new server and reloads onto it.
 */
export const requestUpdate = (): void => {
  window.dispatchEvent(new Event(UPDATE_EVENT))
}

/**
 * A newer Switchboard on origin, offered once, and the page reloaded onto it.
 *
 * Greyscale, like the rest of the chrome: a new version is not a state of any
 * agent and must not be read as one, so it takes neither amber nor green. A
 * failed update is the red banner every failed action uses.
 *
 * Reloading is automatic only for a page that saw the update happen -- it was
 * clicked here, or the server said one was running. A page that merely finds
 * its server replaced under it (a `pnpm pull` from a shell, another tab's
 * click while this one was hidden) is asked instead, since reloading
 * unprompted takes whatever you were in the middle of with it.
 */
export const UpdateBanner = (): React.ReactElement | null => {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [later, setLater] = useState<string | null>(() => recall(LATER_KEY))
  const [failureSeen, setFailureSeen] = useState<string | null>(() => recall(SEEN_KEY))
  const [replaced, setReplaced] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The server this page was loaded from: which process, and which build. */
  const loadedFrom = useRef<{ instance: string; running: string | null } | null>(null)
  /**
   * When an update this page is waiting on was known to be running, or null
   * when it is waiting on none. Set by the click once the server has accepted
   * it, or by the server saying one is running. A new instance while this is
   * set is the one that update started, and the page reloads onto it.
   *
   * A time rather than a flag because of one race: an answer to a request
   * sent *before* the pull began says "idle" from the same instance, and read
   * naively that is a pull that ended without restarting anything.
   */
  const waitingSince = useRef<number | null>(null)
  const [waiting, setWaiting] = useState(false)
  const wait = (since: number | null): void => {
    waitingSince.current = since
    setWaiting(since !== null)
  }

  const read = useCallback(async (): Promise<void> => {
    const asked = Date.now()
    let next: UpdateStatus
    try {
      next = await api.updateStatus()
    } catch {
      return // restarting, or offline; the next poll asks again
    }
    const first = loadedFrom.current
    if (first === null) {
      loadedFrom.current = { instance: next.instance, running: next.running }
    } else if (next.instance !== first.instance) {
      if (waitingSince.current !== null) {
        window.location.reload()
        return
      }
      if (next.running !== first.running) setReplaced(next.running ?? '')
      first.instance = next.instance
    }
    if (next.state === 'updating') {
      if (waitingSince.current === null) wait(asked)
    } else if (waitingSince.current !== null && asked > waitingSince.current) {
      // The same process, and no pull running: it failed, or found nothing to
      // do. Either way nothing is coming.
      wait(null)
    }
    setStatus(next)
  }, [])

  const updating = waiting || status?.state === 'updating'

  useEffect(() => {
    const tick = (): void => {
      if (document.hidden && !updating) return
      void read()
    }
    tick()
    const timer = window.setInterval(tick, updating ? UPDATING_POLL_MS : POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [read, updating])

  const update = (): void => {
    setError(null)
    // Waiting from the click, so the banner says so at once; the time is
    // moved to when the server accepted, which is when "idle" starts to mean
    // "ended".
    wait(Number.POSITIVE_INFINITY)
    api
      .startUpdate()
      .then(() => wait(Date.now()))
      .catch((err: unknown) => {
        wait(null)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const updateRef = useRef(update)
  updateRef.current = update
  useEffect(() => {
    const onRequest = (): void => updateRef.current()
    window.addEventListener(UPDATE_EVENT, onRequest)
    return () => window.removeEventListener(UPDATE_EVENT, onRequest)
  }, [])

  if (replaced !== null) {
    return (
      <div className="banner banner--update">
        <span className="banner__text">
          Switchboard was updated{replaced === '' ? '' : ` to ${short(replaced)}`}. This page is still the old one.
        </span>
        <button className="btn banner__action" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }

  if (error !== null || (status?.state === 'failed' && status.failure !== failureSeen && !updating)) {
    const message = error ?? status?.failure ?? ''
    return (
      <div className="banner banner--failed">
        <div className="banner__text">
          <div>The update did not happen. What is running is still the version you had.</div>
          <pre className="banner__output">{message}</pre>
        </div>
        <button
          className="banner__dismiss"
          onClick={() => {
            setError(null)
            if (status?.failure != null) {
              remember(SEEN_KEY, status.failure)
              setFailureSeen(status.failure)
            }
          }}
        >
          Dismiss
        </button>
      </div>
    )
  }

  if (updating) {
    return (
      <div className="banner banner--update">
        <span className="banner__text">
          Updating Switchboard: pulling, building, restarting. Agents keep running, and this page reloads when it is
          back.
        </span>
      </div>
    )
  }

  if (status === null || !status.updatable || status.behind === 0) return null
  const newest = status.commits[0]
  if (newest === undefined || newest.sha === later) return null

  const count = `${status.behind} new commit${status.behind === 1 ? '' : 's'}`
  const list = status.commits.map((c) => `${short(c.sha)}  ${c.subject}`).join('\n')
  return (
    <div className="banner banner--update">
      <span className="banner__text" title={list}>
        A newer Switchboard is on {status.branch ?? 'origin'}: {count}, the latest “{newest.subject}”.
        {status.blocked !== null && <> It cannot be pulled here: {status.blocked}.</>}
      </span>
      {status.blocked === null && (
        <button className="btn banner__action" onClick={update}>
          Update
        </button>
      )}
      <button
        className="banner__dismiss"
        onClick={() => {
          remember(LATER_KEY, newest.sha)
          setLater(newest.sha)
        }}
      >
        Later
      </button>
    </div>
  )
}
