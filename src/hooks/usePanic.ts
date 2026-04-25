import { useEffect, useRef } from 'react'
import { leaveRoom } from '@transport/room'
import { stopDecoyEngine } from '@transport/decoy'
import { unmountSecurityMeasures } from '@/security'

const PANIC_COUNT  = 3
const PANIC_WINDOW = 1_500

let panicCallback: (() => void) | null = null
let pressesTimes:  number[]            = []

function renderCoverPage(): void {
  try { window.history.replaceState({}, '', '/') } catch (_) {}
  document.title = ''
  // Wipe all storage first
  try { sessionStorage.clear() } catch (_) {}
  try { localStorage.clear()   } catch (_) {}

  // Zero crypto
  try { stopDecoyEngine() } catch (_) {}
  try { leaveRoom()       } catch (_) {}

  // Remove security listeners before DOM replacement
  try { unmountSecurityMeasures() } catch (_) {}

  // Notify React to clear state (no screen change - DOM replacement
  // happens after this so React output is immediately overwritten)
  try { panicCallback?.() } catch (_) {}

  try {
    document.documentElement.innerHTML =
      '<head><meta charset="utf-8"><title></title>' +
      '<style>*{margin:0;padding:0}body{background:#fff}</style></head><body></body>'
  } catch (_) {}

  try { window.stop() } catch (_) {}

  // Prevent back button from surfacing the old URL in the address bar
  window.addEventListener('popstate', () => {
    try { window.history.replaceState({}, '', '/') } catch (_) {}
    document.title = ''
  })
}

function handlePanicKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return

  const now = Date.now()
  pressesTimes.push(now)
  pressesTimes = pressesTimes.filter(t => now - t < PANIC_WINDOW)

  if (pressesTimes.length >= PANIC_COUNT) {
    pressesTimes = []
    renderCoverPage()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', handlePanicKey, { capture: true })
}

interface PanicCallbacks {
  onPanic: () => void
}

export function usePanic(callbacks: PanicCallbacks) {
  const callbackRef = useRef(callbacks)
  useEffect(() => { callbackRef.current = callbacks })

  useEffect(() => {
    panicCallback = () => callbackRef.current.onPanic()
    return () => { panicCallback = null }
  }, [])
}
