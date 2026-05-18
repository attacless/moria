import { MessageList } from './MessageList'
import { InputBar }    from './InputBar'
import { VoicePlayer } from './VoicePlayer'
import { webRTCAvailable } from '@/capabilities'
import { getPeerColor } from '@/utils/peerColors'
import { playClick } from '@/utils/sounds'
import { startRecording, stopRecording, cancelRecording } from '@/utils/voiceRecorder'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DisplayMessage, ReplyTo, Alias, PendingDeadMan, PeerWatchwords } from '@/types'

const DEADMAN_TIMER_OPTIONS = [
  { label: '1H',  seconds: 1  * 60 * 60 },
  { label: '2H',  seconds: 2  * 60 * 60 },
  { label: '6H',  seconds: 6  * 60 * 60 },
  { label: '12H', seconds: 12 * 60 * 60 },
  { label: '24H', seconds: 24 * 60 * 60 },
  { label: '48H', seconds: 48 * 60 * 60 },
]

function formatCountdown(activateAtSecs: number): string {
  const remaining = Math.max(0, activateAtSecs - Math.floor(Date.now() / 1000))
  const h = Math.floor(remaining / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

interface ChatRoomProps {
  roomId:               string
  alias:                string
  peerCount:            number
  presenceCount:        number
  messages:             DisplayMessage[]
  burnSecondsRemaining: (msg: DisplayMessage) => number | null
  onSend:               (body: string, ttlSeconds: number, replyTo?: ReplyTo) => void
  onLeave:              () => void
  onTerminate:          () => Promise<void>
  onConfirmDeadDrop:    (id: string) => void
  dropError?:           string | null
  onClearError?:        () => void
  rateLimited?:         boolean
  roomFull?:            boolean
  duressDetected?:      boolean
  onTyping?:            () => void
  typingAliases?:       Alias[]
  pendingDeadMans?:     PendingDeadMan[]
  onArmDeadMan?:        (body: string, activateSeconds: number, tokenHash: string, voiceBlob?: Blob, voiceDuration?: number) => Promise<boolean>
  onCancelDeadMan?:     (eventId: string) => Promise<void>
  onSendImage?:         (file: File, replyTo?: ReplyTo) => void
  onSendVoice?:         (blob: Blob, duration: number) => void
  onSendVoiceDeadDrop?: (blob: Blob, duration: number, ttlSeconds: number) => void
  onGetWatchwords?:     () => Promise<PeerWatchwords[]>
  isSendingMedia?:      boolean
  mediaSendProgress?:   number
}


export function ChatRoom({
  roomId,
  alias,
  peerCount,
  presenceCount,
  messages,
  burnSecondsRemaining,
  onSend,
  onLeave,
  onTerminate,
  onConfirmDeadDrop,
  dropError,
  onClearError,
  rateLimited,
  roomFull,
  duressDetected,
  onTyping,
  typingAliases = [],
  pendingDeadMans = [],
  onArmDeadMan,
  onCancelDeadMan,
  onSendImage,
  onSendVoice,
  onSendVoiceDeadDrop,
  onGetWatchwords,
  isSendingMedia,
  mediaSendProgress,
}: ChatRoomProps) {
  const [terminating, setTerminating] = useState(false)

  // ── Dead man's switch modal ─────────────────────────────────────────────
  const [showDeadManModal, setShowDeadManModal] = useState(false)
  const [deadManTimerSecs, setDeadManTimerSecs] = useState(DEADMAN_TIMER_OPTIONS[0]!.seconds)
  const [deadManBody, setDeadManBody]           = useState('')
  const [deadManArming, setDeadManArming]       = useState(false)

  // Token confirmation modal (shown after successful ARM)
  const [armedToken, setArmedToken]             = useState<string | null>(null)

  // Dead man modal - voice recording state
  const [deadManVoiceBlob, setDeadManVoiceBlob]         = useState<Blob | null>(null)
  const [deadManVoiceDuration, setDeadManVoiceDuration] = useState(0)
  const [deadManIsRecording, setDeadManIsRecording]     = useState(false)
  const [deadManRecElapsed, setDeadManRecElapsed]       = useState(0)
  const deadManRecTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadManVoiceUrlRef  = useRef<string | null>(null)   // blob URL - managed via ref to avoid extra state
  const [deadManVoiceReady, setDeadManVoiceReady] = useState(false)
  const VOICE_MAX_DEAD_DROP = 500 * 1024

  // Per-item ENTER CODE state (keyed by eventId)
  // Key present = entering mode active; absent = idle
  const [codeInputs, setCodeInputs]   = useState<Record<string, string>>({})
  const [codeErrors, setCodeErrors]   = useState<Record<string, boolean>>({})
  const [disarmedFlash, setDisarmedFlash] = useState(false)

  // Tick for countdown re-renders
  const [_tick, setTick] = useState(0)

  useEffect(() => {
    if (pendingDeadMans.length === 0) return
    const interval = setInterval(() => setTick(t => t + 1), 1_000)
    return () => clearInterval(interval)
  }, [pendingDeadMans.length])

  // Acoustic verification modal - computed on demand, not stored in parent state
  const [peerWatchwords, setPeerWatchwords] = useState<PeerWatchwords[] | null>(null)

  useEffect(() => {
    if (!peerWatchwords) return
    const timer = setTimeout(() => setPeerWatchwords(null), 60_000)
    return () => clearTimeout(timer)
  }, [peerWatchwords])

  const handleOpenVerify = useCallback(async () => {
    if (!onGetWatchwords) return
    const words = await onGetWatchwords()
    setPeerWatchwords(words)
  }, [onGetWatchwords])

  function fmtDeadManElapsed(secs: number): string {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  async function startDeadManVoice() {
    try {
      await startRecording(VOICE_MAX_DEAD_DROP, () => stopDeadManVoice())
      setDeadManIsRecording(true)
      setDeadManRecElapsed(0)
      deadManRecTimerRef.current = setInterval(() => setDeadManRecElapsed(e => e + 1), 1_000)
    } catch {
      // permission denied - silently ignore
    }
  }

  async function stopDeadManVoice(): Promise<{ blob: Blob; duration: number } | null> {
    if (deadManRecTimerRef.current) {
      clearInterval(deadManRecTimerRef.current)
      deadManRecTimerRef.current = null
    }
    const result = await stopRecording()
    setDeadManIsRecording(false)
    setDeadManRecElapsed(0)
    if (result) {
      if (deadManVoiceUrlRef.current) URL.revokeObjectURL(deadManVoiceUrlRef.current)
      deadManVoiceUrlRef.current = URL.createObjectURL(result.blob)
      setDeadManVoiceBlob(result.blob)
      setDeadManVoiceDuration(result.duration)
    }
    return result ?? null
  }

  function cancelDeadManVoice() {
    if (deadManRecTimerRef.current) {
      clearInterval(deadManRecTimerRef.current)
      deadManRecTimerRef.current = null
    }
    cancelRecording()
    setDeadManIsRecording(false)
    setDeadManRecElapsed(0)
    setDeadManVoiceBlob(null)
    setDeadManVoiceDuration(0)
    setDeadManVoiceReady(false)
    if (deadManVoiceUrlRef.current) { URL.revokeObjectURL(deadManVoiceUrlRef.current); deadManVoiceUrlRef.current = null }
  }

  function handleDeadManVoiceLink() {
    setDeadManVoiceReady(true)
  }

  function revertToReadyFromRecording() {
    if (deadManRecTimerRef.current) {
      clearInterval(deadManRecTimerRef.current)
      deadManRecTimerRef.current = null
    }
    cancelRecording()
    setDeadManIsRecording(false)
    setDeadManRecElapsed(0)
    // deadManVoiceReady stays true
  }

  function discardAndGoToReady() {
    setDeadManVoiceBlob(null)
    setDeadManVoiceDuration(0)
    if (deadManVoiceUrlRef.current) { URL.revokeObjectURL(deadManVoiceUrlRef.current); deadManVoiceUrlRef.current = null }
    setDeadManVoiceReady(true)
  }

  const openDeadManModal = useCallback(() => {
    setDeadManBody('')
    setDeadManTimerSecs(DEADMAN_TIMER_OPTIONS[0]!.seconds)
    setDeadManVoiceBlob(null)
    setDeadManVoiceDuration(0)
    setDeadManVoiceReady(false)
    if (deadManVoiceUrlRef.current) { URL.revokeObjectURL(deadManVoiceUrlRef.current); deadManVoiceUrlRef.current = null }
    setShowDeadManModal(true)
  }, [])

  const handleArmDeadMan = useCallback(async () => {
    const hasVoice = !!deadManVoiceBlob
    const hasText  = deadManBody.trim().length > 0
    if ((!hasText && !hasVoice) || !onArmDeadMan) return
    setDeadManArming(true)

    // Generate 6-char alphanumeric cancellation token
    const token = Math.random().toString(36).substring(2, 8).toUpperCase()

    // Hash the token with SHA-256 - only the hash goes into the encrypted payload
    const encoder    = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(token))
    const tokenHash  = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    const ok = hasVoice
      ? await onArmDeadMan('', deadManTimerSecs, tokenHash, deadManVoiceBlob, deadManVoiceDuration)
      : await onArmDeadMan(deadManBody.trim(), deadManTimerSecs, tokenHash)

    setDeadManArming(false)
    if (ok) {
      setShowDeadManModal(false)
      setDeadManVoiceBlob(null)
      setDeadManVoiceDuration(0)
      setDeadManVoiceReady(false)
      if (deadManVoiceUrlRef.current) { URL.revokeObjectURL(deadManVoiceUrlRef.current); deadManVoiceUrlRef.current = null }
      setArmedToken(token)
    }
    // on failure: leave blob/preview in place so user can retry
  }, [deadManBody, deadManTimerSecs, onArmDeadMan, deadManVoiceBlob, deadManVoiceDuration])

  // ── ENTER CODE per-item helpers ─────────────────────────────────────────

  function startEntering(eventId: string) {
    setCodeInputs(prev => ({ ...prev, [eventId]: '' }))
  }

  function cancelEntering(eventId: string) {
    setCodeInputs(prev => { const next = { ...prev }; delete next[eventId]; return next })
    setCodeErrors(prev => { const next = { ...prev }; delete next[eventId]; return next })
  }

  const handleVerifyCode = useCallback(async (dm: PendingDeadMan) => {
    const entered = (codeInputs[dm.eventId] ?? '').toUpperCase().trim()
    if (!entered || !dm.tokenHash) return

    const encoder    = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(entered))
    const hash       = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    if (hash === dm.tokenHash) {
      // Valid code - cancel the switch
      await onCancelDeadMan?.(dm.eventId)
      setCodeInputs(prev => { const next = { ...prev }; delete next[dm.eventId]; return next })
      setDisarmedFlash(true)
      setTimeout(() => setDisarmedFlash(false), 3_000)
    } else {
      // Invalid code - show error, revert to idle
      setCodeInputs(prev => { const next = { ...prev }; delete next[dm.eventId]; return next })
      setCodeErrors(prev => ({ ...prev, [dm.eventId]: true }))
      setTimeout(() => {
        setCodeErrors(prev => { const next = { ...prev }; delete next[dm.eventId]; return next })
      }, 2_000)
    }
  }, [codeInputs, onCancelDeadMan])

  // ── Peer connection feedback ─────────────────────────────────────────────
  const dotRef          = useRef<HTMLDivElement>(null)
  const prevPeerCountRef = useRef(peerCount)

  useEffect(() => {
    const prev = prevPeerCountRef.current
    prevPeerCountRef.current = peerCount
    if (peerCount > prev) {
      dotRef.current?.classList.add('join-flash')
      setTimeout(() => dotRef.current?.classList.remove('join-flash'), 600)
    } else if (peerCount < prev) {
      dotRef.current?.classList.add('leave-dim')
      setTimeout(() => dotRef.current?.classList.remove('leave-dim'), 500)
    }
  }, [peerCount])

  // ── Unread tab badge ────────────────────────────────────────────────────
  const seenIdsRef = useRef<Set<string>>(new Set())
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    const newMsgs = messages.filter(m => !seenIdsRef.current.has(m.id))
    newMsgs.forEach(m => seenIdsRef.current.add(m.id))
    if (!document.hidden) return
    const countable = newMsgs.filter(m => !m.isMine && m.alias !== 'system')
    if (countable.length > 0) setUnreadCount(prev => prev + countable.length)
  }, [messages])

  useEffect(() => {
    function onVisChange() { if (!document.hidden) setUnreadCount(0) }
    document.addEventListener('visibilitychange', onVisChange)
    return () => document.removeEventListener('visibilitychange', onVisChange)
  }, [])

  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Moria` : 'Moria'
    return () => { document.title = 'Moria' }
  }, [unreadCount])

  // ── Reply state ─────────────────────────────────────────────────────────
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null)

  const handleSelectReply = useCallback((msg: DisplayMessage) => {
    const body = msg.imageUrl ? 'Image' : msg.audioUrl ? 'Voice message' : msg.body.slice(0, 100)
    setReplyTo({ id: msg.id, body, alias: msg.alias })
  }, [])

  const handleCancelReply = useCallback(() => setReplyTo(null), [])

  const handleSend = useCallback((body: string, ttlSecs: number) => {
    onSend(body, ttlSecs, replyTo ?? undefined)
    setReplyTo(null)
  }, [onSend, replyTo])

  const handleSendImage = useCallback((file: File) => {
    onSendImage?.(file, replyTo ?? undefined)
    setReplyTo(null)
  }, [onSendImage, replyTo])

  const handleTyping = useCallback(() => { onTyping?.() }, [onTyping])

  // Connection unavailable modal - appears after 20s of continuous waiting
  const [showWaitModal, setShowWaitModal]           = useState(false)
  const [waitModalDismissed, setWaitModalDismissed] = useState(false)

  useEffect(() => {
    // Hide immediately if peer connects or WebRTC is not available (dead drop mode is expected)
    if (peerCount > 0 || !webRTCAvailable) {
      setShowWaitModal(false)
      return
    }
    // Never show again once dismissed this session
    if (waitModalDismissed) return
    // Don't interrupt the dead man modal - restart the timer after it closes
    if (showDeadManModal) return
    const timer = setTimeout(() => setShowWaitModal(true), 20_000)
    return () => clearTimeout(timer)
  }, [peerCount, waitModalDismissed, showDeadManModal])

  // Dead drop collapse state lives here (not MessageList) so it survives any remount
  const [collapsedDrops, setCollapsedDrops] = useState<Set<string>>(new Set())
  const toggleDropCollapse = useCallback((id: string) => {
    setCollapsedDrops(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  async function handleTerminate() {
    setTerminating(true)
    await onTerminate()
    setTerminating(false)
  }

  const roomDisplay = roomId.length >= 8
    ? roomId.slice(0, 8)
    : roomId

  const peerDotClass = !webRTCAvailable ? 'waiting'
    : peerCount > 0 ? 'active'
    : presenceCount > 0 ? 'connecting'
    : 'waiting'

  const peerLabel = !webRTCAvailable ? 'dead drop mode'
    : peerCount > 0 ? `${peerCount + 1} in room`
    : presenceCount > 0 ? 'connecting...'
    : 'waiting'

  return (
    <div className="chat-app">

      {/* Header */}
      <div className="chat-header">
        <div className="header-left">
          {/* Centered brand block: MORIA + hash stacked */}
          <div className="header-brand">
            <span className="header-wordmark">MORIA</span>
            <span className="room-hash">{roomDisplay}</span>
          </div>
          {/* Peer status to the right of the brand */}
          <div className="peer-indicator">
            <div ref={dotRef} className={`peer-dot ${peerDotClass}`} />
            <span className="peer-label">{peerLabel}</span>
          </div>

        </div>

        <div className="header-actions">
          {peerCount >= 1 && onGetWatchwords && (
            <button
              className="action-btn"
              onClick={() => { playClick(); handleOpenVerify() }}
              title="Verify connection - share watchwords to confirm no MITM"
            >
              VERIFY
            </button>
          )}

          <button className="action-btn leave" onClick={() => { playClick(); onLeave() }}>
            LEAVE
          </button>

          <button
            className={`action-btn terminate${terminating ? ' nuking' : ''}`}
            onClick={() => { playClick(); handleTerminate() }}
            disabled={terminating}
            title="Delete all your messages from all peers and disconnect"
          >
            {terminating ? 'NUKING...' : 'TERMINATE'}
          </button>
        </div>
      </div>

      {/* Duress banner - persists for entire session once a poison event is detected */}
      {duressDetected && (
        <div className="duress-banner">
          <div className="duress-banner-text">
            <span className="duress-banner-title">DURESS SIGNAL</span>
            <span className="duress-banner-body">The other party may be under coercion. Read any remaining messages, then terminate this room.</span>
          </div>
          <button
            className="duress-banner-terminate"
            onClick={() => { playClick(); handleTerminate() }}
            disabled={terminating}
          >
            {terminating ? 'NUKING...' : 'TERMINATE'}
          </button>
        </div>
      )}

      {/* Room full banner */}
      {roomFull && (
        <div className="room-banner red">
          room is full - 50 participant limit reached
        </div>
      )}

      {/* Messages */}
      <MessageList
        messages={messages}
        myAlias={alias}
        burnSecondsRemaining={burnSecondsRemaining}
        onConfirmDeadDrop={onConfirmDeadDrop}
        hasPeers={peerCount > 0}
        peerCount={peerCount}
        collapsedDrops={collapsedDrops}
        onToggleDropCollapse={toggleDropCollapse}
        onSelectReply={handleSelectReply}
      />

      {/* Typing indicator */}
      {typingAliases.length > 0 && (
        <div
          className="typing-indicator"
          style={
            peerCount >= 2 && peerCount <= 6
              ? { color: getPeerColor(typingAliases[0]!) }
              : undefined
          }
        >
          {peerCount >= 2 && peerCount <= 6 && typingAliases[0] !== undefined && typingAliases[0].length > 0 ? `${typingAliases[0]} ` : ''}
          <span className="typing-dots">
            <span className="typing-dot">.</span>
            <span className="typing-dot">.</span>
            <span className="typing-dot">.</span>
          </span>
        </div>
      )}

      {/* Pending dead man switches - armed but not yet activated */}
      {pendingDeadMans.length > 0 && (
        <div className="pending-deadmans">
          {pendingDeadMans.map(dm => {
            const isEntering = dm.eventId in codeInputs
            const hasError   = !!codeErrors[dm.eventId]
            return (
              <div key={dm.eventId} className="pending-deadman">
                <div className="pending-deadman-top">
                  <span className="pending-deadman-label">DEAD MAN'S SWITCH ARMED</span>
                  <span className="pending-deadman-countdown">{formatCountdown(dm.activateAt)}</span>
                  {isEntering ? (
                    <div className="deadman-code-row">
                      <input
                        className="deadman-code-input"
                        value={codeInputs[dm.eventId] ?? ''}
                        onChange={e => setCodeInputs(prev => ({ ...prev, [dm.eventId]: e.target.value.toUpperCase().slice(0, 6) }))}
                        onKeyDown={e => { if (e.key === 'Enter') handleVerifyCode(dm) }}
                        placeholder="XXXXXX"
                        maxLength={6}
                        autoFocus
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button className="pending-deadman-verify" onClick={() => { playClick(); handleVerifyCode(dm) }} type="button">
                        VERIFY
                      </button>
                      <button className="pending-deadman-dismiss" onClick={() => { playClick(); cancelEntering(dm.eventId) }} type="button">
                        X
                      </button>
                    </div>
                  ) : (
                    <button
                      className={`pending-deadman-enter${hasError ? ' error' : ''}`}
                      onClick={() => { playClick(); startEntering(dm.eventId) }}
                      type="button"
                    >
                      {hasError ? 'INVALID CODE' : 'ENTER CODE'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Disarmed flash */}
      {disarmedFlash && (
        <div className="deadman-armed-flash">switch disarmed</div>
      )}

      {/* Input */}
      <InputBar
        onSend={handleSend}
        disabled={false}
        placeholder={peerCount === 0 ? 'no peers online - type here to send a queued message...' : 'type message...'}
        dropError={dropError}
        onClearError={onClearError}
        rateLimited={rateLimited}
        hasPeers={peerCount > 0}
        replyTo={replyTo}
        onCancelReply={handleCancelReply}
        onTyping={handleTyping}
        {...(onArmDeadMan       ? { onOpenDeadMan: openDeadManModal }                                                   : {})}
        {...(onSendImage        ? { onSendImage: handleSendImage }                                                       : {})}
        {...(isSendingMedia    !== undefined ? { isSendingMedia }   : {})}
        {...(mediaSendProgress !== undefined ? { mediaSendProgress } : {})}
        {...(peerCount > 0 && onSendVoice
              ? { onSendVoice }
              : peerCount === 0 && onSendVoiceDeadDrop
                ? { onSendVoice: (b: Blob, d: number) => onSendVoiceDeadDrop(b, d, 86_400) }
                : {})}
      />

      {/* Footer */}
      <div className="chat-footer">
        <span className="panic-hint">panic esc × 3 · decoy shift × 5</span>
      </div>

      {/* Token confirmation modal - shown after successful ARM */}
      {armedToken && (
        <div className="modal-backdrop">
          <div className="warn-dialog deadman-dialog">
            <div className="warn-title">SWITCH ARMED</div>
            <div className="warn-body" style={{ textAlign: 'center' }}>Your cancellation code</div>
            <div className="deadman-token-display">{armedToken}</div>
            <div className="deadman-token-hint">Save this code. You will not see it again.</div>
            <div className="warn-actions">
              <button
                className="warn-btn primary"
                onClick={() => { playClick(); setArmedToken(null) }}
                type="button"
              >
                I SAVED IT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dead man's switch modal */}
      {showDeadManModal && (
        <div className="modal-backdrop">
          <div className="warn-dialog deadman-dialog">
            <div className="warn-title">DEAD MAN'S SWITCH</div>

            {/* Timer selector: always visible */}
            <div className="deadman-timer-selector">
              {DEADMAN_TIMER_OPTIONS.map(opt => (
                <button
                  key={opt.seconds}
                  className={`deadman-timer-opt${deadManTimerSecs === opt.seconds ? ' active' : ''}`}
                  onClick={() => { playClick(); setDeadManTimerSecs(opt.seconds) }}
                  type="button"
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Main content area: 4-state machine */}
            {deadManIsRecording ? (
              /* Recording state */
              <div className="recording-bar recording-active" style={{ marginBottom: '12px' }}>
                <div className="rec-dot" />
                <span className="rec-label">RECORDING</span>
                <span className="rec-elapsed">{fmtDeadManElapsed(deadManRecElapsed)}</span>
                <div className="rec-actions">
                  <button className="rec-icon-btn recording-delete-btn" onClick={revertToReadyFromRecording} type="button" aria-label="Discard and go back">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 11V17"/>
                      <path d="M14 11V17"/>
                      <path d="M4 7H20"/>
                      <path d="M6 7H12H18V18C18 19.6569 16.6569 21 15 21H9C7.34315 21 6 19.6569 6 18V7Z"/>
                      <path d="M9 5C9 3.89543 9.89543 3 11 3H13C14.1046 3 15 3.89543 15 5V7H9V5Z"/>
                    </svg>
                  </button>
                  <button className="rec-icon-btn recording-send-btn" onClick={stopDeadManVoice} type="button" aria-label="Stop recording">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2"/>
                    </svg>
                  </button>
                </div>
              </div>
            ) : deadManVoiceBlob && deadManVoiceUrlRef.current ? (
              /* Preview state */
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0 12px' }}>
                <VoicePlayer audioUrl={deadManVoiceUrlRef.current} duration={deadManVoiceDuration} />
                <button className="reply-cancel" onClick={discardAndGoToReady} type="button" aria-label="Discard and re-record">
                  {'✕'}
                </button>
              </div>
            ) : deadManVoiceReady ? (
              /* Ready state */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '16px 0 20px' }}>
                <button
                  className="rec-icon-btn rec-ready-mic"
                  onClick={startDeadManVoice}
                  type="button"
                  aria-label="Start recording"
                  style={{ padding: '0' }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width={32} height={32} viewBox="0 0 90 90" fill="currentColor">
                    <path d="M69.245 38.312c-1.104 0-2 .896-2 2v6.505c0 12.266-9.979 22.244-22.245 22.244s-22.245-9.979-22.245-22.244v-6.505c0-1.104-.896-2-2-2s-2 .896-2 2v6.505c0 13.797 10.705 25.134 24.245 26.16V86h-9.126c-1.104 0-2 .896-2 2s.896 2 2 2h22.252c1.104 0 2-.896 2-2s-.896-2-2-2H47V72.978c13.54-1.026 24.245-12.363 24.245-26.16v-6.505c0-1.104-.895-2-2-2z"/>
                    <path d="M45 59.809c8.481 0 15.382-6.9 15.382-15.382V15.382C60.382 6.9 53.481 0 45 0S29.618 6.9 29.618 15.382v29.044c0 8.482 6.901 15.383 15.382 15.383zM33.618 15.382C33.618 9.106 38.724 4 45 4c6.276 0 11.382 5.106 11.382 11.382v29.044c0 6.276-5.105 11.382-11.382 11.382-6.276 0-11.382-5.106-11.382-11.382V15.382z"/>
                  </svg>
                </button>
                <span className="rec-ready-label">TAP TO RECORD</span>
              </div>
            ) : (
              /* Normal state */
              <>
                <div className="warn-body">
                  Write a message and set a delay. If no one cancels it before the timer expires, the message will appear automatically to anyone who opens this room.
                </div>
                <textarea
                  className="deadman-textarea"
                  value={deadManBody}
                  onChange={e => setDeadManBody(e.target.value)}
                  placeholder="message to send when the switch activates..."
                  rows={4}
                  maxLength={1800}
                  autoFocus
                />
                <button className="deadman-voice-link" onClick={handleDeadManVoiceLink} type="button">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M14.754 15c1.242 0 2.249 1.007 2.249 2.249v.575c0 .894-.32 1.759-.901 2.439-1.57 1.833-3.957 2.738-7.102 2.738-3.146 0-5.532-.905-7.098-2.74-.58-.679-.899-1.543-.899-2.435v-.577C1.004 16.007 2.01 15 3.252 15h11.502zM9 3.005c2.761 0 5 2.238 5 5s-2.239 5-5 5-5-2.238-5-5 2.239-5 5-5zm10.054-1.601a.75.75 0 01.676 1.279C21.168 3.591 21.75 5.754 21.75 8s-.582 4.423-1.684 6.337a.75.75 0 01-1.301-.746C19.733 11.903 20.25 9.99 20.25 8s-.514-3.89-1.475-5.573a.75.75 0 01.279-1.023zm-3.466 2c.36-.205.818-.08 1.023.28A9.72 9.72 0 0117.75 8a9.72 9.72 0 01-1.144 4.328.75.75 0 01-1.303-.743A8.22 8.22 0 0016.25 8c0-1.273-.328-2.497-.942-3.578a.75.75 0 01.28-1.018z"/>
                  </svg>
                  send a voice message instead
                </button>
              </>
            )}

            <div className="warn-actions">
              <button
                className="warn-btn ghost"
                onClick={() => {
                  playClick()
                  const inVoiceFlow = deadManVoiceReady || deadManIsRecording || !!deadManVoiceBlob
                  cancelDeadManVoice()          // always clean up voice state
                  if (!inVoiceFlow) setShowDeadManModal(false)  // only close if in normal textarea state
                }}
                disabled={deadManArming}
                type="button"
              >
                CANCEL
              </button>
              {/* ARM visible in normal state (no voice flow) and preview state (blob ready) */}
              {((!deadManVoiceReady && !deadManIsRecording) || !!deadManVoiceBlob) && (
                <button
                  className="warn-btn primary"
                  onClick={() => { playClick(); handleArmDeadMan() }}
                  disabled={(!deadManBody.trim() && !deadManVoiceBlob) || deadManArming}
                  type="button"
                >
                  {deadManArming ? 'ARMING...' : 'ARM'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Acoustic verification modal */}
      {peerWatchwords !== null && (
        <div className="modal-backdrop">
          <div className="warn-dialog deadman-dialog">
            <div className="warn-title">WATCHWORDS</div>

            {peerWatchwords.length === 1 ? (
              <>
                <div className="warn-body" style={{ textAlign: 'center' }}>
                  Share these four words with your peer over a separate channel. If they match, no one is intercepting your connection.
                </div>
                <div className="verify-words">
                  {peerWatchwords[0]!.words.map((word, i) => (
                    <span key={i} className="verify-word">{word}</span>
                  ))}
                </div>
                <div className="verify-hint">
                  These words change every session. A mismatch means your connection may be compromised.
                </div>
              </>
            ) : (
              <>
                <div className="warn-body" style={{ textAlign: 'center' }}>
                  Share these words with each peer separately over a different channel. Each connection has unique watchwords.
                </div>
                {peerWatchwords.some(pw => !pw.hasChatAlias) && (
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', textAlign: 'center', marginTop: '4px', marginBottom: '12px' }}>
                    Peer aliases appear after the first message is exchanged.
                  </div>
                )}
                <div className="verify-peers">
                  {peerWatchwords.map(pw => (
                    <div key={pw.peerId} className="verify-peer-section">
                      <span
                        className="verify-peer-alias"
                        style={peerWatchwords.length <= 6 ? { color: getPeerColor(pw.alias) } : undefined}
                      >
                        {pw.alias}
                      </span>
                      <div className="verify-words">
                        {pw.words.map((word, i) => (
                          <span key={i} className="verify-word">{word}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="verify-hint">
                  Each peer has different watchwords. A mismatch on any connection may indicate interception.
                </div>
              </>
            )}

            <div className="warn-actions">
              <button
                className="warn-btn primary"
                onClick={() => { playClick(); setPeerWatchwords(null) }}
                type="button"
              >
                CLOSE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connection unavailable modal - shown after 20s of continuous waiting */}
      {showWaitModal && (
        <div className="modal-backdrop">
          <div className="warn-dialog">
            <div className="warn-title">no peers online</div>
            <div className="warn-body">
              No one else is in this room yet. You can still communicate using dead drop mode. New messages appear automatically every 30 seconds. If a peer joins and live chat does not connect, your network may not support direct peer-to-peer connections.
            </div>
            <div className="warn-actions">
              <button className="warn-btn ghost" onClick={() => { playClick(); onLeave() }}>
                leave room
              </button>
              <button
                className="warn-btn primary"
                onClick={() => { playClick(); setWaitModalDismissed(true); setShowWaitModal(false) }}
              >
                send dead drop (queue)
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
