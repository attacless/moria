import { useState } from 'react'
import { MessageList } from './MessageList'
import { InputBar }    from './InputBar'
import type { DisplayMessage } from '@/types'

interface ChatRoomProps {
  roomId:               string
  alias:                string
  peerCount:            number
  presenceCount:        number
  messages:             DisplayMessage[]
  burnSecondsRemaining: (msg: DisplayMessage) => number | null
  onSend:               (body: string) => void
  onLeave:              () => void
  onTerminate:          () => Promise<void>
  onConfirmDeadDrop:    (id: string) => void
  onConfirmAll:         () => void
  dropError?:           string | null
  onClearError?:        () => void
  rateLimited?:         boolean
  roomFull?:            boolean
  clipboardEnabled:     boolean
  onToggleClipboard:    () => void
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
  onConfirmAll,
  dropError,
  onClearError,
  rateLimited,
  roomFull,
  clipboardEnabled,
  onToggleClipboard,
}: ChatRoomProps) {
  const [terminating, setTerminating] = useState(false)

  async function handleTerminate() {
    setTerminating(true)
    await onTerminate()
    setTerminating(false)
  }

  const roomDisplay = roomId.length >= 8
    ? `${roomId.slice(0, 4)}·${roomId.slice(4, 8)}`
    : roomId

  const peerDotClass = peerCount > 0 ? 'active'
    : presenceCount > 0 ? 'connecting'
    : 'waiting'

  const peerLabel = peerCount > 0 ? `${peerCount + 1} in room`
    : presenceCount > 0 ? 'connecting...'
    : 'waiting'

  const pendingDrops    = messages.filter(m => m.isDeadDrop && !m.confirmed).length
  const showBulkAction  = pendingDrops > 0 && peerCount === 0

  return (
    <div className="chat-app">

      {/* Header */}
      <div className="chat-header">
        <div className="header-left">
          <span className="room-id">{roomDisplay}</span>
          <div className="peer-indicator">
            <div className={`peer-dot ${peerDotClass}`} />
            <span className="peer-label">{peerLabel}</span>
          </div>
        </div>

        <div className="header-center">MORIA</div>

        <div className="header-actions">
          <button
            className={`action-btn${clipboardEnabled ? ' clipboard-on' : ''}`}
            onClick={onToggleClipboard}
            title={clipboardEnabled ? 'Clipboard enabled - click to disable' : 'Enable clipboard for this session'}
          >
            {clipboardEnabled ? 'CLIPBOARD ON' : 'CLIPBOARD OFF'}
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

      {/* Clipboard banner */}
      {clipboardEnabled && (
        <div className="room-banner amber">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="banner-icon">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
            <rect x="9" y="3" width="6" height="4" rx="1"/>
          </svg>
          clipboard enabled - auto-clears after 15 seconds
        </div>
      )}

      {/* Room full banner */}
      {roomFull && (
        <div className="room-banner red">
          room is full - 50 participant limit reached
        </div>
      )}

      {/* Bulk action banner */}
      {showBulkAction && (
        <div className="bulk-banner">
          <span className="bulk-banner-text">
            <strong>{pendingDrops}</strong> message{pendingDrops > 1 ? 's' : ''} queued for pickup
          </span>
          <button className="mark-all-btn" onClick={onConfirmAll}>
            MARK ALL READ
          </button>
        </div>
      )}

      {/* Messages */}
      <MessageList
        messages={messages}
        myAlias={alias}
        burnSecondsRemaining={burnSecondsRemaining}
        onConfirmDeadDrop={onConfirmDeadDrop}
        onConfirmAll={onConfirmAll}
        hasPeers={peerCount > 0}
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

    </div>
  )
}
