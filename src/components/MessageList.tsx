import { useEffect, useRef } from 'react'
import type { DisplayMessage } from '@/types'

interface MessageListProps {
  messages:             DisplayMessage[]
  myAlias:              string
  burnSecondsRemaining: (msg: DisplayMessage) => number | null
  onConfirmDeadDrop:    (id: string) => void
  hasPeers:             boolean
  collapsedDrops:       Set<string>
  onToggleDropCollapse: (id: string) => void
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatBurn(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatTTL(expiresAt: number): string {
  const remaining    = Math.max(0, expiresAt - Date.now())
  const totalMinutes = Math.ceil(remaining / 60_000)
  const hours        = Math.floor(totalMinutes / 60)
  const minutes      = totalMinutes % 60
  if (hours > 0)   return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return 'expiring soon'
}

function getBurnClass(secs: number): string {
  if (secs < 30)  return 'critical'
  if (secs < 120) return 'warning'
  return ''
}

export function MessageList({ messages, myAlias: _myAlias, burnSecondsRemaining, onConfirmDeadDrop, hasPeers: _hasPeers, collapsedDrops, onToggleDropCollapse }: MessageListProps) {
  const bottomRef    = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(messages.length)

  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      // Only scroll when a message was ADDED - not when burn timer removes one
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevCountRef.current = messages.length
  }, [messages.length])

  function handleReveal(id: string, needsConfirm: boolean) {
    if (needsConfirm) {
      // Pre-reveal envelope: confirm - message defaults to open (not in collapsedDrops)
      onConfirmDeadDrop(id)
    } else {
      // Revealed/auto-confirmed: one tap toggles collapsed/open
      onToggleDropCollapse(id)
    }
  }

  return (
    <div
      className="chat-messages messages-area"
      style={{ flex: 1 }}
    >
      {messages.map(msg => {
        const isMe     = msg.isMine
        const isSystem = msg.alias === 'system'
        const burn     = burnSecondsRemaining(msg)

        if (isSystem) {
          return (
            <div key={msg.id} className="system-msg fade-in">
              {msg.body}
            </div>
          )
        }

        // Received dead drop that has NOT been confirmed yet - render collapsed/reveal UI
        // Own dead drops (queued messages) are never collapsed
        const isReceivedDeadDrop = !isMe && !!msg.isDeadDrop
        const needsConfirm       = isReceivedDeadDrop && !msg.confirmed

        if (isReceivedDeadDrop && needsConfirm) {
          // Collapsed dead drop envelope - not yet confirmed
          return (
            <div
              key={msg.id}
              className="message received dead-drop-collapsed fade-in"
              onClick={() => handleReveal(msg.id, true)}
            >
              <div className="dead-drop-header">
                <span className="msg-time">{formatTime(msg.timestamp)}</span>
                <span className="dead-drop-hint">dead drop · tap to reveal</span>
                <span className="dead-drop-chevron pulse">▶</span>
              </div>
            </div>
          )
        }

        if (isReceivedDeadDrop) {
          // Revealed dead drop (confirmed) - open by default, single tap to toggle
          const isOpen = !collapsedDrops.has(msg.id)

          // Fade-out approaching expiry
          const opacity    = burn === null ? 1 : burn > 30 ? 1 : Math.max(0.05, burn / 30)
          const transition = burn !== null && burn <= 30 ? 'opacity 1s linear' : 'none'

          const hintText = isOpen ? 'tap to collapse' : 'tap to expand'

          return (
            <div
              key={msg.id}
              className={`message received dead-drop-revealed fade-in${isOpen ? ' dead-drop-open' : ''}`}
              style={{ opacity, transition, cursor: 'pointer' }}
              onClick={() => handleReveal(msg.id, false)}
            >
              <div className="dead-drop-header">
                <span className="msg-time">{formatTime(msg.timestamp)}</span>
                {burn !== null ? (
                  <>
                    <span className={`dead-drop-burn ${getBurnClass(burn)}`}>
                      {formatBurn(burn)}
                    </span>
                    <span className="dead-drop-hint">{hintText}</span>
                  </>
                ) : (
                  <span className="dead-drop-hint">{hintText}</span>
                )}
                <span className={`dead-drop-chevron${isOpen ? ' rotated' : ''}`}>▶</span>
              </div>
              {isOpen && (
                <div className="dead-drop-body">
                  <div className="msg-body">{msg.body}</div>
                </div>
              )}
            </div>
          )
        }

        // Live chat message (own or received non-dead-drop) - unchanged
        const opacity    = burn === null ? 1 : burn > 30 ? 1 : Math.max(0.05, burn / 30)
        const transition = burn !== null && burn <= 30 ? 'opacity 1s linear' : 'none'

        return (
          <div
            key={msg.id}
            className={`message fade-in ${isMe ? 'own' : 'received'}`}
            style={{ opacity, transition }}
          >
            {/* Meta row: timestamp (left) + burn timer (right) - no alias */}
            <div className="msg-meta">
              <span className="msg-time">{formatTime(msg.timestamp)}</span>
              {burn !== null && !(isMe && msg.queuedStatus) && (
                <span className={`burn-timer ${getBurnClass(burn)}`}>
                  {formatBurn(burn)}
                </span>
              )}
            </div>

            {/* Body */}
            <div className="msg-body">{msg.body}</div>

            {/* Footer: status text */}
            <div className="msg-footer">
              {/* Own message status - failed takes priority, expiry replaces standalone queued badge */}
              {isMe && msg.queuedStatus && (
                <span className={`msg-status ${msg.queuedStatus}`}>
                  {msg.queuedStatus === 'failed'  && 'failed · try again'}
                  {msg.queuedStatus === 'sending' && 'sending...'}
                  {msg.queuedStatus === 'queued'  && msg.queuedExpiresAt &&
                    `queued · expires ${formatTTL(msg.queuedExpiresAt)}`}
                </span>
              )}
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
