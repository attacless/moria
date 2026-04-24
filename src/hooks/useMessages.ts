import { useState, useEffect, useCallback, useRef } from 'react'
import type { DisplayMessage, Alias } from '@/types'

const BURN_TICK_MS = 1_000  // check every second

export function useMessages() {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Start burn timer on mount, clear on unmount
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      const now = Date.now()
      setMessages(prev =>
        prev.filter(m => m.burnAt === undefined || m.burnAt > now)
      )
    }, BURN_TICK_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  const addMessage = useCallback((msg: DisplayMessage) => {
    setMessages(prev => [...prev, msg])
  }, [])

  const addMessages = useCallback((msgs: DisplayMessage[]) => {
    setMessages(prev => [...prev, ...msgs])
  }, [])

  // Zero all messages immediately — call on panic or session end
  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  // Remaining burn time in seconds for a message, or null if no burnAt
  const burnSecondsRemaining = useCallback((msg: DisplayMessage): number | null => {
    if (msg.burnAt === undefined) return null
    return Math.max(0, Math.ceil((msg.burnAt - Date.now()) / 1_000))
  }, [])

  const confirmDeadDrop = useCallback((id: string) => {
    const burnAt = Date.now() + 5 * 60 * 1_000
    setMessages(prev => prev.map(m =>
      m.id === id ? { ...m, confirmed: true, burnAt } : m
    ))
  }, [])

  const autoConfirmDeadDrops = useCallback(() => {
    const burnAt = Date.now() + 5 * 60 * 1_000
    setMessages(prev => prev.map(m =>
      m.isDeadDrop && !m.confirmed ? { ...m, confirmed: true, burnAt } : m
    ))
  }, [])

  const confirmAllDeadDrops = useCallback(() => {
    const burnAt = Date.now() + 5 * 60 * 1_000
    setMessages(prev => prev.map(m =>
      m.isDeadDrop && !m.confirmed ? { ...m, confirmed: true, burnAt } : m
    ))
  }, [])

  const removeByAlias = useCallback((alias: Alias) => {
    setMessages(prev => prev.filter(m => m.alias !== alias))
  }, [])

  const extendBurnTimers = useCallback((newBurnAt: number) => {
    setMessages(prev => prev.map(m => {
      if (m.isMine || !m.burnAt) return m
      if (m.burnAt - Date.now() > 6 * 60 * 60 * 1_000) return m
      return { ...m, burnAt: newBurnAt }
    }))
  }, [])

  const updateMessageStatus = useCallback((id: string, updates: Partial<DisplayMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m))
  }, [])

  const clearQueuedStatus = useCallback(() => {
    setMessages(prev => prev.map(m => {
      if (!m.isMine || !m.queuedStatus) return m
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { queuedStatus: _qs, queuedExpiresAt: _qe, ...rest } = m
      return rest
    }))
  }, [])

  return {
    messages,
    addMessage,
    addMessages,
    clearMessages,
    burnSecondsRemaining,
    confirmDeadDrop,
    autoConfirmDeadDrops,
    confirmAllDeadDrops,
    removeByAlias,
    extendBurnTimers,
    updateMessageStatus,
    clearQueuedStatus,
  }
}
