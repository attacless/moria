import { useEffect, useRef, useState } from 'react'

interface VoicePlayerProps {
  audioUrl: string
  duration: number   // wall-clock seconds from recorder; 0 = unknown
}

// Each base64 chunk is CHUNK_SIZE (6000) chars; each char carries 6 bits = 4500 bytes.
// At 32 kbps = 4000 bytes/sec => ~1.125 sec per chunk.
const SECS_PER_CHUNK = 6000 * 6 / 8 / (32_000 / 8)  // = 1.125

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function VoicePlayer({ audioUrl, duration }: VoicePlayerProps) {
  const audioRef           = useRef<HTMLAudioElement | null>(null)
  const trackRef           = useRef<HTMLDivElement>(null)
  const isPlayingRef       = useRef(false)
  const pollerRef          = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastTimeupdateRef  = useRef(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  // Honour prop duration; fall back to per-chunk estimate when 0/unknown.
  // totalChunks is not available here, so we just use duration as passed.
  const knownDuration = duration > 0 && isFinite(duration)

  function stopPoller() {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null }
  }

  function handleEnd() {
    stopPoller()
    isPlayingRef.current = false
    setIsPlaying(false)
    setCurrentTime(0)
  }

  useEffect(() => {
    const audio = new Audio(audioUrl)
    audioRef.current = audio

    const onTime = () => {
      lastTimeupdateRef.current = Date.now()
      setCurrentTime(audio.currentTime)
      // Belt-and-suspenders end detection for browsers with broken duration metadata
      if (knownDuration && audio.currentTime >= duration - 0.5) {
        audio.pause()
        handleEnd()
      }
    }

    const onEnded = () => handleEnd()

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended',      onEnded)

    return () => {
      stopPoller()
      audio.pause()
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended',      onEnded)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl])

  function togglePlay(e: React.MouseEvent) {
    e.stopPropagation()
    const audio = audioRef.current
    if (!audio) return

    if (isPlayingRef.current) {
      audio.pause()
      stopPoller()
      isPlayingRef.current = false
      setIsPlaying(false)
    } else {
      isPlayingRef.current = true
      setIsPlaying(true)
      lastTimeupdateRef.current = 0
      audio.play().catch(() => {
        isPlayingRef.current = false
        setIsPlaying(false)
      })

      // Safari fallback: if timeupdate hasn't fired 500 ms after play,
      // start a 100 ms interval to poll audio.currentTime directly.
      const playStart = Date.now()
      setTimeout(() => {
        if (!isPlayingRef.current) return
        if (lastTimeupdateRef.current >= playStart) return   // timeupdate fired normally
        pollerRef.current = setInterval(() => {
          const a = audioRef.current
          if (!a) return
          setCurrentTime(a.currentTime)
          if (knownDuration && a.currentTime >= duration - 0.5) {
            a.pause()
            handleEnd()
          }
        }, 100)
      }, 500)
    }
  }

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    const audio = audioRef.current
    const track = trackRef.current
    if (!audio || !track || !knownDuration) return
    const rect    = track.getBoundingClientRect()
    const ratio   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const seekTo  = ratio * duration
    audio.currentTime = seekTo
    setCurrentTime(seekTo)
  }

  const pct = knownDuration ? (currentTime / duration) * 100 : 0

  function durationLabel(): string {
    if (isPlaying) {
      return knownDuration
        ? `${fmtTime(currentTime)} / ${fmtTime(duration)}`
        : fmtTime(currentTime)
    }
    return knownDuration ? fmtTime(duration) : ''
  }

  return (
    <div className="voice-player">
      <button
        className="voice-play-btn"
        onClick={togglePlay}
        type="button"
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying
          ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 4h4v16H6zM14 4h4v16h-4z"/>
            </svg>
          )
          : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          )
        }
      </button>

      <div
        ref={trackRef}
        className="voice-track"
        onClick={handleTrackClick}
      >
        <div className="voice-track-fill" style={{ width: `${pct}%` }} />
      </div>

      <span className="voice-duration">{durationLabel()}</span>
    </div>
  )
}

// Exported so dead drop reassembly can estimate duration when chunk 0 is lost.
export { SECS_PER_CHUNK }
