import { useState, useCallback, useRef, useEffect } from 'react'
import { deriveRoomId, deriveRoomKey, deriveDropId, generateIdentity } from '@/wasm'
import {
  joinChatRoom,
  leaveRoom,
  sendChatMessage,
  terminateAndLeave,
  getPeerCount,
  getRawPeerCount,
  sendRawWire,
  getPeerSessions,
} from '@transport/room'
import { startDecoyEngine, stopDecoyEngine } from '@transport/decoy'
import { publishDeadDrop, fetchDeadDrops, deleteDeadDrops } from '@transport/deadDrop'
import type { DeadDropReceipt } from '@transport/deadDrop'
import type { PublishResult } from '@transport/deadDrop'
import { roundTimestamp } from '@crypto/chacha20'
import { mountSecurityMeasures, unmountSecurityMeasures, disableCopyPrevention, enableCopyPrevention } from '@/security'
import { useMessages } from './useMessages'
import { useAlias } from './useAlias'
import type { SessionKeys, DisplayMessage, PeerId, AppScreen, Alias } from '@/types'

export function useRoom() {
  const [screen, setScreen]                 = useState<AppScreen>('entry')
  const [peerCount, setPeerCount]           = useState(0)
  const [presenceCount, setPresenceCount]   = useState(0)
  const [isJoining, setIsJoining]           = useState(false)
  const [error, setError]                   = useState<string | null>(null)
  const [showWarnDialog, setShowWarnDialog] = useState(false)
  const [warnCountdown, setWarnCountdown]   = useState(60)
  const [dropError, setDropError]           = useState<string | null>(null)
  const [rateLimited, setRateLimited]       = useState(false)
  const [roomFull, setRoomFull]             = useState(false)
  const [clipboardEnabled, setClipboardEnabled] = useState(false)
  const lastSentRef                         = useRef<number>(0)

  const sessionRef      = useRef<SessionKeys | null>(null)
  const deadDropReceipts = useRef<DeadDropReceipt[]>([])
  const { messages, addMessage, addMessages, clearMessages, burnSecondsRemaining, confirmDeadDrop, autoConfirmDeadDrops, confirmAllDeadDrops, removeByAlias, extendBurnTimers, updateMessageStatus, clearQueuedStatus } = useMessages()
  const { alias, rotateAlias } = useAlias()

  // Stable ref to messages for queued message dedup - reads latest value at setTimeout fire time
  const messagesRef = useRef<DisplayMessage[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])

  // ── Join ────────────────────────────────────────────────────────────────

  const join = useCallback(async (password: string) => {
    setIsJoining(true)
    setError(null)

    try {
      const [roomId, roomKey, dropId] = await Promise.all([
        deriveRoomId(password),
        deriveRoomKey(password),
        deriveDropId(password),
      ])

      const identity = await generateIdentity()
      const keys: SessionKeys = { roomId, dropId, roomKey, identity }
      sessionRef.current = keys

      await joinChatRoom(keys, {
        onMessage: (msg: DisplayMessage) => addMessage(msg),

        onPeerJoin: (_peerId: PeerId) => {
          setPeerCount(getPeerCount())
          autoConfirmDeadDrops()
          clearQueuedStatus()
        },

        onPeerLeave: (_peerId: PeerId) => {
          setPeerCount(getPeerCount())
          setPresenceCount(getRawPeerCount())
          extendBurnTimers(Date.now() + 6 * 60 * 60 * 1_000)
        },

        onPresenceJoin: (_peerId: PeerId) => {
          setPresenceCount(getRawPeerCount())   // raw presence - immediate
        },

        onPresenceLeave: (_peerId: PeerId) => {
          setPresenceCount(getRawPeerCount())
        },

        onTerminate: (terminatedAlias: Alias) => {
          removeByAlias(terminatedAlias)
        },

        onRoomFull: () => setRoomFull(true),
      })

      startDecoyEngine(
        (data, targets) => sendRawWire(data, targets),
        () => getPeerSessions()
      )

      setScreen('chat')
      mountSecurityMeasures()

      // Wait for WebRTC handshake window before fetching queued messages
      // so dedup has live messages in messagesRef to compare against
      setTimeout(async () => {
        if (!sessionRef.current) return  // user may have left already

        const drops = await fetchDeadDrops(
          sessionRef.current.dropId,
          sessionRef.current.roomKey
        )

        if (drops.length > 0) {
          const seen = new Set(
            messagesRef.current.map(m => `${m.alias}:${m.timestamp}:${m.body}`)
          )

          const dropMessages: DisplayMessage[] = drops
            .filter(d => !seen.has(`${d.alias}:${d.timestamp}:${d.body}`))
            .map(d => ({
              id:         crypto.randomUUID(),
              alias:      d.alias,
              timestamp:  d.timestamp,
              body:       d.body,
              isMine:     false,
              isDeadDrop: true,
              confirmed:  false,
              // No burnAt yet - starts only when MARK READ pressed or peer joins
            }))

          if (dropMessages.length > 0) addMessages(dropMessages)
        }
      }, 1_500)

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join room')
      sessionRef.current = null
    } finally {
      setIsJoining(false)
    }
  }, [addMessage, addMessages, autoConfirmDeadDrops, clearQueuedStatus, extendBurnTimers, removeByAlias])

  // ── Send ─────────────────────────────────────────────────────────────────

  const send = useCallback(async (body: string) => {
    const now = Date.now()
    if (now - lastSentRef.current < 1_000) {
      setRateLimited(true)
      setTimeout(() => setRateLimited(false), 1_500)
      return
    }
    lastSentRef.current = now

    const display = sendChatMessage(body, alias, alias)
    if (display) {
      addMessage(display)
      return
    }

    // No peers online - queue message on Nostr relay
    const keys = sessionRef.current
    if (!keys) return

    // Optimistic message - shows "sending..." immediately
    const optimisticId = crypto.randomUUID()
    addMessage({
      id:           optimisticId,
      alias,
      timestamp:    roundTimestamp(Date.now()),
      body,
      isMine:       true,
      isDeadDrop:   true,
      queuedStatus: 'sending',
    })

    const result: PublishResult = await publishDeadDrop(body, alias, keys.dropId, keys.roomKey)

    if (!result.success) {
      updateMessageStatus(optimisticId, { queuedStatus: 'failed' })
      const msg = result.reason === 'rate_limited'
        ? 'slow down - wait a moment before queuing again'
        : result.reason === 'no_relays'
          ? 'no relays reachable - message not queued'
          : result.reason === 'too_large'
            ? 'message too large to queue'
            : 'queue failed - try again'
      setDropError(msg)
      return
    }

    if (result.receipt) {
      updateMessageStatus(optimisticId, {
        queuedStatus:    'queued',
        queuedExpiresAt: result.receipt.expiresAt,
        burnAt:          result.receipt.expiresAt,
        confirmed:       true,
      })
      deadDropReceipts.current.push(result.receipt)
    }
  }, [alias, addMessage, updateMessageStatus])

  // ── Leave ────────────────────────────────────────────────────────────────

  const leave = useCallback(() => {
    deadDropReceipts.current.forEach(r => r.sk.fill(0))
    deadDropReceipts.current = []
    stopDecoyEngine()
    leaveRoom()
    rotateAlias()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setClipboardEnabled(false)
    enableCopyPrevention()
    sessionRef.current = null
    unmountSecurityMeasures()
    setScreen('entry')
  }, [clearMessages, rotateAlias])

  // ── Terminate ────────────────────────────────────────────────────────────

  const terminate = useCallback(async () => {
    const keys     = sessionRef.current
    const receipts = deadDropReceipts.current
    deadDropReceipts.current = []

    // Fire NIP-09 deletion concurrently with local teardown
    const deletionPromise = keys && receipts.length > 0
      ? deleteDeadDrops(receipts, keys.dropId).catch(() => {
          receipts.forEach(r => r.sk.fill(0))
        })
      : Promise.resolve()

    stopDecoyEngine()
    terminateAndLeave(alias)
    rotateAlias()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setClipboardEnabled(false)
    enableCopyPrevention()
    sessionRef.current = null
    unmountSecurityMeasures()
    setScreen('entry')

    await deletionPromise
  }, [alias, clearMessages, rotateAlias])

  // ── Panic ────────────────────────────────────────────────────────────────

  const panic = useCallback(() => {
    deadDropReceipts.current.forEach(r => r.sk.fill(0))
    deadDropReceipts.current = []
    stopDecoyEngine()
    leaveRoom()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setClipboardEnabled(false)
    sessionRef.current = null
    // rotateAlias() is intentionally omitted here. document.open() in usePanic
    // destroys the React tree before any state update can flush. Alias
    // unlinkability on the next session is guaranteed by useAlias calling
    // useState(generateAlias) - the initializer runs fresh on every mount.
    setScreen('entry')
  }, [clearMessages])

  const clearDropError = useCallback(() => setDropError(null), [])

  const toggleClipboard = useCallback(() => {
    setClipboardEnabled(prev => {
      const next = !prev
      if (next) disableCopyPrevention()
      else      enableCopyPrevention()
      return next
    })
  }, [])

  // ── Inactivity callbacks ──────────────────────────────────────────────────

  useEffect(() => {
    if (!showWarnDialog) { setWarnCountdown(60); return }
    const interval = setInterval(() => {
      setWarnCountdown(s => Math.max(0, s - 1))
    }, 1_000)
    return () => clearInterval(interval)
  }, [showWarnDialog])

  const onWarn = useCallback(() => setShowWarnDialog(true), [])
  const onDisconnect = useCallback(() => leave(), [leave])

  // Simulate user activity to reset the inactivity timer (now owned by App.tsx)
  const dismissWarn = useCallback(() => {
    setShowWarnDialog(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
  }, [])

  return {
    screen,
    messages,
    alias,
    peerCount,
    presenceCount,
    isJoining,
    error,
    showWarnDialog,
    dismissWarn,
    join,
    send,
    leave,
    panic,
    onWarn,
    onDisconnect,
    burnSecondsRemaining,
    warnCountdown,
    sessionKeys: sessionRef.current,
    dropError,
    clearDropError,
    confirmDeadDrop,
    confirmAllDeadDrops,
    terminate,
    rateLimited,
    roomFull,
    clipboardEnabled,
    toggleClipboard,
  }
}
