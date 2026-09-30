import { useSyncExternalStore } from 'react'

/**
 * Whether the tab is in front of somebody: `document.visibilityState`.
 *
 * For polls, which a background tab has no use for. `useSyncExternalStore`
 * rather than state set from an effect, so the first render already knows and
 * a tab opened in the background never starts polling at all.
 */
const subscribe = (changed: () => void): (() => void) => {
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

export const usePageVisible = (): boolean =>
  useSyncExternalStore(subscribe, () => document.visibilityState !== 'hidden')
