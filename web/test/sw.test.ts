import { describe, expect, it } from 'vitest'
import source from '../public/sw.js?raw'

/**
 * The service worker, which exists only so Chrome will offer the install icon
 * and must never become a cache of the app.
 *
 * That is the whole reason this file exists. The worker is one `respondWith`
 * away from serving yesterday's JavaScript to someone who has reloaded and
 * would swear they had -- and "a web change reaches them on reload" is the
 * deploy model. Nothing else in the suite can catch that: it is a file in
 * `public/`, so it is never typechecked, never imported by the app, and never
 * reached by coverage. So it is loaded here as text and driven directly.
 *
 * The tests are about *what is cached and when*, not about the shape of the
 * code, so a rewrite of sw.js that keeps the promise keeps them passing.
 */

type Handler = (event: unknown) => void

class FakeCache {
  readonly entries = new Map<string, Response>()
  add(request: { url: string } | string): Promise<void> {
    const url = typeof request === 'string' ? request : request.url
    this.entries.set(url, new Response('the offline notice'))
    return Promise.resolve()
  }
  match(url: string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(url))
  }
}

/**
 * Load sw.js into a scope we control.
 *
 * `Request` is stubbed rather than Node's: a service worker resolves a relative
 * URL against its scope, and Node's constructor simply throws on one.
 */
const load = (
  fetchImpl: (request: unknown) => Promise<Response>,
  existingCaches: string[] = [],
) => {
  const handlers: Record<string, Handler> = {}
  const caches = new Map<string, FakeCache>(existingCaches.map((key) => [key, new FakeCache()]))
  const deleted: string[] = []
  let skipWaiting = 0
  let claimed = 0

  const scope = {
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler
    },
    skipWaiting: () => {
      skipWaiting += 1
      return Promise.resolve()
    },
    clients: {
      claim: () => {
        claimed += 1
        return Promise.resolve()
      },
    },
  }

  const cacheStorage = {
    open: (key: string) => {
      if (!caches.has(key)) caches.set(key, new FakeCache())
      return Promise.resolve(caches.get(key))
    },
    keys: () => Promise.resolve([...caches.keys()]),
    delete: (key: string) => {
      deleted.push(key)
      caches.delete(key)
      return Promise.resolve(true)
    },
  }

  class FakeRequest {
    url: string
    constructor(url: string) {
      this.url = url
    }
  }

  new Function('self', 'caches', 'fetch', 'Response', 'Request', source)(
    scope,
    cacheStorage,
    fetchImpl,
    Response,
    FakeRequest,
  )

  const fire = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const waits: Promise<unknown>[] = []
    handlers[type]?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }

  /** Drive a fetch event and return what the worker answered, or null if it declined. */
  const navigate = async (mode: string): Promise<Response | null> => {
    let answer: Promise<Response> | null = null
    handlers.fetch?.({
      request: { mode, url: 'https://example.test/' },
      respondWith: (p: Promise<Response>) => {
        answer = p
      },
    })
    return answer === null ? null : await answer
  }

  return { fire, navigate, caches, deleted, counts: () => ({ skipWaiting, claimed }) }
}

const networkServes = (body: string) => () => Promise.resolve(new Response(body))
const networkDown = () => () => Promise.reject(new Error('offline'))

describe('the service worker caches nothing but the offline notice', () => {
  it('caches exactly one entry on install', async () => {
    const w = load(networkServes('app'))
    await w.fire('install', {})
    const cache = [...w.caches.values()][0]
    expect([...(cache?.entries.keys() ?? [])]).toEqual(['/offline.html'])
  })

  it('leaves every non-navigation request alone', async () => {
    // No respondWith at all means the browser fetches it exactly as it would
    // with no worker installed. This is what keeps /assets and /api out of the
    // worker's hands entirely.
    const w = load(networkServes('app'))
    for (const mode of ['cors', 'no-cors', 'same-origin']) {
      expect(await w.navigate(mode), mode).toBeNull()
    }
  })

  it('serves a navigation from the network, not from the cache', async () => {
    const w = load(networkServes('the freshly built app'))
    await w.fire('install', {})
    const answer = await w.navigate('navigate')
    expect(await answer?.text()).toBe('the freshly built app')
  })

  it('never puts the app in the cache, however many navigations it serves', async () => {
    // The regression that would break the deploy silently.
    const w = load(networkServes('the freshly built app'))
    await w.fire('install', {})
    await w.navigate('navigate')
    await w.navigate('navigate')
    for (const cache of w.caches.values()) {
      expect([...cache.entries.keys()]).toEqual(['/offline.html'])
    }
  })

  it('falls back to the notice only once the network has actually failed', async () => {
    const w = load(networkDown())
    await w.fire('install', {})
    const answer = await w.navigate('navigate')
    expect(await answer?.text()).toBe('the offline notice')
  })

  it('still answers when the network is down and the notice was never cached', async () => {
    // An install that failed halfway must not leave navigations hanging.
    const w = load(networkDown())
    const answer = await w.navigate('navigate')
    expect(answer?.status).toBe(503)
  })
})

describe('it takes over promptly', () => {
  it('skips waiting and claims open pages', async () => {
    // The usual patience waits for every client to close, and this is an IDE
    // people leave open for days, so a waiting worker never activates.
    const w = load(networkServes('app'))
    await w.fire('install', {})
    await w.fire('activate', {})
    expect(w.counts()).toEqual({ skipWaiting: 1, claimed: 1 })
  })

  it('drops caches from earlier versions of itself', async () => {
    const w = load(networkServes('app'), ['switchboard-offline-v0', 'something-else'])
    await w.fire('activate', {})
    expect(w.deleted.sort()).toEqual(['something-else', 'switchboard-offline-v0'])
  })
})
