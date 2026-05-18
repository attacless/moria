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
import { publishDeadDrop, publishTextChunks, publishVoiceChunks, fetchDeadDrops, fetchDeadManEvents, deleteDeadDrops, deleteAllDeadDrops, publishPoisonEvent } from '@transport/deadDrop'
import { resetPeerColors } from '@/utils/peerColors'
import type { DeadDropReceipt } from '@transport/deadDrop'
import type { PublishResult } from '@transport/deadDrop'
import { roundTimestamp } from '@crypto/chacha20'
import { mountSecurityMeasures, unmountSecurityMeasures } from '@/security'
import { chunkImage, chunkBlob, reassembleChunks, IMAGE_MAX_BYTES } from '@/utils/imageChunker'
import { stripExif } from '@/utils/stripExif'
import { cancelRecording } from '@/utils/voiceRecorder'
import { SECS_PER_CHUNK } from '@components/VoicePlayer'
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

const VOICE_MAX_BYTES_P2P       = 2  * 1024 * 1024   // 2 MB live P2P
const VOICE_MAX_BYTES_DEAD_DROP = 500 * 1024          // 500 KB dead drop

export { VOICE_MAX_BYTES_P2P, VOICE_MAX_BYTES_DEAD_DROP }

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
  const ackQueueRef        = useRef<string[]>([])
  const ackTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  // All object URLs created this session (images + audio) - revoked on leave/terminate/panic
  const imageObjectUrls  = useRef<Set<string>>(new Set())

  // P2P voice reassembly buffer: voiceId -> partial chunk state + 60s discard timer
  const voiceChunkBuffer = useRef<Map<string, {
    chunks:        Map<number, string>
    totalChunks:   number
    mimeType:      string
    audioDuration: number
    alias:         Alias
    timestamp:     number
    timer:         ReturnType<typeof setTimeout>
  }>>(new Map())

  // P2P text reassembly buffer: chunkId -> partial chunk state + 60s discard timer
  const textChunkBuffer = useRef<Map<string, {
    chunks:      Map<number, string>
    totalChunks: number
    alias:       Alias
    timestamp:   number
    replyTo?:    ReplyTo
    timer:       ReturnType<typeof setTimeout>
  }>>(new Map())

  // Dead drop text reassembly buffer: chunkId -> chunk state + poll count (max 3)
  const textDropBuffer = useRef<Map<string, {
    chunks:      Map<number, string>
    totalChunks: number
    alias:       Alias
    timestamp:   number
    replyTo?:    ReplyTo
    pollCount:   number
  }>>(new Map())

  // Dead drop voice reassembly buffer: voiceId -> chunk state + poll count (max 3)
  const voiceDropBuffer = useRef<Map<string, {
    chunks:        Map<number, string>
    totalChunks:   number
    mimeType:      string
    audioDuration: number
    alias:         Alias
    timestamp:     number
    pollCount:     number
    isDeadMan:     boolean
    activateAfter?: number
  }>>(new Map())
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

    // Handle VOICE_CHUNK drops: group by voiceId, reassemble when complete.
    // Activated voice chunks (no activateAfter or activateAfter <= now) are processed here.
    // Pending armed voice chunks (activateAfter > now) are handled by fetchDeadManState.
    const voiceChunkDrops = drops.filter(
      d => d.type === 'VOICE_CHUNK' && (!d.activateAfter || d.activateAfter <= nowSecs)
    )
    if (voiceChunkDrops.length > 0) {
      // Group by voiceId
      const byVoiceId = new Map<string, typeof voiceChunkDrops>()
      for (const chunk of voiceChunkDrops) {
        if (!chunk.voiceId) continue
        const arr = byVoiceId.get(chunk.voiceId) ?? []
        arr.push(chunk)
        byVoiceId.set(chunk.voiceId, arr)
      }

      for (const [voiceId, chunkEvents] of byVoiceId) {
        // Skip already assembled voices
        if (seenDropIds.current.has(`VOICE:${voiceId}`)) continue

        const firstChunk = chunkEvents.find(c => c.voiceChunkIndex === 0)
        const totalChunks = firstChunk?.voiceTotalChunks ?? chunkEvents[0]?.voiceTotalChunks ?? 0
        if (totalChunks === 0) continue

        // Create or update the reassembly buffer entry
        let entry = voiceDropBuffer.current.get(voiceId)
        if (!entry) {
          entry = {
            chunks:        new Map(),
            totalChunks,
            mimeType:      firstChunk?.voiceMimeType ?? '',
            audioDuration: firstChunk?.voiceAudioDuration ?? 0,
            alias:         chunkEvents[0]!.alias,
            timestamp:     chunkEvents[0]!.timestamp,
            pollCount:     0,
            isDeadMan:     !!chunkEvents[0]?.activateAfter,
            ...(chunkEvents[0]?.activateAfter ? { activateAfter: chunkEvents[0].activateAfter } : {}),
          }
          voiceDropBuffer.current.set(voiceId, entry)
        }

        let addedNew = false
        for (const chunk of chunkEvents) {
          if (chunk.voiceChunkIndex !== undefined && chunk.voiceAudioData !== undefined) {
            if (!entry.chunks.has(chunk.voiceChunkIndex)) {
              entry.chunks.set(chunk.voiceChunkIndex, chunk.voiceAudioData)
              addedNew = true
            }
          }
          if (chunk.voiceMimeType)      entry.mimeType      = chunk.voiceMimeType
          if (chunk.voiceAudioDuration) entry.audioDuration = chunk.voiceAudioDuration
        }

        if (addedNew) entry.pollCount = 0
        else          entry.pollCount++

        if (entry.pollCount >= 3) {
          voiceDropBuffer.current.delete(voiceId)
          addMessage({
            id:        crypto.randomUUID(),
            alias:     'system',
            timestamp: roundTimestamp(Date.now()),
            body:      'a voice message could not be fully received',
            isMine:    false,
          })
          continue
        }

        if (entry.chunks.size === entry.totalChunks) {
          seenDropIds.current.add(`VOICE:${voiceId}`)
          voiceDropBuffer.current.delete(voiceId)

          const url            = reassembleChunks(entry.chunks, entry.mimeType || 'audio/webm;codecs=opus')
          const resolvedDur    = entry.audioDuration || Math.round(entry.totalChunks * SECS_PER_CHUNK)
          imageObjectUrls.current.add(url)
          addMessage({
            id:            crypto.randomUUID(),
            alias:         entry.alias,
            timestamp:     entry.timestamp,
            body:          '',
            isMine:        false,
            isDeadDrop:    true,
            confirmed:     false,
            audioUrl:      url,
            audioDuration: resolvedDur,
            ...(entry.isDeadMan ? { isDeadMan: true } : {}),
          })
        }
      }
    }

    // Handle TEXT_CHUNK drops: group by chunkId, reassemble when all chunks arrive.
    const textChunkDrops = drops.filter(d => d.type === 'TEXT_CHUNK')
    if (textChunkDrops.length > 0) {
      const byChunkId = new Map<string, typeof textChunkDrops>()
      for (const chunk of textChunkDrops) {
        if (!chunk.textChunkId) continue
        const arr = byChunkId.get(chunk.textChunkId) ?? []
        arr.push(chunk)
        byChunkId.set(chunk.textChunkId, arr)
      }

      for (const [chunkId, chunkEvents] of byChunkId) {
        if (seenDropIds.current.has(`TEXT:${chunkId}`)) continue

        const totalChunks = chunkEvents[0]?.textTotalChunks ?? 0
        if (totalChunks === 0) continue

        let entry = textDropBuffer.current.get(chunkId)
        if (!entry) {
          entry = {
            chunks:    new Map(),
            totalChunks,
            alias:     chunkEvents[0]!.alias,
            timestamp: chunkEvents[0]!.timestamp,
            pollCount: 0,
            ...(chunkEvents[0]?.replyTo ? { replyTo: chunkEvents[0].replyTo } : {}),
          }
          textDropBuffer.current.set(chunkId, entry)
        }

        let addedNew = false
        for (const chunk of chunkEvents) {
          if (chunk.textChunkIndex !== undefined && !entry.chunks.has(chunk.textChunkIndex)) {
            entry.chunks.set(chunk.textChunkIndex, chunk.body)
            addedNew = true
          }
          if (chunk.replyTo && !entry.replyTo) entry.replyTo = chunk.replyTo
        }

        if (addedNew) entry.pollCount = 0
        else          entry.pollCount++

        if (entry.pollCount >= 3) {
          textDropBuffer.current.delete(chunkId)
          addMessage({
            id:        crypto.randomUUID(),
            alias:     'system',
            timestamp: roundTimestamp(Date.now()),
            body:      'a message could not be fully received',
            isMine:    false,
          })
          continue
        }

        if (entry.chunks.size === entry.totalChunks) {
          seenDropIds.current.add(`TEXT:${chunkId}`)
          textDropBuffer.current.delete(chunkId)
          const sortedChunks = Array.from({ length: entry.totalChunks }, (_, i) => entry!.chunks.get(i) ?? '')
          const fullBody     = sortedChunks.join('')
          const dedupKey     = `${entry.alias}:${entry.timestamp}:${fullBody}`
          if (!seenDropIds.current.has(dedupKey)) {
            seenDropIds.current.add(dedupKey)
            addMessage({
              id:         crypto.randomUUID(),
              alias:      entry.alias,
              timestamp:  entry.timestamp,
              body:       fullBody,
              isMine:     false,
              isDeadDrop: true,
              confirmed:  false,
              ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
            })
          }
        }
      }
    }

    // All other drops (TEXT, activated DEADMAN, etc.) go through the normal pipeline.
    // An activated DEADMAN (activateAfter <= now) passes through here and is displayed
    // as a message. It is also removed from pendingDeadMans by the setPendingDeadMans
    // call above (since it no longer matches activateAfter > nowSecs).
    const newDrops = drops
      .filter(d => d.type !== 'DURESS')
      .filter(d => d.type !== 'VOICE_CHUNK')  // handled by voice reassembly path above
      .filter(d => d.type !== 'TEXT_CHUNK')   // handled by text reassembly path above
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

    // Separate DEADMAN text events from VOICE_CHUNK events
    const textEvents  = events.filter(e => e.type === 'DEADMAN')
    const voiceEvents = events.filter(e => e.type === 'VOICE_CHUNK' && e.activateAfter && e.activateAfter > nowSecs)

    // Group voice chunks by voiceId - each unique voiceId is one switch
    const armedVoiceByVoiceId = new Map<string, {
      activateAfter: number
      alias:         Alias
      timestamp:     number
      tokenHash?:    string
      eventIds:      string[]
    }>()
    for (const chunk of voiceEvents) {
      if (!chunk.voiceId || !chunk.activateAfter) continue
      const existing = armedVoiceByVoiceId.get(chunk.voiceId)
      if (existing) {
        existing.eventIds.push(chunk.eventId)
      } else {
        armedVoiceByVoiceId.set(chunk.voiceId, {
          activateAfter: chunk.activateAfter,
          alias:         chunk.alias,
          timestamp:     chunk.timestamp,
          ...(chunk.tokenHash ? { tokenHash: chunk.tokenHash } : {}),
          eventIds:      [chunk.eventId],
        })
      }
    }

    // All relay-armed IDs: text switches use eventId, voice switches use voiceId
    const relayArmedIds = new Set([
      ...textEvents.filter(e => e.activateAfter && e.activateAfter > nowSecs).map(e => e.eventId),
      ...Array.from(armedVoiceByVoiceId.keys()),
    ])

    setPendingDeadMans(prev => {
      // Remove entries no longer on relay (cancelled by another client or expired)
      const kept    = prev.filter(dm => relayArmedIds.has(dm.eventId))
      const keptIds = new Set(kept.map(dm => dm.eventId))

      // Add text entries the relay has that are not yet in local state
      const addedText = textEvents
        .filter(e => e.activateAfter && e.activateAfter > nowSecs && !keptIds.has(e.eventId))
        .map(e => ({
          eventId:    e.eventId,
          alias:      e.alias,
          timestamp:  e.timestamp * 1000,
          activateAt: e.activateAfter!,
          body:       e.body,
          ...(e.tokenHash ? { tokenHash: e.tokenHash } : {}),
        }))

      // Add voice entries not yet in local state (keyed by voiceId)
      const addedVoice = Array.from(armedVoiceByVoiceId.entries())
        .filter(([voiceId]) => !keptIds.has(voiceId))
        .map(([voiceId, info]) => ({
          eventId:    voiceId,
          eventIds:   info.eventIds,
          alias:      info.alias,
          timestamp:  info.timestamp * 1000,
          activateAt: info.activateAfter,
          body:       '',
          isVoice:    true as const,
          ...(info.tokenHash ? { tokenHash: info.tokenHash } : {}),
        }))

      return [...kept, ...addedText, ...addedVoice]
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
          if (ackTimerRef.current) { clearTimeout(ackTimerRef.current); ackTimerRef.current = null }
          ackQueueRef.current = []
          voiceChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
          voiceChunkBuffer.current.clear()
          voiceDropBuffer.current.clear()
          textChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
          textChunkBuffer.current.clear()
          textDropBuffer.current.clear()
          cancelRecording()
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
            const url = reassembleChunks(entry.chunks, entry.mimeType || 'image/jpeg')
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

        onVoiceChunk: (voiceId: string, chunkIndex: number, totalChunks: number, audioData: string, mimeType: string, audioDuration: number, peerAlias: Alias) => {
          let entry = voiceChunkBuffer.current.get(voiceId)
          if (!entry) {
            const timer = setTimeout(() => {
              voiceChunkBuffer.current.delete(voiceId)
              addMessage({
                id:        crypto.randomUUID(),
                alias:     'system',
                timestamp: roundTimestamp(Date.now()),
                body:      'a voice message could not be fully received',
                isMine:    false,
              })
            }, 60_000)
            entry = {
              chunks:        new Map(),
              totalChunks,
              mimeType:      '',
              audioDuration: 0,
              alias:         peerAlias,
              timestamp:     roundTimestamp(Date.now()),
              timer,
            }
            voiceChunkBuffer.current.set(voiceId, entry)
          }
          entry.chunks.set(chunkIndex, audioData)
          if (mimeType)      entry.mimeType      = mimeType
          if (audioDuration) entry.audioDuration = audioDuration

          if (entry.chunks.size === entry.totalChunks) {
            clearTimeout(entry.timer)
            voiceChunkBuffer.current.delete(voiceId)

            const url         = reassembleChunks(entry.chunks, entry.mimeType || 'audio/webm;codecs=opus')
            const resolvedDur = entry.audioDuration || Math.round(entry.totalChunks * SECS_PER_CHUNK)
            imageObjectUrls.current.add(url)
            addMessage({
              id:            crypto.randomUUID(),
              alias:         entry.alias,
              timestamp:     entry.timestamp,
              body:          '',
              isMine:        false,
              burnAt:        Date.now() + 5 * 60 * 1_000,
              audioUrl:      url,
              audioDuration: resolvedDur,
            })
          }
        },

        onTextChunk: (chunkId: string, chunkIndex: number, totalChunks: number, chunkText: string, peerAlias: Alias, timestamp: number, replyTo?: ReplyTo) => {
          let entry = textChunkBuffer.current.get(chunkId)
          if (!entry) {
            const timer = setTimeout(() => {
              textChunkBuffer.current.delete(chunkId)
            }, 60_000)
            entry = {
              chunks:      new Map(),
              totalChunks,
              alias:       peerAlias,
              timestamp,
              timer,
              ...(replyTo ? { replyTo } : {}),
            }
            textChunkBuffer.current.set(chunkId, entry)
          }
          entry.chunks.set(chunkIndex, chunkText)
          if (replyTo && !entry.replyTo) entry.replyTo = replyTo

          if (entry.chunks.size === entry.totalChunks) {
            clearTimeout(entry.timer)
            textChunkBuffer.current.delete(chunkId)
            const sortedChunks = Array.from({ length: entry.totalChunks }, (_, i) => entry!.chunks.get(i) ?? '')
            const fullBody     = sortedChunks.join('')
            addMessage({
              id:        crypto.randomUUID(),
              alias:     entry.alias,
              timestamp: entry.timestamp,
              body:      fullBody,
              isMine:    false,
              burnAt:    Date.now() + 5 * 60 * 1_000,
              ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
            })
          }
        },

        // Batched ACK sender: queue the received msgId, start a timer (if not already
        // running) with a random 300-800ms delay, then send all queued IDs at once.
        onQueueAck: (msgId: string) => {
          ackQueueRef.current.push(msgId)
          if (!ackTimerRef.current) {
            const delay = 300 + Math.random() * 500
            ackTimerRef.current = setTimeout(() => {
              const ids = [...ackQueueRef.current]
              ackQueueRef.current = []
              ackTimerRef.current = null
              if (ids.length > 0) {
                sendWireMessage({
                  type:      'ACK',
                  alias,
                  timestamp: roundTimestamp(Date.now()),
                  body:      '',
                  ackIds:    ids,
                })
              }
            }, delay)
          }
        },

        // ACK receipt: find each acked message by msgId and promote to 'read'.
        onAckReceived: (ackIds: string[]) => {
          for (const msgId of ackIds) {
            const found = messagesRef.current.find(m => m.msgId === msgId)
            if (found) updateMessageStatus(found.id, { ackStatus: 'read' })
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
  }, [addMessage, addMessages, autoConfirmDeadDrops, clearQueuedStatus, extendBurnTimers, clearMessages, rotateAlias, alias, fetchAndAddDrops, updateMessageStatus])

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

    const publishedTimestamp = roundTimestamp(Date.now())

    // Long body: send as TEXT_CHUNK batch instead of a single encrypted event
    if (body.length > 4000) {
      const chunkId  = crypto.randomUUID()
      const chunks: string[] = []
      for (let i = 0; i < body.length; i += 4000) {
        chunks.push(body.slice(i, i + 4000))
      }
      const chunkResult = await publishTextChunks(chunks, chunkId, alias, keys.dropId, keys.roomKey, keys.signingKey, ttlSeconds, replyTo)
      if (!chunkResult.success) {
        updateMessageStatus(optimisticId, { queuedStatus: 'failed' })
        setDropError('no relays reachable - message not queued')
        return
      }
      // Prevent poll from re-displaying as received chunks
      seenDropIds.current.add(`TEXT:${chunkId}`)
      const expiresAt = Date.now() + ttlSeconds * 1000
      updateMessageStatus(optimisticId, {
        queuedStatus:    'queued',
        queuedExpiresAt: expiresAt,
        burnAt:          expiresAt,
        confirmed:       true,
      })
      return
    }

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

  const armDeadMan = useCallback(async (
    body:           string,
    activateSeconds: number,
    tokenHash:      string,
    voiceBlob?:     Blob,
    voiceDuration?: number
  ): Promise<boolean> => {
    const keys = sessionRef.current
    if (!keys) return false

    const activateAfter = Math.floor(Date.now() / 1000) + activateSeconds
    // TTL: hold the relay event for the full activation window plus 24h buffer.
    const ttlSeconds    = activateSeconds + 86_400

    // ── Voice dead man switch ──────────────────────────────────────────────
    if (voiceBlob) {
      const { voiceId, mimeType, chunks } = await chunkBlob(voiceBlob)
      const publishedTimestamp = roundTimestamp(Date.now())

      const result = await publishVoiceChunks(
        chunks,
        voiceId,
        mimeType,
        voiceDuration ?? 0,
        alias,
        keys.dropId,
        keys.roomKey,
        keys.signingKey,
        ttlSeconds,
        activateAfter,
        tokenHash,
      )

      if (result.success) {
        seenDropIds.current.add(`VOICE:${voiceId}`)
        setPendingDeadMans(prev => [...prev, {
          eventId:    voiceId,
          eventIds:   result.eventIds,
          alias,
          timestamp:  Date.now(),
          activateAt: activateAfter,
          body:       '',
          tokenHash,
          isVoice:    true,
        }])
        broadcastDeadManArmed(voiceId, activateAfter, tokenHash, alias, publishedTimestamp)
      }

      return result.success
    }

    // ── Text dead man switch (original path) ──────────────────────────────
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
      seenDropIds.current.add(`${alias}:${publishedTimestamp}:${body}`)

      if (result.receipt) {
        setPendingDeadMans(prev => [...prev, {
          eventId:    result.receipt!.eventId,
          alias,
          timestamp:  Date.now(),
          activateAt: activateAfter,
          body,
          tokenHash,
        }])

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
    // For voice dead man switches, dm.eventIds contains all chunk Nostr event IDs.
    // For text switches, a single receipt suffices.
    const dm       = pendingDeadMans.find(d => d.eventId === eventId)
    const receipts = dm?.eventIds
      ? dm.eventIds.map(id => ({ eventId: id, expiresAt: 0 }))
      : [{ eventId, expiresAt: 0 }]
    try {
      await deleteDeadDrops(receipts, keys.dropId, keys.signingKey)
    } catch {}
    // Notify connected peers instantly; relay poll reconciles for peers not online.
    broadcastDeadManCancelled(eventId, alias)
    setPendingDeadMans(prev => prev.filter(d => d.eventId !== eventId))
  }, [alias, pendingDeadMans])

  // ── Image send ──────────────────────────────────────────────────────────

  const sendImage = useCallback(async (file: File): Promise<void> => {
    if (file.size > IMAGE_MAX_BYTES) return
    if (getPeerCount() === 0) return

    const cleanBlob = await stripExif(file)

    const { imageId, mimeType, chunks } = await chunkImage(cleanBlob)
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
      if (i < chunks.length - 1) {
        await new Promise<void>(r => setTimeout(r, 15))
      }
    }

    // Show sender's own image immediately via object URL from the clean (EXIF-stripped) blob
    const url = URL.createObjectURL(cleanBlob)
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

  // ── Voice send (P2P live chat) ───────────────────────────────────────────

  const sendVoice = useCallback(async (blob: Blob, duration: number): Promise<void> => {
    if (getPeerCount() === 0) return

    const { voiceId, mimeType, chunks } = await chunkBlob(blob)
    const totalChunks = chunks.length
    const ts = roundTimestamp(Date.now())

    for (let i = 0; i < chunks.length; i++) {
      sendWireMessage({
        type:        'VOICE_CHUNK',
        alias,
        timestamp:   ts,
        body:        '',
        imageId:     voiceId,
        chunkIndex:  i,
        totalChunks,
        imageData:   chunks[i]!,
        mimeType:    i === 0 ? mimeType : '',
        ...(i === 0 ? { audioDuration: duration } : {}),
      })
      if (i < chunks.length - 1) {
        await new Promise<void>(r => setTimeout(r, 15))
      }
    }

    const url = URL.createObjectURL(blob)
    imageObjectUrls.current.add(url)
    addMessage({
      id:            crypto.randomUUID(),
      alias,
      timestamp:     ts,
      body:          '',
      isMine:        true,
      burnAt:        Date.now() + 5 * 60 * 1_000,
      audioUrl:      url,
      audioDuration: duration,
    })
  }, [alias, addMessage])

  // ── Voice dead drop (no peers online) ───────────────────────────────────

  const sendVoiceDeadDrop = useCallback(async (
    blob:       Blob,
    duration:   number,
    ttlSeconds: number = 86_400
  ): Promise<void> => {
    const keys = sessionRef.current
    if (!keys) return

    const { voiceId, mimeType, chunks } = await chunkBlob(blob)

    // Optimistic message - shows immediately while publishing
    const optimisticId = crypto.randomUUID()
    const localUrl     = URL.createObjectURL(blob)
    imageObjectUrls.current.add(localUrl)
    addMessage({
      id:            optimisticId,
      alias,
      timestamp:     roundTimestamp(Date.now()),
      body:          '',
      isMine:        true,
      isDeadDrop:    true,
      queuedStatus:  'sending',
      audioUrl:      localUrl,
      audioDuration: duration,
    })

    const result = await publishVoiceChunks(
      chunks,
      voiceId,
      mimeType,
      duration,
      alias,
      keys.dropId,
      keys.roomKey,
      keys.signingKey,
      ttlSeconds,
    )

    if (!result.success) {
      updateMessageStatus(optimisticId, { queuedStatus: 'failed' })
      return
    }

    // Prevent the poll from re-displaying this own voice message
    seenDropIds.current.add(`VOICE:${voiceId}`)

    // No receipt object available from publishVoiceChunks, so use a synthetic expiry
    const expiresAt = Date.now() + ttlSeconds * 1_000
    updateMessageStatus(optimisticId, {
      queuedStatus:    'queued',
      queuedExpiresAt: expiresAt,
      burnAt:          expiresAt,
      confirmed:       true,
    })
  }, [alias, addMessage, updateMessageStatus])

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
    if (ackTimerRef.current) { clearTimeout(ackTimerRef.current); ackTimerRef.current = null }
    ackQueueRef.current = []
    voiceChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    voiceChunkBuffer.current.clear()
    voiceDropBuffer.current.clear()
    textChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    textChunkBuffer.current.clear()
    textDropBuffer.current.clear()
    cancelRecording()
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
    if (ackTimerRef.current) { clearTimeout(ackTimerRef.current); ackTimerRef.current = null }
    ackQueueRef.current = []
    voiceChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    voiceChunkBuffer.current.clear()
    voiceDropBuffer.current.clear()
    textChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    textChunkBuffer.current.clear()
    textDropBuffer.current.clear()
    cancelRecording()

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
    if (ackTimerRef.current) { clearTimeout(ackTimerRef.current); ackTimerRef.current = null }
    ackQueueRef.current = []
    voiceChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    voiceChunkBuffer.current.clear()
    voiceDropBuffer.current.clear()
    textChunkBuffer.current.forEach(entry => clearTimeout(entry.timer))
    textChunkBuffer.current.clear()
    textDropBuffer.current.clear()
    cancelRecording()
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
    sendVoice,
    sendVoiceDeadDrop,
    getPerPeerWatchwords,
  }
}
