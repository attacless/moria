import { useState, useCallback, useRef, useEffect } from 'react'
import { deriveRoomId, deriveRoomKey, deriveDropId, deriveDropSigningKey, generateIdentity } from '@/wasm'
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
import { webRTCAvailable } from '@/capabilities'
import { publishDeadDrop, fetchDeadDrops, deleteAllDeadDrops, publishPoisonEvent } from '@transport/deadDrop'
import { resetPeerColors } from '@/utils/peerColors'
import type { DeadDropReceipt } from '@transport/deadDrop'
import type { PublishResult } from '@transport/deadDrop'
import { roundTimestamp } from '@crypto/chacha20'
import { mountSecurityMeasures, unmountSecurityMeasures, disableCopyPrevention, enableCopyPrevention } from '@/security'
import { useMessages } from './useMessages'
import { useAlias } from './useAlias'
import type { SessionKeys, DisplayMessage, PeerId, AppScreen, Alias } from '@/types'

// ── Duress helpers ────────────────────────────────────────────────────────────

const DECOY_TEMPLATES = [
  'sounds good',
  'can we talk later?',
  'just got your message',
  'ok',
  'when are you free?',
  'got it',
  'let me know',
  'makes sense',
  'sure, works for me',
  'on my way',
]

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

function generateDecoyMessages(roomKey: Uint8Array, myAlias: Alias): DisplayMessage[] {
  const seed = (roomKey[0]! | (roomKey[1]! << 8) | (roomKey[2]! << 16) | (roomKey[3]! << 24)) >>> 0
  const rand = xorshift32(seed)

  // Deterministic peer alias derived from PRNG (realistic 8-char hex)
  const peerAlias = Array.from({ length: 4 }, () => Math.floor(rand() * 256))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  const count = 3 + Math.floor(rand() * 4)   // 3-6 messages
  const now   = Date.now()
  const msgs: DisplayMessage[] = []

  for (let i = 0; i < count; i++) {
    const idx    = Math.floor(rand() * DECOY_TEMPLATES.length)
    const ageMs  = Math.floor(rand() * 6 * 60 * 60 * 1_000)
    const isMine = rand() < 0.4

    msgs.push({
      id:        crypto.randomUUID(),
      alias:     isMine ? myAlias : peerAlias,
      timestamp: roundTimestamp(now - ageMs),
      body:      DECOY_TEMPLATES[idx % DECOY_TEMPLATES.length]!,
      isMine,
    })
  }

  return msgs.sort((a, b) => a.timestamp - b.timestamp)
}

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
  const [duressDetected, setDuressDetected]     = useState(false)
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
      const isDuress   = password.startsWith('@')
      const realSecret = isDuress ? password.slice(1) : password

      // Derive keys for the real room (duress: stripped secret; normal: full password)
      const [roomId, roomKey, dropId, signingKey] = await Promise.all([
        deriveRoomId(realSecret),
        deriveRoomKey(realSecret),
        deriveDropId(realSecret),
        deriveDropSigningKey(realSecret),
      ])

      // Shared WebRTC callbacks - same shape for both normal and decoy rooms
      const roomCallbacks = {
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
      }

      // ── Duress path ───────────────────────────────────────────────────────
      if (isDuress) {
        // 1. Publish poison event to the real drop (5s timeout, best-effort).
        //    Signed with the real signing key so it authenticates correctly.
        //    Dead drops are intentionally NOT deleted - the other party needs
        //    to read them before deciding to TERMINATE.
        await Promise.race([
          publishPoisonEvent(dropId, roomKey, signingKey),
          new Promise<void>(r => setTimeout(r, 5_000)),
        ])

        // 2. Zero all real key material so it never reaches the decoy session.
        roomKey.fill(0)
        signingKey.fill(0)

        // 3. Derive decoy keys from the FULL @password (different key space).
        const [decoyRoomId, decoyRoomKey, decoyDropId, decoySigningKey] = await Promise.all([
          deriveRoomId(password),
          deriveRoomKey(password),
          deriveDropId(password),
          deriveDropSigningKey(password),
        ])

        const decoyIdentity = await generateIdentity()
        const decoyKeys: SessionKeys = {
          roomId:      decoyRoomId,
          dropId:      decoyDropId,
          roomKey:     decoyRoomKey,
          signingKey:  decoySigningKey,
          identity:    decoyIdentity,
        }
        sessionRef.current = decoyKeys

        // 4. Generate deterministic decoy message history from room key PRNG.
        const decoyMsgs = generateDecoyMessages(decoyRoomKey, alias)

        // WebRTC-dependent path - same guard as normal join.
        if (webRTCAvailable) {
          await joinChatRoom(decoyKeys, roomCallbacks)
          startDecoyEngine(
            (data, targets) => sendRawWire(data, targets),
            () => getPeerSessions()
          )
        }

        setScreen('chat')
        mountSecurityMeasures()

        // 5. Inject decoy history after short stagger (looks like prior session).
        setTimeout(() => {
          if (!sessionRef.current) return
          addMessages(decoyMsgs)
        }, 800)

        return
      }

      // ── Normal join ───────────────────────────────────────────────────────
      const identity = await generateIdentity()
      const keys: SessionKeys = { roomId, dropId, roomKey, signingKey, identity }
      sessionRef.current = keys

      // WebRTC-dependent path: live chat, presence, decoy engine.
      // Skipped on browsers without WebRTC (iOS Lockdown Mode, Tor Browser).
      // Dead drop mode works without WebRTC - Nostr relay comms are independent.
      if (webRTCAvailable) {
        await joinChatRoom(keys, roomCallbacks)
        startDecoyEngine(
          (data, targets) => sendRawWire(data, targets),
          () => getPeerSessions()
        )
      }

      setScreen('chat')
      mountSecurityMeasures()

      // Fetch queued dead drops after a short window so the dedup set
      // includes any live messages that arrived via WebRTC during handshake.
      // Dead drop polling is independent of peer connection - it always runs.
      setTimeout(async () => {
        if (!sessionRef.current) return  // user may have left already

        const drops = await fetchDeadDrops(
          sessionRef.current.dropId,
          sessionRef.current.roomKey
        )

        if (drops.length > 0) {
          // Check for duress signal before rendering any drops.
          const hasPoison = drops.some(d => d.type === 'DURESS')
          if (hasPoison) setDuressDetected(true)

          const seen = new Set(
            messagesRef.current.map(m => `${m.alias}:${m.timestamp}:${m.body}`)
          )

          const dropMessages: DisplayMessage[] = drops
            .filter(d => d.type !== 'DURESS')
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

          if (dropMessages.length > 0) {
            addMessages(dropMessages)
            // Peers may have connected during the relay fetch window.
            // autoConfirmDeadDrops() fired on peer join but before these
            // messages existed - call it again so burn timers start immediately.
            if (getPeerCount() > 0) autoConfirmDeadDrops()
          }
        }
      }, 1_500)

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join room')
      sessionRef.current = null
    } finally {
      setIsJoining(false)
    }
  }, [addMessage, addMessages, autoConfirmDeadDrops, clearQueuedStatus, extendBurnTimers, removeByAlias, alias])

  // ── Send ─────────────────────────────────────────────────────────────────

  const send = useCallback(async (body: string, ttlSeconds: number = 86_400) => {
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

    const result: PublishResult = await publishDeadDrop(body, alias, keys.dropId, keys.roomKey, keys.signingKey, ttlSeconds)

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
    deadDropReceipts.current = []
    sessionRef.current?.signingKey.fill(0)
    stopDecoyEngine()
    leaveRoom()
    resetPeerColors()
    rotateAlias()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setClipboardEnabled(false)
    setDuressDetected(false)
    enableCopyPrevention()
    sessionRef.current = null
    unmountSecurityMeasures()
    setScreen('entry')
  }, [clearMessages, rotateAlias])

  // ── Terminate ────────────────────────────────────────────────────────────

  const terminate = useCallback(async () => {
    const keys = sessionRef.current
    deadDropReceipts.current = []

    // Fire NIP-09 deletion for ALL drop events - cross-session capable.
    // Signing key zeroed in finally() regardless of success or failure.
    const deletionPromise = keys
      ? deleteAllDeadDrops(keys.dropId, keys.signingKey)
          .catch(() => {})
          .finally(() => { keys.signingKey.fill(0) })
      : Promise.resolve()

    stopDecoyEngine()
    terminateAndLeave(alias)
    resetPeerColors()
    rotateAlias()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setClipboardEnabled(false)
    setDuressDetected(false)
    enableCopyPrevention()
    sessionRef.current = null
    unmountSecurityMeasures()
    setScreen('entry')

    await deletionPromise
  }, [alias, clearMessages, rotateAlias])

  // ── Panic ────────────────────────────────────────────────────────────────

  const panic = useCallback(() => {
    deadDropReceipts.current = []
    sessionRef.current?.signingKey.fill(0)
    stopDecoyEngine()
    leaveRoom()
    resetPeerColors()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setClipboardEnabled(false)
    setDuressDetected(false)
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
    duressDetected,
  }
}
