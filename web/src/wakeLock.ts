import { useEffect } from 'react'
import { softKeys } from './terminal/softKeyboard.js'

/**
 * Whether the screen should be held awake right now.
 *
 * **Only where the keyboard is drawn on the glass**, which is the same test
 * `softKeys` makes everywhere else here: a phone blanks its screen after
 * fifteen seconds of not being touched, and watching an agent work is exactly
 * fifteen seconds of not touching anything. A laptop has its own idea about
 * when to sleep and a web page has no business overriding it.
 *
 * Visible *and* focused, because either one alone is wrong. A hidden page
 * cannot hold the lock at all -- the browser drops it the moment you switch
 * tabs, and asking again throws -- and a visible but unfocused one is a page
 * you are not looking at: a phone in split screen with something else in hand,
 * or a browser window behind another. Holding the screen awake for a window
 * nobody is looking at is how a battery disappears.
 */
export const shouldHoldWake = (state: {
  soft: boolean
  visible: boolean
  focused: boolean
}): boolean => state.soft && state.visible && state.focused

/** What a wake lock offers us: nothing but a way to give it back. */
interface WakeSentinel {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', run: () => void) => void
}

interface WakeCapableNavigator {
  wakeLock?: { request: (type: 'screen') => Promise<WakeSentinel> }
}

/**
 * Keep the screen awake while you are watching a worktree on a phone.
 *
 * The screen wake lock is the only thing a page can do about this, and it is
 * given up for you rather than held forever: the browser releases it whenever
 * the page is hidden, so the "release" event is not an error to handle but the
 * ordinary way this ends, and the next `visibilitychange` asks again.
 *
 * Every request is a promise, and what it resolves to can be stale -- a tab
 * switched away from while the request was in flight -- so the state is asked
 * again on arrival and a lock nobody wants any more is released immediately.
 * Requesting can also simply fail, on a browser without the API (Firefox on
 * Android, at the time of writing), on a page the browser considers hidden, or
 * with the battery in a saving mode. None of that is worth a word on screen:
 * the screen dims, as it did before this existed.
 */
export const useWakeLock = (): void => {
  useEffect(() => {
    const api = (navigator as WakeCapableNavigator).wakeLock
    if (api === undefined) return
    let sentinel: WakeSentinel | null = null
    let asking = false
    let live = true

    const wanted = (): boolean =>
      shouldHoldWake({
        soft: softKeys(),
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
      })

    const sync = (): void => {
      if (!live) return
      const want = wanted()
      if (want && sentinel === null && !asking) {
        asking = true
        void api
          .request('screen')
          .then((held) => {
            asking = false
            // The answer can arrive after the reason for asking has gone.
            if (!live || !wanted()) {
              void held.release()
              return
            }
            sentinel = held
            // The browser gives it back for us when the page is hidden; this
            // is how we learn, so the next visible page asks afresh.
            held.addEventListener('release', () => {
              if (sentinel === held) sentinel = null
            })
          })
          .catch(() => {
            asking = false
          })
        return
      }
      if (!want && sentinel !== null) {
        const held = sentinel
        sentinel = null
        void held.release().catch(() => undefined)
      }
    }

    sync()
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      if (sentinel !== null) void sentinel.release().catch(() => undefined)
      sentinel = null
    }
  }, [])
}
