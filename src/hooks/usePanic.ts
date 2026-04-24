import { useEffect, useRef } from 'react'
import { leaveRoom } from '@transport/room'
import { stopDecoyEngine } from '@transport/decoy'
import { unmountSecurityMeasures } from '@/security'

const PANIC_COUNT  = 3
const PANIC_WINDOW = 1_500

let panicCallback: (() => void) | null = null
let pressesTimes:  number[]            = []

function renderCoverPage(): void {
  // Wipe all storage first
  try { sessionStorage.clear() } catch (_) {}
  try { localStorage.clear()   } catch (_) {}

  // Zero crypto
  try { stopDecoyEngine() } catch (_) {}
  try { leaveRoom()       } catch (_) {}

  // Remove security listeners before DOM replacement
  try { unmountSecurityMeasures() } catch (_) {}

  // Notify React to clear state (no screen change — DOM replacement
  // happens after this so React output is immediately overwritten)
  try { panicCallback?.() } catch (_) {}

  // Replace entire document with a convincing neutral cover.
  // No navigation = no activation requirement, no CSP, no browser block.
  document.open()
  document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New Tab</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{
    width:100%;height:100%;
    background:#1c1c1e;
    display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  }
</style>
</head>
<body></body>
</html>`)
  document.close()

  // Push a new history entry so back button does not restore session
  try { history.pushState(null, '', 'about:blank') } catch (_) {}
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
