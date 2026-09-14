import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { trackViewport } from './viewport.js'
import './styles.css'

trackViewport()

/*
 * Registered only so Chrome will offer the install icon: the omnibox promotion
 * and `beforeinstallprompt` still require a worker with a fetch handler, even
 * though installing from the ⋮ menu no longer does.
 *
 * The worker caches nothing but an offline notice and never answers from cache
 * while the network is up -- see web/public/sw.js, which explains at length why
 * it must stay that way. Production only: in dev, Vite serves the app and a
 * worker sitting in front of it is one more thing between an edit and the page.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Failure is not worth surfacing: every part of the app works without it,
    // and the only casualty is the install icon.
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

const host = document.getElementById('root')
if (!host) throw new Error('missing #root')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
