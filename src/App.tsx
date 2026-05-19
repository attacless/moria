import { useState, useEffect, useCallback, useRef } from 'react'
import { initSounds }         from '@/utils/sounds'
import { useRoom }            from '@hooks/useRoom'
import { usePanic }           from '@hooks/usePanic'
import { useInactivityTimer } from '@hooks/useInactivityTimer'
import { EntryScreen }        from '@components/EntryScreen'
import { ChatRoom }           from '@components/ChatRoom'
import { StegoMode }          from '@components/StegoMode'
import { WarnDialog }         from '@components/WarnDialog'

export type Theme = 'moria' | 'mithril'

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
    duressDetected,
    sendTyping,
    typingAliases,
    pendingDeadMans,
    armDeadMan,
    cancelDeadMan,
    sendImage,
    sendVoice,
    sendVoiceDeadDrop,
    getPerPeerWatchwords,
    isSendingMedia,
    mediaSendProgress,
  } = useRoom()

  const [stegoMode, setStegoMode] = useState(false)
  const [theme, setTheme]         = useState<Theme>('moria')

  // Chat fade-in entrance animation
  const [chatVisible, setChatVisible] = useState(false)
  const prevScreenRef = useRef(screen)
  const chatWrapRef   = useRef<HTMLDivElement>(null)

  usePanic({ onPanic: panic })
  useInactivityTimer(screen === 'chat', { onWarn, onDisconnect })

  // Restore theme from sessionStorage on mount
  useEffect(() => {
    const saved = sessionStorage.getItem('moria-theme')
    if (saved === 'mithril') setTheme('mithril')
  }, [])

  // Persist theme to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('moria-theme', theme)
  }, [theme])

  // Sync body background to theme so wide-screen gutters match
  useEffect(() => {
    document.body.style.background = theme === 'mithril' ? '#FCFBFA' : '#000000'
  }, [theme])

  // Init audio on first user interaction to satisfy browser autoplay policy
  useEffect(() => {
    window.addEventListener('click',      initSounds, { once: true })
    window.addEventListener('touchstart', initSounds, { once: true })
    return () => {
      window.removeEventListener('click',      initSounds)
      window.removeEventListener('touchstart', initSounds)
    }
  }, [])

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

  // 5x Shift → stego mode
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

  const handleLeave    = useCallback(() => leave(), [leave])
  const handleToggleTheme = useCallback(() => setTheme(t => t === 'moria' ? 'mithril' : 'moria'), [])
  const roomId = sessionKeys?.roomId ?? ''

  return (
    <div className={theme === 'mithril' ? 'theme-mithril' : undefined} style={{ position: 'fixed', inset: 0, background: 'var(--bg-app)' }}>

      {screen === 'entry' && (
        <EntryScreen
          onJoin={join}
          isJoining={isJoining}
          error={error}
          theme={theme}
          onThemeToggle={handleToggleTheme}
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
              duressDetected={duressDetected}
              onTyping={sendTyping}
              typingAliases={typingAliases}
              pendingDeadMans={pendingDeadMans}
              onArmDeadMan={armDeadMan}
              onCancelDeadMan={cancelDeadMan}
              onSendImage={sendImage}
              onSendVoice={sendVoice}
              onSendVoiceDeadDrop={sendVoiceDeadDrop}
              onGetWatchwords={getPerPeerWatchwords}
              isSendingMedia={isSendingMedia}
              mediaSendProgress={mediaSendProgress}
              theme={theme}
              onThemeToggle={handleToggleTheme}
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
