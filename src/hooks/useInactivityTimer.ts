import { useEffect, useRef, useCallback } from 'react'

const WARN_MS       = 4 * 60 * 1_000   // 4 minutes
const DISCONNECT_MS = 5 * 60 * 1_000   // 5 minutes

const TEST_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('inactivity')

const EFFECTIVE_WARN_MS       = TEST_MODE ? 10_000  : WARN_MS
const EFFECTIVE_DISCONNECT_MS = TEST_MODE ? 12_000  : DISCONNECT_MS

const EVENTS = ['keydown', 'pointermove', 'scroll'] as const

interface InactivityCallbacks {
  onWarn:       () => void
  onDisconnect: () => void
}

export function useInactivityTimer(
  active: boolean,
  callbacks: InactivityCallbacks
) {
  const warnTimer       = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbacksRef    = useRef(callbacks)

  useEffect(() => { callbacksRef.current = callbacks })

  const reset = useCallback(() => {
    if (warnTimer.current)       clearTimeout(warnTimer.current)
    if (disconnectTimer.current) clearTimeout(disconnectTimer.current)

    warnTimer.current = setTimeout(
      () => callbacksRef.current.onWarn(),
      EFFECTIVE_WARN_MS
    )

    disconnectTimer.current = setTimeout(
      () => callbacksRef.current.onDisconnect(),
      EFFECTIVE_DISCONNECT_MS
    )
  }, [])

  useEffect(() => {
    if (!active) {
      if (warnTimer.current)       clearTimeout(warnTimer.current)
      if (disconnectTimer.current) clearTimeout(disconnectTimer.current)
      return
    }

    EVENTS.forEach(e => window.addEventListener(e, reset, { passive: true }))
    reset()

    return () => {
      EVENTS.forEach(e => window.removeEventListener(e, reset))
      if (warnTimer.current)       clearTimeout(warnTimer.current)
      if (disconnectTimer.current) clearTimeout(disconnectTimer.current)
    }
  }, [active, reset])

  return { resetTimer: reset }
}
