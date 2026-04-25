import { useState, useEffect, useCallback, useRef } from 'react'
import { useRoom }            from '@hooks/useRoom'
import { usePanic }           from '@hooks/usePanic'
import { useInactivityTimer } from '@hooks/useInactivityTimer'
import { EntryScreen }        from '@components/EntryScreen'
import { ChatRoom }           from '@components/ChatRoom'
import { StegoMode }          from '@components/StegoMode'
import { WarnDialog }         from '@components/WarnDialog'

export default function App() {
  const {
    screen,
    messages,
    alias,
    peerCount,
    presenceCount,
    isJoining,
    error,
    showWarnDialog,
    dismissWarn,
    join,
    send,
    leave,
    panic,
    terminate,
    onWarn,
    onDisconnect,
    burnSecondsRemaining,
    warnCountdown,
    sessionKeys,
    dropError,
    clearDropError,
    confirmDeadDrop,
    rateLimited,
    roomFull,
    clipboardEnabled,
    toggleClipboard,
  } = useRoom()

  const [stegoMode, setStegoMode] = useState(false)
  // Chat fade-in entrance animation
  const [chatVisible, setChatVisible] = useState(false)
  const prevScreenRef = useRef(screen)
  const chatWrapRef   = useRef<HTMLDivElement>(null)

  usePanic({ onPanic: panic })
  useInactivityTimer(screen === 'chat', { onWarn, onDisconnect })

  // Track screen changes to drive chat entrance animation
  useEffect(() => {
    if (screen === 'chat' && prevScreenRef.current !== 'chat') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setChatVisible(true)
          setTimeout(() => {
            if (chatWrapRef.current) chatWrapRef.current.style.willChange = 'auto'
          }, 400)
        })
      })
    }
    if (screen === 'entry') setChatVisible(false)
    prevScreenRef.current = screen
  }, [screen])

  // 5× Shift → stego mode
  useEffect(() => {
    if (screen !== 'chat' || stegoMode) return
    const presses: number[] = []
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Shift') return
      const now = Date.now()
      presses.push(now)
      const recent = presses.filter(t => now - t < 1_000)
      presses.length = 0
      presses.push(...recent)
      if (presses.length >= 5) { presses.length = 0; setStegoMode(true) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [screen, stegoMode])

  useEffect(() => {
    if (screen === 'entry') setStegoMode(false)
  }, [screen])

  const handleLeave = useCallback(() => leave(), [leave])
  const roomId = sessionKeys?.roomId ?? ''

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)' }}>

      {screen === 'entry' && (
        <EntryScreen
          onJoin={join}
          isJoining={isJoining}
          error={error}
        />
      )}

      {screen === 'chat' && sessionKeys !== null && (
        <div ref={chatWrapRef} style={{
          position:      'fixed',
          inset:          0,
          opacity:       chatVisible ? 1 : 0,
          transition:    chatVisible ? 'opacity 0.3s ease-out' : 'none',
          willChange:    'opacity',
          transform:     'translateZ(0)',
          zIndex:         50,
          display:       'flex',
          flexDirection: 'column',
        }}>
          {stegoMode ? (
            <StegoMode
              messages={messages}
              myAlias={alias}
              onSend={send}
              onExit={() => setStegoMode(false)}
            />
          ) : (
            <ChatRoom
              roomId={roomId}
              alias={alias}
              peerCount={peerCount}
              presenceCount={presenceCount}
              messages={messages}
              burnSecondsRemaining={burnSecondsRemaining}
              onSend={send}
              onLeave={handleLeave}
              onTerminate={terminate}
              onConfirmDeadDrop={confirmDeadDrop}
              dropError={dropError}
              onClearError={clearDropError}
              rateLimited={rateLimited}
              roomFull={roomFull}
              clipboardEnabled={clipboardEnabled}
              onToggleClipboard={toggleClipboard}
            />
          )}

          {showWarnDialog && (
            <WarnDialog
              onStay={dismissWarn}
              onDisconnect={onDisconnect}
              secondsUntilDisconnect={warnCountdown}
            />
          )}
        </div>
      )}

    </div>
  )
}
