import { MessageList } from './MessageList'
import { InputBar }    from './InputBar'
import { webRTCAvailable } from '@/capabilities'
import { getPeerColor } from '@/utils/peerColors'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DisplayMessage, ReplyTo, Alias, PendingDeadMan } from '@/types'

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
  clipboardEnabled:     boolean
  onToggleClipboard:    () => void
  duressDetected?:      boolean
  onTyping?:            () => void
  typingAliases?:       Alias[]
  pendingDeadMans?:     PendingDeadMan[]
  onArmDeadMan?:        (body: string, activateSeconds: number, tokenHash: string) => Promise<boolean>
  onCancelDeadMan?:     (eventId: string) => Promise<void>
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
  clipboardEnabled,
  onToggleClipboard,
  duressDetected,
  onTyping,
  typingAliases = [],
  pendingDeadMans = [],
  onArmDeadMan,
  onCancelDeadMan,
}: ChatRoomProps) {
  const [terminating, setTerminating] = useState(false)
  const [clipboardFlash, setClipboardFlash] = useState(false)

  // ── Dead man's switch modal ─────────────────────────────────────────────
  const [showDeadManModal, setShowDeadManModal] = useState(false)
  const [deadManTimerSecs, setDeadManTimerSecs] = useState(DEADMAN_TIMER_OPTIONS[0]!.seconds)
  const [deadManBody, setDeadManBody]           = useState('')
  const [deadManArming, setDeadManArming]       = useState(false)

  // Token confirmation modal (shown after successful ARM)
  const [armedToken, setArmedToken]             = useState<string | null>(null)

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

  const openDeadManModal = useCallback(() => {
    setDeadManBody('')
    setDeadManTimerSecs(DEADMAN_TIMER_OPTIONS[0]!.seconds)
    setShowDeadManModal(true)
  }, [])

  const handleArmDeadMan = useCallback(async () => {
    if (!deadManBody.trim() || !onArmDeadMan) return
    setDeadManArming(true)

    // Generate 6-char alphanumeric cancellation token
    const token = Math.random().toString(36).substring(2, 8).toUpperCase()

    // Hash the token with SHA-256 - only the hash goes into the encrypted payload
    const encoder    = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(token))
    const tokenHash  = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    const ok = await onArmDeadMan(deadManBody.trim(), deadManTimerSecs, tokenHash)
    setDeadManArming(false)
    setShowDeadManModal(false)
    if (ok) {
      setArmedToken(token)  // show token confirmation modal
    }
  }, [deadManBody, deadManTimerSecs, onArmDeadMan])

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
    setReplyTo({ id: msg.id, body: msg.body.slice(0, 100), alias: msg.alias })
  }, [])

  const handleCancelReply = useCallback(() => setReplyTo(null), [])

  const handleSend = useCallback((body: string, ttlSecs: number) => {
    onSend(body, ttlSecs, replyTo ?? undefined)
    setReplyTo(null)
  }, [onSend, replyTo])

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
    const timer = setTimeout(() => setShowWaitModal(true), 20_000)
    return () => clearTimeout(timer)
  }, [peerCount, waitModalDismissed])

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

  function handleToggleClipboard() {
    const turningOn = !clipboardEnabled
    onToggleClipboard()
    if (turningOn) {
      setClipboardFlash(true)
      setTimeout(() => setClipboardFlash(false), 2000)
    }
  }

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
            <div className={`peer-dot ${peerDotClass}`} />
            <span className="peer-label">{peerLabel}</span>
          </div>
        </div>

        <div className="header-actions">
          <button
            className={`action-btn${clipboardEnabled ? ' clipboard-on' : ''}`}
            onClick={handleToggleClipboard}
            title={clipboardEnabled ? 'Clipboard enabled - click to disable' : 'Enable clipboard for this session'}
            style={clipboardFlash ? { color: 'rgba(200,170,80,1)', borderColor: 'rgba(200,170,80,0.4)', background: 'rgba(200,170,80,0.1)' } : undefined}
          >
            {clipboardFlash ? '✓' : clipboardEnabled ? 'CLIPBOARD ON' : 'CLIPBOARD OFF'}
          </button>

          <button className="action-btn leave" onClick={onLeave}>
            LEAVE
          </button>

          <button
            className={`action-btn terminate${terminating ? ' nuking' : ''}`}
            onClick={handleTerminate}
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
            onClick={handleTerminate}
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
          typing...
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
                      <button className="pending-deadman-verify" onClick={() => handleVerifyCode(dm)} type="button">
                        VERIFY
                      </button>
                      <button className="pending-deadman-dismiss" onClick={() => cancelEntering(dm.eventId)} type="button">
                        X
                      </button>
                    </div>
                  ) : (
                    <button
                      className={`pending-deadman-enter${hasError ? ' error' : ''}`}
                      onClick={() => startEntering(dm.eventId)}
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
        placeholder={peerCount === 0 ? 'no peers - queue a message...' : 'type message...'}
        dropError={dropError}
        onClearError={onClearError}
        rateLimited={rateLimited}
        hasPeers={peerCount > 0}
        replyTo={replyTo}
        onCancelReply={handleCancelReply}
        onTyping={handleTyping}
        {...(onArmDeadMan ? { onOpenDeadMan: openDeadManModal } : {})}
      />

      {/* Footer */}
      <div className="chat-footer">
        <span className="panic-hint">panic esc × 3 · decoy shift × 5</span>
        <span className="session-hint">{alias} · session expires on disconnect</span>
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
                onClick={() => setArmedToken(null)}
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
            <div className="warn-body">
              Write a message and set a delay. If no one cancels it before the timer expires, the message will appear automatically to anyone who opens this room.
            </div>
            <div className="deadman-timer-selector">
              {DEADMAN_TIMER_OPTIONS.map(opt => (
                <button
                  key={opt.seconds}
                  className={`deadman-timer-opt${deadManTimerSecs === opt.seconds ? ' active' : ''}`}
                  onClick={() => setDeadManTimerSecs(opt.seconds)}
                  type="button"
                >
                  {opt.label}
                </button>
              ))}
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
            <div className="warn-actions">
              <button
                className="warn-btn ghost"
                onClick={() => setShowDeadManModal(false)}
                disabled={deadManArming}
                type="button"
              >
                CANCEL
              </button>
              <button
                className="warn-btn primary"
                onClick={handleArmDeadMan}
                disabled={!deadManBody.trim() || deadManArming}
                type="button"
              >
                {deadManArming ? 'ARMING...' : 'ARM'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connection unavailable modal - shown after 20s of continuous waiting */}
      {showWaitModal && (
        <div className="modal-backdrop">
          <div className="warn-dialog">
            <div className="warn-title">connection unavailable</div>
            <div className="warn-body">
              Your network may not support direct peer-to-peer connections. You can still communicate using dead drop mode. New messages appear automatically every 30 seconds.
            </div>
            <div className="warn-actions">
              <button className="warn-btn ghost" onClick={onLeave}>
                leave
              </button>
              <button
                className="warn-btn primary"
                onClick={() => { setWaitModalDismissed(true); setShowWaitModal(false) }}
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
