import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { trackViewport } from './viewport.js'
import './styles.css'

trackViewport()

const host = document.getElementById('root')
if (!host) throw new Error('missing #root')

/*
 * The last stop for a render that threw. Without it React unmounts the whole
 * tree and leaves a black page with no way out but the reload button -- which
 * is what this says, since by then nothing else on the page can be trusted.
 * The panes that can fail on their own catch their own first (see FilesPane).
 */
createRoot(host).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error) => (
        <div className="crash">
          <p>Switchboard stopped drawing: {error.message}</p>
          <p className="crash__note">Your agents are still running.</p>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
