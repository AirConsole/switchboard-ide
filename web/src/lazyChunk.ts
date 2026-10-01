import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * How long a reload for a missing chunk counts as "just tried".
 *
 * Long enough that a page which reloads and still cannot find the chunk -- the
 * server is down, or the build really is broken -- fails instead of looping;
 * short enough that the next deploy, an hour later, gets its reload too.
 */
const RELOAD_WINDOW_MS = 30_000
const RELOADED_AT = 'swb-chunk-reload'
/** Past the `ui` write's 200ms debounce; see `reloadOnce`. */
const RELOAD_DELAY_MS = 600

/**
 * Reload the page for a chunk that is gone, at most once per window.
 *
 * True when a reload is under way. Storage can be blocked or throw; without it
 * there is no way to know this is not the second try, so the answer is no.
 */
const reloadOnce = (): boolean => {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0)
    if (Date.now() - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOADED_AT, String(Date.now()))
  } catch {
    return false
  }
  /*
   * Not at once: the click that needed the chunk -- opening the file -- is a
   * `ui` change, written 200ms later, and a reload before that write lands
   * came back with the panel open and no file in it, so the click had to be
   * made again. Measured on a scratch instance; this outlasts the debounce and
   * a local round trip.
   */
  window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
  return true
}

/**
 * `React.lazy`, for a page that may have outlived its build.
 *
 * A deploy rebuilds `web/dist` and every chunk gets a new name, so a page left
 * open across one asks for a file that no longer exists the first time it
 * needs a chunk it had not loaded yet -- the Markdown renderer, typically,
 * since most sessions open a file before they open a `.md`. The import throws,
 * and with nothing to catch it React unmounted the whole app: the screen went
 * black on clicking a Markdown file, which is how it was reported. Measured on
 * a scratch instance by answering the old chunk name the way the server did --
 * `index.html` with a 200 -- and `#root` was left with no children.
 *
 * The page is stale, and the fix for a stale page is the page: reload once,
 * and meanwhile render nothing rather than throw. A second failure inside the
 * window is real and is thrown, for an error boundary to say so.
 */
export const lazyChunk = <P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> => lazy(() => loadOrReload(load))

/** The loader `lazyChunk` hands React, apart so it can be held to the rule. */
export const loadOrReload = <T>(load: () => Promise<T>): Promise<T> =>
  load().catch((err: unknown) => {
    if (reloadOnce()) return new Promise<never>(() => {})
    throw err
  })
