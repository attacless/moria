import { useState, useCallback, useEffect, type FormEvent } from 'react'
import { StarSvg } from './StarSvg'

interface EntryScreenProps {
  onJoin:    (password: string) => Promise<void>
  isJoining: boolean
  error:     string | null
}

type StrengthLevel = 'none' | 'weak' | 'fair' | 'good' | 'strong'

function getStrength(val: string): StrengthLevel {
  const len = val.length
  if (len === 0) return 'none'
  if (len < 6)  return 'weak'
  if (len < 10) return 'fair'
  if (len < 16) return 'good'
  return 'strong'
}

const STRENGTH_CONFIG: Record<StrengthLevel, { pct: number; label: string }> = {
  none:   { pct: 0,   label: '' },
  weak:   { pct: 15,  label: 'WEAK' },
  fair:   { pct: 38,  label: 'FAIR' },
  good:   { pct: 62,  label: 'GOOD' },
  strong: { pct: 100, label: 'STRONG' },
}

const RELAY_POOL = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://relay.nostrplebs.com',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
]

export function EntryScreen({ onJoin, isJoining, error }: EntryScreenProps) {
  const [password, setPassword]         = useState('')
  const [showPass, setShowPass]         = useState(false)
  const [liveRelayCount, setLiveRelayCount] = useState<number | null>(null)

  const strength = getStrength(password)
  const cfg      = STRENGTH_CONFIG[strength]
  const canJoin  = password.length >= 6 && !isJoining

  useEffect(() => {
    let cancelled = false
    Promise.all(
      RELAY_POOL.map(url =>
        new Promise<boolean>(resolve => {
          try {
            const ws = new WebSocket(url)
            const t  = setTimeout(() => { ws.close(); resolve(false) }, 2_000)
            ws.onopen  = () => { clearTimeout(t); ws.close(); resolve(true) }
            ws.onerror = () => { clearTimeout(t); resolve(false) }
          } catch { resolve(false) }
        })
      )
    ).then(results => {
      if (!cancelled) setLiveRelayCount(results.filter(Boolean).length)
    })
    return () => { cancelled = true }
  }, [])

  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault()
    if (!canJoin) return
    await onJoin(password)
  }, [canJoin, onJoin, password])

  const relayState = liveRelayCount === null ? 'connecting'
    : liveRelayCount > 0 ? 'online' : 'offline'

  return (
    <>
    <div className={`entry-screen${isJoining ? ' exiting' : ''}`}>
      <div className="gate-wrap">

        {/* Star */}
        <div className={`star-wrap ${isJoining ? 'star-entering' : `star-${strength}`}`}>
          <StarSvg />
        </div>

        {/* Wordmark */}
        <div className="wordmark">MORIA</div>
        <div className="subtitle">nothing is stored · nothing survives</div>

        {/* Form */}
        <form className="entry-form" onSubmit={handleSubmit}>
          <div className={`input-wrap${error ? ' error' : ''}`}>
            <span className="input-float-label">Room secret</span>
            <input
              type={showPass ? 'text' : 'password'}
              className="password-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="speak, friend, and enter..."
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button type="button" className="toggle-vis" onClick={() => setShowPass(p => !p)}>
              {showPass ? 'HIDE' : 'SHOW'}
            </button>
          </div>

          <div className="strength-bar">
            <div
              className={`strength-fill${strength !== 'none' ? ` ${strength}` : ''}`}
              style={{ width: `${cfg.pct}%` }}
            />
          </div>
          <div
            className="strength-label"
            style={{ color: strength !== 'none' ? `var(--strength-${strength})` : 'var(--text-muted)' }}
          >
            {cfg.label}
          </div>

          <div className={`error-msg${error ? ' visible' : ''}`}>{error ?? ''}</div>

          <button
            type="submit"
            className={`enter-btn${canJoin ? ' enabled' : ''}${isJoining ? ' loading' : ''}`}
            disabled={!canJoin}
          >
            {isJoining ? 'DERIVING KEYS...' : 'ENTER ROOM'}
          </button>
        </form>
      </div>
    </div>

    {/* Relay status - fixed at bottom, outside centered container */}
    <div className={`relay-status${isJoining ? ' exiting' : ''}`}>
      <div className={`relay-dot${relayState === 'connecting' ? ' connecting' : relayState === 'offline' ? ' offline' : ''}`} />
      <span>
        {relayState === 'connecting' ? 'CONNECTING...' : relayState === 'online' ? 'ONLINE' : 'OFFLINE'}
      </span>
    </div>
    </>
  )
}
