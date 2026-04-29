import { useState, useCallback, useEffect } from 'react'
import { MessageList } from './MessageList'
import { InputBar }    from './InputBar'
import { webRTCAvailable } from '@/capabilities'
import type { DisplayMessage } from '@/types'

interface ChatRoomProps {
  roomId:               string
  alias:                string
  peerCount:            number
  presenceCount:        number
  messages:             DisplayMessage[]
  burnSecondsRemaining: (msg: DisplayMessage) => number | null
  onSend:               (body: string, ttlSeconds: number) => void
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
}: ChatRoomProps) {
  const [terminating, setTerminating] = useState(false)
  const [clipboardFlash, setClipboardFlash] = useState(false)

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
      />

      {/* Input */}
      <InputBar
        onSend={onSend}
        disabled={false}
        placeholder={peerCount === 0 ? 'no peers - queue a message...' : 'type message...'}
        dropError={dropError}
        onClearError={onClearError}
        rateLimited={rateLimited}
        hasPeers={peerCount > 0}
      />

      {/* Footer */}
      <div className="chat-footer">
        <span className="panic-hint">panic esc × 3 · decoy shift × 5</span>
        <span className="session-hint">{alias} · session expires on disconnect</span>
      </div>

      {/* Connection unavailable modal - shown after 20s of continuous waiting */}
      {showWaitModal && (
        <div className="modal-backdrop">
          <div className="warn-dialog">
            <div className="warn-title">connection unavailable</div>
            <div className="warn-body">
              Your network may not support direct peer-to-peer connections. You can still communicate using dead drop mode. Leave and rejoin the room to check for new dead drop messages.
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
