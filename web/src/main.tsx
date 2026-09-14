import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { trackViewport } from './viewport.js'
import './styles.css'

trackViewport()

const host = document.getElementById('root')
if (!host) throw new Error('missing #root')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
