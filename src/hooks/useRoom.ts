import { useState, useCallback, useRef, useEffect } from 'react'
import { deriveRoomId, deriveRoomKey, deriveDropId, deriveDropSigningKey, generateIdentity } from '@/wasm'
import {
  joinChatRoom,
  leaveRoom,
  sendChatMessage,
  sendTypingIndicator,
  sendWireMessage,
  terminateAndLeave,
  getPeerCount,
  getRawPeerCount,
  sendRawWire,
  getPeerSessions,
  getPerPeerWatchwords,
  broadcastDeadManArmed,
  broadcastDeadManCancelled,
} from '@transport/room'
import { startDecoyEngine, stopDecoyEngine } from '@transport/decoy'
import { webRTCAvailable } from '@/capabilities'
import { publishDeadDrop, fetchDeadDrops, fetchDeadManEvents, deleteDeadDrops, deleteAllDeadDrops, publishPoisonEvent } from '@transport/deadDrop'
import { resetPeerColors } from '@/utils/peerColors'
import type { DeadDropReceipt } from '@transport/deadDrop'
import type { PublishResult } from '@transport/deadDrop'
import { roundTimestamp } from '@crypto/chacha20'
import { mountSecurityMeasures, unmountSecurityMeasures, enableCopyPrevention } from '@/security'
import { chunkImage, reassembleImage, IMAGE_MAX_BYTES } from '@/utils/imageChunker'
import { useMessages } from './useMessages'
import { useAlias } from './useAlias'
import type { SessionKeys, DisplayMessage, PendingDeadMan, PeerId, AppScreen, Alias, ReplyTo } from '@/types'

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
  const [duressDetected, setDuressDetected]       = useState(false)
  const [pendingDeadMans, setPendingDeadMans]     = useState<PendingDeadMan[]>([])
  const lastSentRef                         = useRef<number>(0)
  const lastTypingRef                       = useRef<number>(0)

  const [typingAliases, setTypingAliases]   = useState<Alias[]>([])
  const typingTimers                        = useRef<Map<Alias, ReturnType<typeof setTimeout>>>(new Map())

  const sessionRef       = useRef<SessionKeys | null>(null)
  const deadDropReceipts = useRef<DeadDropReceipt[]>([])
  const pollIntervalRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadManPollRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  // Tracks every dead drop ever displayed this session (alias:timestamp:body).
  // Outlives the burn lifecycle so polls never re-display a burned message.
  // Cleared on leave/terminate/panic alongside other session state.
  const seenDropIds      = useRef<Set<string>>(new Set())
  // Image reassembly buffer: imageId -> partial chunk state + 30s cleanup timer
  const imageChunkBuffer = useRef<Map<string, {
    chunks:      Map<number, string>
    totalChunks: number
    mimeType:    string
    timer:       ReturnType<typeof setTimeout>
  }>>(new Map())
  // All object URLs created this session - revoked on leave/terminate/panic
  const imageObjectUrls  = useRef<Set<string>>(new Set())
  const { messages, addMessage, addMessages, clearMessages, burnSecondsRemaining, confirmDeadDrop, autoConfirmDeadDrops, confirmAllDeadDrops, extendBurnTimers, updateMessageStatus, clearQueuedStatus } = useMessages()
  const { alias, rotateAlias } = useAlias()

  // Stable ref to messages for queued message dedup - reads latest value at setTimeout fire time
  const messagesRef = useRef<DisplayMessage[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])

  // ── Fetch + dedup dead drops ─────────────────────────────────────────────
  // Shared by the initial join fetch and the periodic poll.
  // Deduplicates against the current message list using alias:timestamp:body.

  const fetchAndAddDrops = useCallback(async () => {
    const keys = sessionRef.current
    if (!keys) return

    const drops = await fetchDeadDrops(keys.dropId, keys.roomKey)

    // null means the fetch was skipped (rate-limited or no relays reachable).
    // Do not reconcile state against a skipped fetch - the relay was not queried.
    if (drops === null) return

    const nowSecs = Math.floor(Date.now() / 1000)

    const hasPoison = drops.some(d => d.type === 'DURESS')
    if (hasPoison) setDuressDetected(true)

    // Relay is the source of truth for armed dead man switches.
    // Replace local state with exactly what the relay returned (armed, not yet expired).
    // If the relay returns no pending switches, all local entries are cleared -
    // this reconciles cancellations made by other clients since the last poll.
    const pendingDrops = drops.filter(
      d => d.type === 'DEADMAN' && d.activateAfter && d.activateAfter > nowSecs
    )
    setPendingDeadMans(pendingDrops.map(d => ({
      eventId:    d.eventId,
      alias:      d.alias,
      timestamp:  d.timestamp * 1000,     // store as Unix ms for consistency
      activateAt: d.activateAfter!,
      body:       d.body,
      ...(d.tokenHash ? { tokenHash: d.tokenHash } : {}),
    })))

    // Nothing to add to the message list - reconciliation above is the only work.
    if (drops.length === 0) return

    // All other drops (TEXT, activated DEADMAN, etc.) go through the normal pipeline.
    // An activated DEADMAN (activateAfter <= now) passes through here and is displayed
    // as a message. It is also removed from pendingDeadMans by the setPendingDeadMans
    // call above (since it no longer matches activateAfter > nowSecs).
    const newDrops = drops
      .filter(d => d.type !== 'DURESS')
      .filter(d => !(d.type === 'DEADMAN' && d.activateAfter && d.activateAfter > nowSecs))
      .filter(d => !seenDropIds.current.has(`${d.alias}:${d.timestamp}:${d.body}`))

    if (newDrops.length === 0) return

    // Mark as seen before adding to prevent double-display on rapid polls.
    newDrops.forEach(d => seenDropIds.current.add(`${d.alias}:${d.timestamp}:${d.body}`))

    const dropMessages: DisplayMessage[] = newDrops.map(d => ({
      id:         crypto.randomUUID(),
      alias:      d.alias,
      timestamp:  d.timestamp,
      body:       d.body,
      isMine:     false,
      isDeadDrop: true,
      confirmed:  false,
      ...(d.type === 'DEADMAN' ? { isDeadMan: true } : {}),
    }))

    addMessages(dropMessages)
    if (getPeerCount() > 0) autoConfirmDeadDrops()
  }, [addMessages, autoConfirmDeadDrops])

  // ── Dead man state reconciliation ────────────────────────────────────────
  // Runs every 30s regardless of peerCount. Fetches DEADMAN events from the
  // relay and reconciles pendingDeadMans against the relay's source of truth.
  // Uses an independent rate limiter (fetchDeadManEvents) so it never conflicts
  // with the message poll (fetchAndAddDrops / fetchDeadDrops).

  const fetchDeadManState = useCallback(async () => {
    const keys = sessionRef.current
    if (!keys) return

    const events = await fetchDeadManEvents(keys.dropId, keys.roomKey)
    if (events === null) return  // skipped (rate-limited or no relays)

    const nowSecs = Math.floor(Date.now() / 1000)
    const relayArmedIds = new Set(
      events
        .filter(e => e.activateAfter && e.activateAfter > nowSecs)
        .map(e => e.eventId)
    )

    setPendingDeadMans(prev => {
      // Remove entries no longer on relay (cancelled by another client or expired)
      const kept   = prev.filter(dm => relayArmedIds.has(dm.eventId))
      const keptIds = new Set(kept.map(dm => dm.eventId))
      // Add entries the relay has that are not yet in local state
      const added = events
        .filter(e => e.activateAfter && e.activateAfter > nowSecs && !keptIds.has(e.eventId))
        .map(e => ({
          eventId:    e.eventId,
          alias:      e.alias,
          timestamp:  e.timestamp * 1000,
          activateAt: e.activateAfter!,
          body:       e.body,
          ...(e.tokenHash ? { tokenHash: e.tokenHash } : {}),
        }))
      return [...kept, ...added]
    })
  }, [])

  const handleTypingPeer = useCallback((peerAlias: Alias) => {
    const existing = typingTimers.current.get(peerAlias)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      typingTimers.current.delete(peerAlias)
      setTypingAliases(prev => prev.filter(a => a !== peerAlias))
    }, 4_000)
    typingTimers.current.set(peerAlias, timer)
    setTypingAliases(prev => prev.includes(peerAlias) ? prev : [...prev, peerAlias])
  }, [])

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
          const remaining = getPeerCount()
          setPeerCount(remaining)
          setPresenceCount(getRawPeerCount())
          extendBurnTimers(Date.now() + 6 * 60 * 60 * 1_000)
        },

        onPresenceJoin: (_peerId: PeerId) => {
          setPresenceCount(getRawPeerCount())   // raw presence - immediate
        },

        onPresenceLeave: (_peerId: PeerId) => {
          setPresenceCount(getRawPeerCount())
        },

        onTerminate: (_terminatedAlias: Alias) => {
          if (pollIntervalRef.current)  { clearInterval(pollIntervalRef.current);  pollIntervalRef.current  = null }
          if (deadManPollRef.current)   { clearInterval(deadManPollRef.current);   deadManPollRef.current   = null }
          seenDropIds.current.clear()
          deadDropReceipts.current = []
          typingTimers.current.forEach(t => clearTimeout(t))
          typingTimers.current.clear()
          imageChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
          imageChunkBuffer.current.clear()
          imageObjectUrls.current.forEach(url => URL.revokeObjectURL(url))
          imageObjectUrls.current.clear()
          stopDecoyEngine()
          leaveRoom()
          resetPeerColors()
          rotateAlias()
          clearMessages()
          setPeerCount(0)
          setPresenceCount(0)
          setRoomFull(false)
          setDuressDetected(false)
          setTypingAliases([])
          setPendingDeadMans([])
          sessionRef.current?.signingKey.fill(0)
          sessionRef.current = null
          enableCopyPrevention()
          unmountSecurityMeasures()
          setScreen('entry')
        },

        onRoomFull:     () => setRoomFull(true),
        onTyping:       (peerAlias: Alias) => handleTypingPeer(peerAlias),

        // Instant P2P notification when a peer arms a dead man switch.
        // The relay poll provides the same data for peers who join later.
        onDeadManArmed: (eventId: string, activateAfter: number, tokenHash: string | undefined, peerAlias: Alias, timestamp: number) => {
          setPendingDeadMans(prev => {
            if (prev.some(dm => dm.eventId === eventId)) return prev  // already known
            return [...prev, {
              eventId,
              alias:     peerAlias,
              timestamp,                // already in ms (WireMessage timestamps are ms)
              activateAt: activateAfter,
              body:       '',           // not transmitted over P2P; shown only on activation
              ...(tokenHash ? { tokenHash } : {}),
            }]
          })
        },

        // Instant P2P notification when a peer cancels a dead man switch.
        onDeadManCancelled: (eventId: string) => {
          setPendingDeadMans(prev => prev.filter(d => d.eventId !== eventId))
        },

        onImageChunk: (imageId: string, chunkIndex: number, totalChunks: number, imageData: string, mimeType: string, peerAlias: Alias) => {
          let entry = imageChunkBuffer.current.get(imageId)
          if (!entry) {
            const timer = setTimeout(() => {
              imageChunkBuffer.current.delete(imageId)
            }, 30_000)
            entry = { chunks: new Map(), totalChunks, mimeType: '', timer }
            imageChunkBuffer.current.set(imageId, entry)
          }
          entry.chunks.set(chunkIndex, imageData)
          if (mimeType) entry.mimeType = mimeType  // only chunk 0 carries this

          if (entry.chunks.size === entry.totalChunks) {
            clearTimeout(entry.timer)
            imageChunkBuffer.current.delete(imageId)
            const url = reassembleImage(entry.chunks, entry.mimeType || 'image/jpeg')
            imageObjectUrls.current.add(url)
            addMessage({
              id:        crypto.randomUUID(),
              alias:     peerAlias,
              timestamp: roundTimestamp(Date.now()),
              body:      '',
              isMine:    false,
              burnAt:    Date.now() + 5 * 60 * 1_000,
              imageUrl:  url,
            })
          }
        },
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
      setTimeout(() => { fetchAndAddDrops() }, 1_500)

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join room')
      sessionRef.current = null
    } finally {
      setIsJoining(false)
    }
  }, [addMessage, addMessages, autoConfirmDeadDrops, clearQueuedStatus, extendBurnTimers, clearMessages, rotateAlias, alias, fetchAndAddDrops])

  // ── Send ─────────────────────────────────────────────────────────────────

  const send = useCallback(async (body: string, ttlSeconds: number = 86_400, replyTo?: ReplyTo) => {
    const now = Date.now()
    if (now - lastSentRef.current < 1_000) {
      setRateLimited(true)
      setTimeout(() => setRateLimited(false), 1_500)
      return
    }
    lastSentRef.current = now

    const display = sendChatMessage(body, alias, alias, replyTo)
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
      ...(replyTo ? { replyTo } : {}),
    })

    // Capture the timestamp synchronously before the async publish call.
    // publishDeadDrop uses roundTimestamp(Date.now()) at its entry point
    // (before any awaits), so this value is in the same 60s bucket.
    const publishedTimestamp = roundTimestamp(Date.now())

    const result: PublishResult = await publishDeadDrop(body, alias, keys.dropId, keys.roomKey, keys.signingKey, ttlSeconds, replyTo)

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

    // Prevent the poll from re-displaying this own message as a received drop.
    seenDropIds.current.add(`${alias}:${publishedTimestamp}:${body}`)

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

  // ── Dead man's switch ────────────────────────────────────────────────────

  const armDeadMan = useCallback(async (body: string, activateSeconds: number, tokenHash: string): Promise<boolean> => {
    const keys = sessionRef.current
    if (!keys) return false

    const activateAfter  = Math.floor(Date.now() / 1000) + activateSeconds
    // TTL: hold the relay event for the full activation window plus 24h buffer
    // so the recipient can still fetch it after it activates.
    const ttlSeconds     = activateSeconds + 86_400

    // Capture the timestamp before the async call so seenDropIds uses the same bucket.
    const publishedTimestamp = roundTimestamp(Date.now())

    const result = await publishDeadDrop(
      body,
      alias,
      keys.dropId,
      keys.roomKey,
      keys.signingKey,
      ttlSeconds,
      undefined,
      activateAfter,
      tokenHash,
    )

    if (result.success) {
      // Prevent sender from seeing their own switch as a received activated message.
      seenDropIds.current.add(`${alias}:${publishedTimestamp}:${body}`)

      // Show the pending strip immediately - no need to wait for the next poll cycle.
      if (result.receipt) {
        setPendingDeadMans(prev => [...prev, {
          eventId:    result.receipt!.eventId,
          alias,
          timestamp:  Date.now(),
          activateAt: activateAfter,
          body,
          tokenHash,
        }])

        // Notify connected peers instantly over P2P.
        // Peers who join later learn about the switch via the relay poll.
        broadcastDeadManArmed(
          result.receipt.eventId,
          activateAfter,
          tokenHash,
          alias,
          publishedTimestamp,
        )
      }
    }

    return result.success
  }, [alias])

  const cancelDeadMan = useCallback(async (eventId: string): Promise<void> => {
    const keys = sessionRef.current
    if (!keys) return
    try {
      await deleteDeadDrops([{ eventId, expiresAt: 0 }], keys.dropId, keys.signingKey)
    } catch {}
    // Notify connected peers instantly; relay poll reconciles for peers not online.
    broadcastDeadManCancelled(eventId, alias)
    setPendingDeadMans(prev => prev.filter(d => d.eventId !== eventId))
  }, [alias])

  // ── Image send ──────────────────────────────────────────────────────────

  const sendImage = useCallback(async (file: File): Promise<void> => {
    if (file.size > IMAGE_MAX_BYTES) return
    if (getPeerCount() === 0) return

    const { imageId, mimeType, chunks } = await chunkImage(file)
    const totalChunks = chunks.length
    const ts = roundTimestamp(Date.now())

    for (let i = 0; i < chunks.length; i++) {
      sendWireMessage({
        type:        'IMAGE_CHUNK',
        alias,
        timestamp:   ts,
        body:        '',
        imageId,
        chunkIndex:  i,
        totalChunks,
        imageData:   chunks[i]!,
        ...(i === 0 ? { mimeType } : {}),
      })
    }

    // Show sender's own image immediately via object URL from the original File
    const url = URL.createObjectURL(file)
    imageObjectUrls.current.add(url)
    addMessage({
      id:        crypto.randomUUID(),
      alias,
      timestamp: ts,
      body:      '',
      isMine:    true,
      burnAt:    Date.now() + 5 * 60 * 1_000,
      imageUrl:  url,
    })
  }, [alias, addMessage])

  // ── Leave ────────────────────────────────────────────────────────────────

  const leave = useCallback(() => {
    if (pollIntervalRef.current)  { clearInterval(pollIntervalRef.current);  pollIntervalRef.current  = null }
    if (deadManPollRef.current)   { clearInterval(deadManPollRef.current);   deadManPollRef.current   = null }
    seenDropIds.current.clear()
    deadDropReceipts.current = []
    sessionRef.current?.signingKey.fill(0)
    typingTimers.current.forEach(t => clearTimeout(t))
    typingTimers.current.clear()
    imageChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    imageChunkBuffer.current.clear()
    imageObjectUrls.current.forEach(url => URL.revokeObjectURL(url))
    imageObjectUrls.current.clear()
    stopDecoyEngine()
    leaveRoom()
    resetPeerColors()
    rotateAlias()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setDuressDetected(false)
    setTypingAliases([])
    setPendingDeadMans([])
    enableCopyPrevention()
    sessionRef.current = null
    unmountSecurityMeasures()
    setScreen('entry')
  }, [clearMessages, rotateAlias])

  // ── Terminate ────────────────────────────────────────────────────────────

  const terminate = useCallback(async () => {
    if (pollIntervalRef.current)  { clearInterval(pollIntervalRef.current);  pollIntervalRef.current  = null }
    if (deadManPollRef.current)   { clearInterval(deadManPollRef.current);   deadManPollRef.current   = null }
    seenDropIds.current.clear()
    const keys = sessionRef.current
    deadDropReceipts.current = []
    typingTimers.current.forEach(t => clearTimeout(t))
    typingTimers.current.clear()
    imageChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    imageChunkBuffer.current.clear()
    imageObjectUrls.current.forEach(url => URL.revokeObjectURL(url))
    imageObjectUrls.current.clear()

    // Fire NIP-09 deletion for ALL drop events - cross-session capable.
    // Signing key zeroed in finally() regardless of success or failure.
    // roomKey is copied before terminateAndLeave() runs because leaveRoom()
    // inside terminateAndLeave() zeroes the original Uint8Array in place.
    // The copy is used only for decryption inside deleteAllDeadDrops and is
    // garbage collected once the promise resolves.
    const roomKeyCopy = keys ? new Uint8Array(keys.roomKey) : null
    const deletionPromise = keys && roomKeyCopy
      ? deleteAllDeadDrops(keys.dropId, roomKeyCopy, keys.signingKey)
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
    setDuressDetected(false)
    setTypingAliases([])
    setPendingDeadMans([])
    enableCopyPrevention()
    sessionRef.current = null
    unmountSecurityMeasures()
    setScreen('entry')

    await deletionPromise
  }, [alias, clearMessages, rotateAlias])

  // ── Panic ────────────────────────────────────────────────────────────────

  const panic = useCallback(() => {
    if (pollIntervalRef.current)  { clearInterval(pollIntervalRef.current);  pollIntervalRef.current  = null }
    if (deadManPollRef.current)   { clearInterval(deadManPollRef.current);   deadManPollRef.current   = null }
    seenDropIds.current.clear()
    deadDropReceipts.current = []
    sessionRef.current?.signingKey.fill(0)
    typingTimers.current.forEach(t => clearTimeout(t))
    typingTimers.current.clear()
    imageChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    imageChunkBuffer.current.clear()
    imageObjectUrls.current.forEach(url => URL.revokeObjectURL(url))
    imageObjectUrls.current.clear()
    stopDecoyEngine()
    leaveRoom()
    resetPeerColors()
    clearMessages()
    setPeerCount(0)
    setPresenceCount(0)
    setRoomFull(false)
    setDuressDetected(false)
    setTypingAliases([])
    setPendingDeadMans([])
    sessionRef.current = null
    // rotateAlias() is intentionally omitted here. document.open() in usePanic
    // destroys the React tree before any state update can flush. Alias
    // unlinkability on the next session is guaranteed by useAlias calling
    // useState(generateAlias) - the initializer runs fresh on every mount.
    setScreen('entry')
  }, [clearMessages])

  const clearDropError = useCallback(() => setDropError(null), [])

  const sendTyping = useCallback(() => {
    if (getPeerCount() === 0) return
    const now = Date.now()
    if (now - lastTypingRef.current < 3_000) return
    lastTypingRef.current = now
    sendTypingIndicator(alias)
  }, [alias])


  // ── Dead drop polling ─────────────────────────────────────────────────────
  // While in chat with no live peers, poll for new dead drops every 30s.
  // The transport-layer rate limiter (FETCH_RATE_LIMIT_MS = 30000) absorbs any
  // overlap with the initial join fetch - the first tick after join is silently
  // skipped if it fires within the rate-limit window.

  useEffect(() => {
    if (screen !== 'chat' || peerCount > 0) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      return
    }

    pollIntervalRef.current = setInterval(() => { fetchAndAddDrops() }, 30_000)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [screen, peerCount, fetchAndAddDrops])

  // ── Dead man switch reconciliation poll ──────────────────────────────────
  // Runs every 30s regardless of peerCount. Catches armed switches published
  // while offline and cancellations made by other clients.
  // Independent of the message poll: uses a separate rate limiter in deadDrop.ts.

  useEffect(() => {
    if (screen !== 'chat') {
      if (deadManPollRef.current) {
        clearInterval(deadManPollRef.current)
        deadManPollRef.current = null
      }
      return
    }

    deadManPollRef.current = setInterval(() => { fetchDeadManState() }, 30_000)

    return () => {
      if (deadManPollRef.current) {
        clearInterval(deadManPollRef.current)
        deadManPollRef.current = null
      }
    }
  }, [screen, fetchDeadManState])

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
    duressDetected,
    sendTyping,
    typingAliases,
    pendingDeadMans,
    armDeadMan,
    cancelDeadMan,
    sendImage,
    getPerPeerWatchwords,
  }
}
