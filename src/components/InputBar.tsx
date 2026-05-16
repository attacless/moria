import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type ClipboardEvent, type DragEvent, type ChangeEvent } from 'react'
import type { ReplyTo } from '@/types'

const TTL_OPTIONS = [
  { label: '2h',  seconds: 2  * 60 * 60 },
  { label: '4h',  seconds: 4  * 60 * 60 },
  { label: '6h',  seconds: 6  * 60 * 60 },
  { label: '8h',  seconds: 8  * 60 * 60 },
  { label: '12h', seconds: 12 * 60 * 60 },
  { label: '24h', seconds: 24 * 60 * 60 },
]

const DEFAULT_TTL     = TTL_OPTIONS[TTL_OPTIONS.length - 1].seconds  // 24h
const IMAGE_MAX_BYTES = 2 * 1024 * 1024

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
  onOpenDeadMan?:  () => void
  onSendImage?:    (file: File) => void
}

export function InputBar({ onSend, disabled, placeholder, dropError, onClearError, rateLimited, hasPeers, replyTo, onCancelReply, onTyping, onOpenDeadMan, onSendImage }: InputBarProps) {
  const [value, setValue]                     = useState('')
  const [mediaBlockedMsg, setMediaBlockedMsg] = useState<string | null>(null)
  const [dragging, setDragging]               = useState(false)
  const [ttlSecs, setTtlSecs]                 = useState(DEFAULT_TTL)
  const [popoverOpen, setPopoverOpen]         = useState(false)

  // Image preview state
  const [imageFile, setImageFile]             = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const plusBtnRef   = useRef<HTMLButtonElement>(null)
  const popoverRef   = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dropError) return
    const t = setTimeout(() => onClearError?.(), 4_000)
    return () => clearTimeout(t)
  }, [dropError, onClearError])

  // Revoke preview URL on unmount
  useEffect(() => {
    return () => { if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl) }
  }, [imagePreviewUrl])

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return
    function onDown(e: MouseEvent) {
      if (
        popoverRef.current  && !popoverRef.current.contains(e.target as Node) &&
        plusBtnRef.current  && !plusBtnRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [popoverOpen])

  function showMediaBlocked(msg?: string) {
    setMediaBlockedMsg(msg ?? 'files and images cannot be sent - text only')
    setTimeout(() => setMediaBlockedMsg(null), 3_000)
  }

  function stageImageFile(file: File) {
    if (file.size > IMAGE_MAX_BYTES) {
      showMediaBlocked('image too large - 2 MB maximum')
      return
    }
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl)
    const url = URL.createObjectURL(file)
    setImageFile(file)
    setImagePreviewUrl(url)
  }

  function clearImagePreview() {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl)
    setImageFile(null)
    setImagePreviewUrl(null)
  }

  function handlePaste(e: ClipboardEvent) {
    const items     = Array.from(e.clipboardData.items)
    const imageItem = items.find(item => item.kind === 'file' && item.type.startsWith('image/'))

    if (imageItem) {
      e.preventDefault()
      if (!hasPeers || !onSendImage) {
        showMediaBlocked('images can only be sent when a peer is connected')
        return
      }
      const file = imageItem.getAsFile()
      if (!file) return
      stageImageFile(file)
      return
    }

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

  function handleImgSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset so the same file can be re-selected after clearing
    e.target.value = ''
    stageImageFile(file)
  }

  const handleSend = useCallback(() => {
    if (disabled) return

    if (imageFile && onSendImage) {
      onSendImage(imageFile)
      clearImagePreview()
      return
    }

    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed, ttlSecs)
    setValue('')
  }, [value, disabled, onSend, ttlSecs, imageFile, onSendImage])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const hasContent = value.trim().length > 0 || !!imageFile
  const showTTL    = !hasPeers

  return (
    <div
      className="input-bar-wrap"
      onDragEnter={() => setDragging(true)}
      onDragLeave={() => setDragging(false)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {mediaBlockedMsg && (
        <div className="media-blocked-banner">
          {mediaBlockedMsg}
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

      {imagePreviewUrl && (
        <div className="image-preview-bar">
          <img src={imagePreviewUrl} className="image-preview-thumb" alt="preview" />
          <span className="image-preview-label">image attached</span>
          <button
            className="reply-cancel"
            onClick={clearImagePreview}
            type="button"
            aria-label="Remove image"
          >
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
        {/* Hidden file input for image picker */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleImgSelect}
        />

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

        {/* MODE A: No peers - DEAD MAN + QUEUE (unchanged) */}
        {!hasPeers && (
          <>
            {onOpenDeadMan && (
              <button
                className="deadman-btn"
                onClick={onOpenDeadMan}
                type="button"
                title="Schedule a message to send automatically after a delay"
              >
                DEAD MAN
              </button>
            )}
            <button
              className={`send-btn${rateLimited ? ' rate-limited' : hasContent && !disabled ? ' active' : ''}`}
              onClick={handleSend}
              disabled={!hasContent || disabled || !!rateLimited}
            >
              {rateLimited ? 'SLOW DOWN' : 'QUEUE'}
            </button>
          </>
        )}

        {/* MODE B: Peers online - "+" attachment menu + SEND */}
        {hasPeers && (
          <>
            <div className="attach-btn-wrap">
              <button
                ref={plusBtnRef}
                className={`attach-btn${popoverOpen ? ' open' : ''}`}
                onClick={() => setPopoverOpen(o => !o)}
                type="button"
                aria-label="Attachments"
              >
                +
              </button>

              {popoverOpen && (
                <div ref={popoverRef} className="attach-popover">
                  {onSendImage && (
                    <button
                      className="attach-menu-item"
                      type="button"
                      onClick={() => { setPopoverOpen(false); fileInputRef.current?.click() }}
                    >
                      IMAGE
                    </button>
                  )}
                  {onOpenDeadMan && (
                    <button
                      className="attach-menu-item"
                      type="button"
                      onClick={() => { setPopoverOpen(false); onOpenDeadMan() }}
                    >
                      {"DEAD MAN'S SWITCH"}
                    </button>
                  )}
                </div>
              )}
            </div>

            <button
              className={`send-btn${rateLimited ? ' rate-limited' : hasContent && !disabled ? ' active' : ''}`}
              onClick={handleSend}
              disabled={!hasContent || disabled || !!rateLimited}
            >
              {rateLimited ? 'SLOW DOWN' : 'SEND'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
