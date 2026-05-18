import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type ClipboardEvent, type DragEvent, type ChangeEvent } from 'react'
import type { ReplyTo } from '@/types'
import { playClick } from '@/utils/sounds'
import { startRecording, stopRecording, cancelRecording } from '@/utils/voiceRecorder'

const VOICE_MAX_BYTES_P2P       = 2  * 1024 * 1024   // 2 MB live P2P
const VOICE_MAX_BYTES_DEAD_DROP = 500 * 1024          // 500 KB dead drop

function fmtElapsed(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const MicIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 90 90" fill="currentColor">
    <path d="M69.245 38.312c-1.104 0-2 .896-2 2v6.505c0 12.266-9.979 22.244-22.245 22.244s-22.245-9.979-22.245-22.244v-6.505c0-1.104-.896-2-2-2s-2 .896-2 2v6.505c0 13.797 10.705 25.134 24.245 26.16V86h-9.126c-1.104 0-2 .896-2 2s.896 2 2 2h22.252c1.104 0 2-.896 2-2s-.896-2-2-2H47V72.978c13.54-1.026 24.245-12.363 24.245-26.16v-6.505c0-1.104-.895-2-2-2z"/>
    <path d="M45 59.809c8.481 0 15.382-6.9 15.382-15.382V15.382C60.382 6.9 53.481 0 45 0S29.618 6.9 29.618 15.382v29.044c0 8.482 6.901 15.383 15.382 15.383zM33.618 15.382C33.618 9.106 38.724 4 45 4c6.276 0 11.382 5.106 11.382 11.382v29.044c0 6.276-5.105 11.382-11.382 11.382-6.276 0-11.382-5.106-11.382-11.382V15.382z"/>
  </svg>
)

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
  onSendVoice?:    (blob: Blob, duration: number) => void
}

export function InputBar({ onSend, disabled, placeholder, dropError, onClearError, rateLimited, hasPeers, replyTo, onCancelReply, onTyping, onOpenDeadMan, onSendImage, onSendVoice }: InputBarProps) {
  const [value, setValue]                     = useState('')
  const [mediaBlockedMsg, setMediaBlockedMsg] = useState<string | null>(null)
  const [dragging, setDragging]               = useState(false)
  const [ttlSecs, setTtlSecs]                 = useState(DEFAULT_TTL)
  const [popoverOpen, setPopoverOpen]         = useState(false)

  // Image preview state
  const [imageFile, setImageFile]             = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)

  // Voice recording state
  const [isReadyMode, setIsReadyMode]         = useState(false)
  const [isRecordingMode, setIsRecordingMode] = useState(false)
  const [elapsed, setElapsed]                 = useState(0)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  async function startVoiceRecording() {
    const maxBytes = hasPeers ? VOICE_MAX_BYTES_P2P : VOICE_MAX_BYTES_DEAD_DROP
    try {
      await startRecording(maxBytes, () => { handleSendVoice() })
      setIsRecordingMode(true)
      setElapsed(0)
      recordingTimerRef.current = setInterval(() => setElapsed(e => e + 1), 1_000)
    } catch {
      setMediaBlockedMsg('microphone access denied')
      setTimeout(() => setMediaBlockedMsg(null), 3_000)
    }
  }

  function handleVoiceTrigger() {
    setIsReadyMode(true)
  }

  async function handleStartFromReady() {
    setIsReadyMode(false)
    await startVoiceRecording()
  }

  function handleDismissReady() {
    setIsReadyMode(false)
  }

  async function handleSendVoice() {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
    const result = await stopRecording()
    setIsRecordingMode(false)
    setElapsed(0)
    if (result && onSendVoice) {
      onSendVoice(result.blob, result.duration)
    }
  }

  function handleCancelVoice() {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
    cancelRecording()
    setIsRecordingMode(false)
    setElapsed(0)
  }

  const handleSend = useCallback(() => {
    if (disabled) return

    if (imageFile && onSendImage) {
      playClick()
      onSendImage(imageFile)
      clearImagePreview()
      return
    }

    const trimmed = value.trim()
    if (!trimmed) return
    playClick()
    onSend(trimmed, ttlSecs)
    setValue('')
  }, [value, disabled, onSend, ttlSecs, imageFile, onSendImage])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const hasContent   = value.trim().length > 0 || !!imageFile
  const isVoiceStrip = isReadyMode || isRecordingMode
  const showTTL      = !hasPeers && !isVoiceStrip

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

      {!isVoiceStrip && replyTo && (
        <div className="reply-bar">
          <div className="reply-bar-text">
            {replyTo.body.length >= 100 ? replyTo.body.slice(0, 100) + '...' : replyTo.body}
          </div>
          <button className="reply-cancel" onClick={() => { playClick(); onCancelReply?.() }} type="button">
            {'✕'}
          </button>
        </div>
      )}

      {!isVoiceStrip && imagePreviewUrl && (
        <div className="image-preview-bar">
          <img src={imagePreviewUrl} className="image-preview-thumb" alt="preview" />
          <span className="image-preview-label">image attached</span>
          <button
            className="reply-cancel"
            onClick={() => { playClick(); clearImagePreview() }}
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
              onClick={() => { playClick(); setTtlSecs(opt.seconds) }}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Voice strip: ready state or recording state */}
      <div className="input-bar-row">
      {isVoiceStrip ? (
        <div className={`recording-bar${isRecordingMode ? ' recording-active' : ''}`}>
          {isReadyMode ? (
            <>
              <button className="rec-icon-btn rec-ready-mic" onClick={handleStartFromReady} type="button" aria-label="Start recording">
                <MicIcon size={24} />
              </button>
              <span className="rec-ready-label">TAP TO RECORD</span>
              <div style={{ flex: 1 }} />
              <button className="rec-icon-btn" onClick={handleDismissReady} type="button" aria-label="Dismiss">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </>
          ) : (
            <>
              <div className="rec-dot" />
              <span className="rec-label">RECORDING</span>
              <span className="rec-elapsed">{fmtElapsed(elapsed)}</span>
              <div className="rec-actions">
                <button className="rec-icon-btn recording-delete-btn" onClick={handleCancelVoice} type="button" aria-label="Cancel recording">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 11V17"/>
                    <path d="M14 11V17"/>
                    <path d="M4 7H20"/>
                    <path d="M6 7H12H18V18C18 19.6569 16.6569 21 15 21H9C7.34315 21 6 19.6569 6 18V7Z"/>
                    <path d="M9 5C9 3.89543 9.89543 3 11 3H13C14.1046 3 15 3.89543 15 5V7H9V5Z"/>
                  </svg>
                </button>
                <button className="rec-icon-btn recording-send-btn" onClick={handleSendVoice} type="button" aria-label="Send voice message">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                    <path d="M20 4L3 11L10 14L13 21L20 4Z"/>
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
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

          {/* MODE A: No peers - mic + DEAD MAN + QUEUE */}
          {!hasPeers && (
            <>
              {onSendVoice && (
                <button
                  className="mic-btn"
                  onClick={handleVoiceTrigger}
                  type="button"
                  title="Record a voice message"
                >
                  <MicIcon />
                </button>
              )}
              {onOpenDeadMan && (
                <button
                  className="deadman-btn"
                  onClick={() => { playClick(); onOpenDeadMan() }}
                  type="button"
                  title="Schedule a message to send automatically after a delay"
                >
                  DEAD MAN
                </button>
              )}
              <button
                className={`deadman-btn${rateLimited ? ' rate-limited' : hasContent && !disabled ? ' active' : ''}`}
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
                  onClick={() => { playClick(); setPopoverOpen(o => !o) }}
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
                        onClick={() => { playClick(); setPopoverOpen(false); fileInputRef.current?.click() }}
                      >
                        IMAGE
                      </button>
                    )}
                    {onSendVoice && (
                      <button
                        className="attach-menu-item"
                        type="button"
                        onClick={() => { playClick(); setPopoverOpen(false); handleVoiceTrigger() }}
                      >
                        VOICE MESSAGE
                      </button>
                    )}
                    {onOpenDeadMan && (
                      <button
                        className="attach-menu-item"
                        type="button"
                        onClick={() => { playClick(); setPopoverOpen(false); onOpenDeadMan() }}
                      >
                        {"DEAD MAN'S SWITCH"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <button
                className={`deadman-btn send-live${rateLimited ? ' rate-limited' : hasContent && !disabled ? ' active' : ''}`}
                onClick={handleSend}
                disabled={!hasContent || disabled || !!rateLimited}
              >
                {rateLimited ? 'SLOW DOWN' : 'SEND'}
              </button>
            </>
          )}
        </div>
      )}
      </div>{/* end input-bar-row */}
    </div>
  )
}
