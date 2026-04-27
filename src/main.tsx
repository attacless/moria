import './index.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initCrypto } from './wasm'

initCrypto().catch(console.error)

// ── bfcache defense ──────────────────────────────────────────
// If browser restores page from cache (back button),
// replace DOM immediately - session is already destroyed.
window.addEventListener('pageshow', (e: PageTransitionEvent) => {
  if (e.persisted) {
    try { window.history.replaceState({}, '', '/') } catch (_) {}
    document.title = ''
    try { sessionStorage.clear() } catch (_) {}
    try { localStorage.clear()   } catch (_) {}
    try {
      document.documentElement.innerHTML =
        '<head><meta charset="utf-8"><title></title>' +
        '<style>*{margin:0;padding:0}body{background:#fff}</style></head><body></body>'
    } catch (_) {}
    try { window.stop() } catch (_) {}
    window.addEventListener('popstate', () => {
      try { window.history.replaceState({}, '', '/') } catch (_) {}
      document.title = ''
    })
  }
})

// ── Mount React ───────────────────────────────────────────────────────────────
// WebRTC unavailability (iOS Lockdown Mode, Tor Browser, etc.) is handled
// gracefully in-app. Dead drop mode works without WebRTC.
const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')
createRoot(root).render(<App />)
