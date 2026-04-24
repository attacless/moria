import { useState, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react'

interface InputBarProps {
  onSend:        (body: string) => void
  disabled:      boolean
  placeholder?:  string
  dropError?:    string | null | undefined
  onClearError?: (() => void) | undefined
  rateLimited?:  boolean | undefined
  hasPeers?:     boolean | undefined
}

export function InputBar({ onSend, disabled, placeholder, dropError, onClearError, rateLimited, hasPeers }: InputBarProps) {
  const [value, setValue]           = useState('')
  const [mediaBlocked, setMediaBlocked] = useState(false)
  const [dragging, setDragging]     = useState(false)

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
    onSend(trimmed)
    setValue('')
  }, [value, disabled, onSend])

  const handleKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const hasContent = value.trim().length > 0

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
          files and images cannot be sent — text only
        </div>
      )}
      {dropError && (
        <div className="input-error-banner visible">
          {dropError}
        </div>
      )}
      <div className={`input-bar${dragging ? ' dragging' : ''}`}>
        <input
          type="text"
          className="msg-input chat-input"
          value={value}
          onChange={e => setValue(e.target.value)}
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
