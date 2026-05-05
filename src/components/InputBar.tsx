import { useState, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react'
import type { ReplyTo } from '@/types'

const TTL_OPTIONS = [
  { label: '2h',  seconds: 2  * 60 * 60 },
  { label: '4h',  seconds: 4  * 60 * 60 },
  { label: '6h',  seconds: 6  * 60 * 60 },
  { label: '8h',  seconds: 8  * 60 * 60 },
  { label: '12h', seconds: 12 * 60 * 60 },
  { label: '24h', seconds: 24 * 60 * 60 },
]

const DEFAULT_TTL = TTL_OPTIONS[TTL_OPTIONS.length - 1].seconds  // 24h

interface InputBarProps {
  onSend:          (body: string, ttlSeconds: number) => void
  disabled:        boolean
  placeholder?:    string
  dropError?:      string | null | undefined
  onClearError?:   (() => void) | undefined
  rateLimited?:    boolean | undefined
  hasPeers?:       boolean | undefined
  replyTo?:        ReplyTo | null
  onCancelReply?:  () => void
  onTyping?:       () => void
}

export function InputBar({ onSend, disabled, placeholder, dropError, onClearError, rateLimited, hasPeers, replyTo, onCancelReply, onTyping }: InputBarProps) {
  const [value, setValue]               = useState('')
  const [mediaBlocked, setMediaBlocked] = useState(false)
  const [dragging, setDragging]         = useState(false)
  const [ttlSecs, setTtlSecs]           = useState(DEFAULT_TTL)

  useEffect(() => {
    if (!dropError) return
    const t = setTimeout(() => onClearError?.(), 4_000)
    return () => clearTimeout(t)
  }, [dropError, onClearError])

  function showMediaBlocked() {
    setMediaBlocked(true)
    setTimeout(() => setMediaBlocked(false), 3_000)
  }

  function handlePaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData.items)
    if (items.some(item => item.kind !== 'string')) {
      e.preventDefault()
      showMediaBlocked()
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) showMediaBlocked()
  }

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed, ttlSecs)
    setValue('')
  }, [value, disabled, onSend, ttlSecs])

  const handleKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const hasContent = value.trim().length > 0
  const showTTL    = !hasPeers

  return (
    <div
      className="input-bar-wrap"
      onDragEnter={() => setDragging(true)}
      onDragLeave={() => setDragging(false)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {mediaBlocked && (
        <div className="media-blocked-banner">
          files and images cannot be sent - text only
        </div>
      )}
      {dropError && (
        <div className="input-error-banner visible">
          {dropError}
        </div>
      )}

      {replyTo && (
        <div className="reply-bar">
          <div className="reply-bar-text">
            {replyTo.body.length >= 100 ? replyTo.body.slice(0, 100) + '...' : replyTo.body}
          </div>
          <button className="reply-cancel" onClick={onCancelReply} type="button">
            {'✕'}
          </button>
        </div>
      )}

      {showTTL && (
        <div className="ttl-selector">
          <span className="ttl-prefix">expires</span>
          {TTL_OPTIONS.map(opt => (
            <button
              key={opt.seconds}
              className={`ttl-opt${ttlSecs === opt.seconds ? ' active' : ''}`}
              onClick={() => setTtlSecs(opt.seconds)}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <div className={`input-bar${dragging ? ' dragging' : ''}`}>
        <input
          type="text"
          className="msg-input chat-input"
          value={value}
          onChange={e => { setValue(e.target.value); if (e.target.value.trim()) onTyping?.() }}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder ?? (disabled ? 'waiting for peer...' : 'type message...')}
          autoComplete="off"
          spellCheck={false}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        />
        <button
          className={`send-btn${rateLimited ? ' rate-limited' : hasContent && !disabled ? ' active' : ''}`}
          onClick={handleSend}
          disabled={!hasContent || disabled || !!rateLimited}
        >
          {rateLimited ? 'SLOW DOWN' : hasPeers ? 'SEND' : 'QUEUE'}
        </button>
      </div>
    </div>
  )
}
