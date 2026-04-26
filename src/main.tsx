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
    background: #050505;
    color: rgba(240,248,255,0.9);
    font-family: 'Inter', system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    text-align: center;
  `

  document.body.innerHTML = `
    <div style="max-width:360px;padding:40px 24px;">

      <div style="
        font-family: 'Ronzino', 'Inter', sans-serif;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: .25em;
        text-transform: uppercase;
        margin-bottom: 32px;
        color: rgba(240,248,255,0.9);
      ">MORIA</div>

      <div style="
        font-family: 'Ronzino', 'Inter', sans-serif;
        font-size: 11px;
        letter-spacing: .15em;
        text-transform: uppercase;
        color: rgba(240,248,255,0.9);
        margin-bottom: 16px;
      ">browser not supported</div>

      <div style="
        font-size: 12px;
        color: rgba(240,248,255,0.3);
        line-height: 1.8;
        letter-spacing: .03em;
        margin-bottom: 28px;
      ">
        Moria requires WebRTC for peer-to-peer encrypted
        connections. Your browser does not support WebRTC.
      </div>

      <div style="
        border: 0.5px solid rgba(240,248,255,0.08);
        padding: 14px 16px;
        line-height: 1.8;
        letter-spacing: .03em;
        margin-bottom: 28px;
        text-align: left;
      ">
        <div style="
          font-family: 'Ronzino', 'Inter', sans-serif;
          color: rgba(240,248,255,0.9);
          font-size: 9px;
          letter-spacing: .2em;
          text-transform: uppercase;
          margin-bottom: 8px;
        ">iOS Lockdown Mode</div>
        <div style="color: rgba(240,248,255,0.3); font-size: 11px; line-height: 1.8;">
          If Lockdown Mode is enabled on your iPhone or iPad,
          Apple disables WebRTC to reduce attack surface.
          Disable Lockdown Mode to use Moria on this device,
          or open Moria in a desktop browser.
        </div>
      </div>

      <div style="
        font-size: 11px;
        color: rgba(240,248,255,0.3);
        line-height: 1.8;
        letter-spacing: .03em;
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
