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

// ── WebRTC support detection ─────────────────────────────────
// Must run before React mounts to prevent raw JS errors
// on unsupported browsers (iOS Lockdown Mode, Opera Mini, etc.)

function isWebRTCSupported(): boolean {
  return (
    typeof RTCPeerConnection !== 'undefined' &&
    typeof RTCSessionDescription !== 'undefined'
  )
}

if (!isWebRTCSupported()) {
  // Style the body directly - React is not mounted yet
  document.body.style.cssText = `
    margin: 0;
    padding: 0;
    background: #070709;
    color: #c8c8c0;
    font-family: 'IBM Plex Mono', 'Courier New', monospace;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    text-align: center;
  `

  document.body.innerHTML = `
    <div style="max-width:360px;padding:40px 24px;">

      <div style="
        font-size: 13px;
        font-weight: 500;
        letter-spacing: .25em;
        text-transform: uppercase;
        margin-bottom: 24px;
        color: #c8c8c0;
      ">MORIA</div>

      <div style="
        font-size: 11px;
        letter-spacing: .08em;
        color: #f54848;
        text-transform: uppercase;
        margin-bottom: 16px;
      ">WebRTC unavailable</div>

      <div style="
        font-size: 12px;
        color: #4e4e56;
        line-height: 1.7;
        letter-spacing: .04em;
        margin-bottom: 24px;
      ">
        MORIA requires WebRTC for direct peer-to-peer
        encrypted connections. Your browser does not
        currently support WebRTC.
      </div>

      <div style="
        border: 0.5px solid #2a2a32;
        padding: 12px 16px;
        line-height: 1.7;
        letter-spacing: .04em;
        margin-bottom: 24px;
        text-align: left;
      ">
        <div style="
          color: #e8a020;
          font-size: 9px;
          letter-spacing: .2em;
          text-transform: uppercase;
          margin-bottom: 8px;
        ">iOS Lockdown Mode</div>
        <div style="color: #4e4e56; font-size: 11px; line-height: 1.7;">
          If you have Lockdown Mode enabled on your iPhone
          or iPad, WebRTC is disabled by Apple to reduce
          attack surface. Disable Lockdown Mode to use
          MORIA on this device, or switch to a desktop
          browser.
        </div>
      </div>

      <div style="
        font-size: 11px;
        color: #4e4e56;
        line-height: 1.7;
        letter-spacing: .04em;
      ">
        Supported: Safari, Chrome, Firefox, Brave<br>
        on iOS (without Lockdown Mode) and Android.
      </div>

    </div>
  `

  // Stop here - do not mount React on unsupported browsers

} else {

  // ── Mount React ───────────────────────────────────────────
  const root = document.getElementById('root')
  if (!root) throw new Error('Root element not found')
  createRoot(root).render(<App />)

}
