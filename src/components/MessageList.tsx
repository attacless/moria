import { useEffect, useRef } from 'react'
import type { DisplayMessage } from '@/types'

interface MessageListProps {
  messages:             DisplayMessage[]
  myAlias:              string
  burnSecondsRemaining: (msg: DisplayMessage) => number | null
  onConfirmDeadDrop:    (id: string) => void
  onConfirmAll:         () => void
  hasPeers:             boolean
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

export function MessageList({ messages, myAlias: _myAlias, burnSecondsRemaining, onConfirmDeadDrop, hasPeers }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

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

        const showMarkRead = msg.isDeadDrop && !msg.confirmed && !hasPeers && !isMe

        // Fade-out approaching expiry
        const opacity    = burn === null ? 1 : burn > 30 ? 1 : Math.max(0.05, burn / 30)
        const transition = burn !== null && burn <= 30 ? 'opacity 1s linear' : 'none'

        return (
          <div
            key={msg.id}
            className={`message fade-in ${isMe ? 'own' : 'received'}`}
            style={{ opacity, transition }}
          >
            {/* Meta row: timestamp (left) + burn timer (right) — no alias */}
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

            {/* Footer: status text + mark read */}
            <div className="msg-footer">
              {/* Own message status — failed takes priority, expiry replaces standalone queued badge */}
              {isMe && msg.queuedStatus && (
                <span className={`msg-status ${msg.queuedStatus}`}>
                  {msg.queuedStatus === 'failed'  && 'failed · try again'}
                  {msg.queuedStatus === 'sending' && 'sending...'}
                  {msg.queuedStatus === 'queued'  && msg.queuedExpiresAt &&
                    `queued · expires ${formatTTL(msg.queuedExpiresAt)}`}
                </span>
              )}

              {/* Received dead drop — waiting for peer to confirm */}
              {!isMe && msg.isDeadDrop && !msg.confirmed && (
                <span className="msg-status waiting">waiting</span>
              )}

              {/* Mark read button */}
              {showMarkRead && (
                <button
                  className="mark-read-btn"
                  onClick={() => onConfirmDeadDrop(msg.id)}
                >
                  MARK READ
                </button>
              )}
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
