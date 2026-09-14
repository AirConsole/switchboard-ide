/*
 * A service worker that caches nothing.
 *
 * It exists for one reason: Chrome will not offer the omnibox install icon, or
 * fire `beforeinstallprompt`, without a registered worker carrying a fetch
 * handler -- and that handler may not be an empty one. Installing from the ⋮
 * menu has not needed a worker since desktop 112; the *promotion* still does.
 *
 * The danger in that is obvious and is the whole reason this file is written
 * the way it is. This IDE is deployed by rebuilding `web/dist` and restarting,
 * and CLAUDE.md's promise is that "a web change reaches them on reload". A
 * worker that cached the app shell would break that promise silently: the
 * browser would keep serving yesterday's JavaScript to a user who had reloaded
 * and would swear they had.
 *
 * So nothing here ever caches app code, and nothing is ever served from cache
 * while the network is answering:
 *
 *   - Only navigations are intercepted at all. Every other GET, and every
 *     non-GET, is left alone -- no `respondWith`, so the browser fetches it
 *     exactly as it would with no worker installed. That includes /api, and
 *     WebSockets are never seen by a worker in the first place, so /ws is
 *     untouched by construction.
 *   - A navigation goes to the network first, every time. The cache is only
 *     reached when that `fetch` rejects, which means the server is gone.
 *
 * The single cached entry is the offline notice. It is not the app and must
 * never become the app: if a future change here starts caching index.html or
 * anything under /assets, the deploy model is broken and reload stops meaning
 * anything. See web/CLAUDE.md.
 */

const CACHE = 'switchboard-offline-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      // Take over without waiting for every client to close. The usual patience
      // is wrong here: this is an IDE people leave open for days, so a waiting
      // worker would be a worker that never activates.
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  // Anything not a navigation is none of our business; returning without
  // calling respondWith hands it back to the browser untouched.
  if (event.request.mode !== 'navigate') return

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE)
      const offline = await cache.match(OFFLINE_URL)
      return (
        offline ??
        new Response('Switchboard is not reachable.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      )
    }),
  )
})
