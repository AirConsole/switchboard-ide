import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { trackViewport } from './viewport.js'
import './styles.css'

trackViewport()

/*
 * Removes the service worker this app briefly shipped, and does not register one.
 *
 * A worker was added to earn Chrome's omnibox install icon, which is the one
 * install affordance that still requires a fetch handler, and then dropped: the
 * ⋮ menu installs the app perfectly well from the manifest alone, and a worker
 * is sticky machinery to maintain for a click.
 *
 * Deleting the file is not enough, which is why this is here. A registered
 * worker outlives its script, and /sw.js now falls through to the SPA handler,
 * which answers index.html with a 200 -- so the browser's update check gets
 * HTML where it wanted JavaScript, fails, and keeps running the worker it
 * already has, indefinitely. This unregisters it instead, and drops the one
 * cache it kept.
 *
 * Safe to delete once every browser that loaded the app during that window has
 * loaded it again. Harmless until then: it is a no-op wherever there is nothing
 * registered.
 */
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .then(() => globalThis.caches?.keys())
    .then((keys) => Promise.all((keys ?? []).map((key) => globalThis.caches.delete(key))))
    .catch(() => {})
}

const host = document.getElementById('root')
if (!host) throw new Error('missing #root')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
