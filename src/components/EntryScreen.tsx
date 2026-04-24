import { useState, useCallback, useEffect, type FormEvent } from 'react'

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

// CSS custom property helper for SVG draw animation
function dp(len: number, delay: string): React.CSSProperties {
  return { '--path-len': len, '--draw-delay': delay } as React.CSSProperties
}

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

  const glowClass = strength !== 'none' ? `glow-${strength}` : ''
  const relayState = liveRelayCount === null ? 'connecting'
    : liveRelayCount > 0 ? 'online' : 'offline'

  return (
    <div className={`entry-screen${isJoining ? ' exiting' : ''}`}>
      <div className="gate-wrap">

        {/* Gate SVG */}
        <div className={`gate-container${isJoining ? ' opening' : ''}`}>
          <div className={`gate-svg-wrap ${glowClass}`}>
            <svg
              className="gate-svg"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 600 700"
              fill="none"
              stroke="var(--gate-stroke)"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-label="The Doors of Durin"
            >
              {/* ARCH */}
              <g className="gate-arch">
                <path className="draw-path" style={dp(680, '0.3s')} d="M110 360 Q110 130 300 130 Q490 130 490 360"/>
                <path className="draw-path" style={dp(640, '0.5s')} d="M128 360 Q128 148 300 148 Q472 148 472 360" opacity="0.9"/>

                {/* Inscription runes along arch */}
                <g opacity="0.85" strokeWidth="1">
                  <g transform="translate(300 360)">
                    <g className="draw-path" style={dp(40, '0.8s')} transform="rotate(-85)"><line x1="0" y1="-242" x2="0" y2="-232"/><circle cx="0" cy="-226" r="0.8" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '0.85s')} transform="rotate(-78)"><line x1="0" y1="-242" x2="0" y2="-230"/><line x1="-2" y1="-225" x2="2" y2="-225"/></g>
                    <g className="draw-path" style={dp(40, '0.9s')} transform="rotate(-71)"><line x1="-1" y1="-242" x2="-1" y2="-228"/><line x1="2" y1="-238" x2="2" y2="-228"/></g>
                    <g className="draw-path" style={dp(40, '0.95s')} transform="rotate(-64)"><line x1="0" y1="-242" x2="0" y2="-226"/><circle cx="0" cy="-232" r="1.1" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.0s')} transform="rotate(-57)"><line x1="-2" y1="-242" x2="-2" y2="-230"/><line x1="2" y1="-240" x2="2" y2="-226"/></g>
                    <g className="draw-path" style={dp(40, '1.05s')} transform="rotate(-50)"><path d="M 0 -240 Q 3 -234 0 -228 Q -3 -234 0 -240 Z" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.1s')} transform="rotate(-43)"><line x1="-1" y1="-242" x2="-1" y2="-228"/><line x1="3" y1="-238" x2="3" y2="-230"/></g>
                    <g className="draw-path" style={dp(40, '1.15s')} transform="rotate(-36)"><line x1="0" y1="-242" x2="0" y2="-228"/><circle cx="0" cy="-224" r="0.9" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.2s')} transform="rotate(-29)"><line x1="-2" y1="-242" x2="-2" y2="-226"/><line x1="2" y1="-242" x2="2" y2="-232"/></g>
                    <g className="draw-path" style={dp(40, '1.25s')} transform="rotate(-22)"><line x1="0" y1="-242" x2="0" y2="-228"/><line x1="-3" y1="-232" x2="3" y2="-232"/></g>
                    <g className="draw-path" style={dp(40, '1.3s')} transform="rotate(-15)"><path d="M -2 -240 Q 0 -226 2 -240" fill="none"/></g>
                    <g className="draw-path" style={dp(40, '1.35s')} transform="rotate(-8)"><line x1="0" y1="-242" x2="0" y2="-226"/><circle cx="0" cy="-232" r="1" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.4s')} transform="rotate(-1)"><line x1="-2" y1="-240" x2="-2" y2="-228"/><line x1="2" y1="-240" x2="2" y2="-228"/><circle cx="0" cy="-233" r="0.8" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.45s')} transform="rotate(6)"><line x1="0" y1="-242" x2="0" y2="-226"/><line x1="-3" y1="-232" x2="3" y2="-232"/></g>
                    <g className="draw-path" style={dp(40, '1.5s')} transform="rotate(13)"><path d="M -2 -240 Q 0 -226 2 -240" fill="none"/></g>
                    <g className="draw-path" style={dp(40, '1.55s')} transform="rotate(20)"><line x1="0" y1="-242" x2="0" y2="-228"/><circle cx="0" cy="-233" r="1.1" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.6s')} transform="rotate(27)"><line x1="-2" y1="-242" x2="-2" y2="-226"/><line x1="2" y1="-238" x2="2" y2="-230"/></g>
                    <g className="draw-path" style={dp(40, '1.65s')} transform="rotate(34)"><line x1="0" y1="-242" x2="0" y2="-228"/><line x1="-3" y1="-232" x2="3" y2="-232"/></g>
                    <g className="draw-path" style={dp(40, '1.7s')} transform="rotate(41)"><path d="M 0 -240 Q 3 -234 0 -228 Q -3 -234 0 -240 Z" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.75s')} transform="rotate(48)"><line x1="-1" y1="-242" x2="-1" y2="-228"/><line x1="3" y1="-240" x2="3" y2="-230"/></g>
                    <g className="draw-path" style={dp(40, '1.8s')} transform="rotate(55)"><line x1="0" y1="-242" x2="0" y2="-226"/><circle cx="0" cy="-231" r="0.9" fill="var(--gate-stroke)" stroke="none"/></g>
                    <g className="draw-path" style={dp(40, '1.85s')} transform="rotate(62)"><line x1="-2" y1="-242" x2="-2" y2="-228"/><line x1="2" y1="-240" x2="2" y2="-226"/></g>
                    <g className="draw-path" style={dp(40, '1.9s')} transform="rotate(69)"><line x1="0" y1="-242" x2="0" y2="-228"/><line x1="-3" y1="-235" x2="3" y2="-235"/></g>
                    <g className="draw-path" style={dp(40, '1.95s')} transform="rotate(76)"><line x1="-1" y1="-242" x2="-1" y2="-228"/><line x1="2" y1="-238" x2="2" y2="-228"/></g>
                    <g className="draw-path" style={dp(40, '2.0s')} transform="rotate(83)"><line x1="0" y1="-242" x2="0" y2="-232"/><circle cx="0" cy="-226" r="0.9" fill="var(--gate-stroke)" stroke="none"/></g>
                  </g>
                </g>

                {/* Crown and stars */}
                <g transform="translate(300 220)">
                  <path className="draw-path" style={dp(180, '1.2s')} d="M-30 4 L-30 -6 L-22 2 L-14 -14 L-6 2 L0 -20 L6 2 L14 -14 L22 2 L30 -6 L30 4 Z"/>
                  <line className="draw-path" style={dp(64, '1.3s')} x1="-32" y1="6" x2="32" y2="6"/>
                  <g fill="var(--gate-stroke)" stroke="none">
                    <g transform="translate(-70 -20)"><path d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>
                    <g transform="translate(-52 -34)"><path d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>
                    <g transform="translate(-30 -42)"><path d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>
                    <g transform="translate(0 -48)"><path d="M0 -5 L1.2 -1.2 L5 0 L1.2 1.2 L0 5 L-1.2 1.2 L-5 0 L-1.2 -1.2 Z"/></g>
                    <g transform="translate(30 -42)"><path d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>
                    <g transform="translate(52 -34)"><path d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>
                    <g transform="translate(70 -20)"><path d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>
                  </g>
                </g>

                {/* Anvil */}
                <g transform="translate(300 282)">
                  <path className="draw-path" style={dp(120, '1.4s')} d="M-22 10 L-18 0 L18 0 L22 10 Z"/>
                  <rect x="-10" y="10" width="20" height="4"/>
                  <path d="M-20 14 L20 14 L16 20 L-16 20 Z"/>
                  <path d="M-18 -10 L-2 -6 L0 -4 L-4 4 L-20 -2 Z"/>
                  <line x1="-18" y1="-10" x2="-26" y2="-16"/>
                </g>

                {/* Leaf tips */}
                <g transform="translate(88 120)" opacity="0.95" fill="var(--gate-stroke)" stroke="none"><path d="M0 0 q-3 5 0 10 q3 -5 0 -10 Z"/></g>
                <g transform="translate(512 120)" opacity="0.95" fill="var(--gate-stroke)" stroke="none"><path d="M0 0 q3 5 0 10 q-3 -5 0 -10 Z"/></g>
              </g>

              {/* LEFT DOOR */}
              <g className="gate-door-left">
                <path className="draw-path" style={dp(240, '0.3s')} d="M140 360 L140 330 L145 326 L245 326 L250 330 L250 360 Z"/>
                <line className="draw-path" style={dp(110, '0.4s')} x1="140" y1="344" x2="250" y2="344" opacity="0.6"/>
                <line className="draw-path" style={dp(300, '0.2s')} x1="170" y1="360" x2="170" y2="660"/>
                <line className="draw-path" style={dp(300, '0.25s')} x1="220" y1="360" x2="220" y2="660"/>
                <path className="draw-path" style={dp(160, '0.5s')} d="M158 660 L232 660 L240 672 L150 672 Z"/>
                <path className="draw-path" style={dp(200, '0.55s')} d="M140 672 L250 672 L258 684 L132 684 Z"/>
                <path className="draw-path" style={dp(400, '0.6s')} d="M195 360 C 170 380 225 395 200 420 C 175 440 225 455 200 480 C 175 500 225 515 200 540 C 175 560 225 575 200 600 C 175 615 220 630 195 650" opacity="0.9"/>
                <g opacity="0.95">
                  <path className="draw-path" style={dp(280, '0.7s')} d="M195 660 C 230 600 260 540 275 480 C 280 460 285 450 295 450" fill="none"/>
                  <path className="draw-path" style={dp(60, '0.85s')} d="M238 580 C 258 572 272 560 278 540"/>
                  <path className="draw-path" style={dp(60, '0.9s')} d="M252 540 C 270 534 282 524 286 508"/>
                  <path className="draw-path" style={dp(60, '0.95s')} d="M232 620 C 252 614 264 602 268 584"/>
                  <path d="M276 540 q-3 -6 4 -8 q4 4 -4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                  <path d="M286 508 q-3 -6 4 -8 q4 4 -4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                  <path d="M268 584 q-3 -6 4 -8 q4 4 -4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                  <path d="M278 540 q-3 -6 4 -8 q4 4 -4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                </g>
                <path d="M255 360 Q255 180 300 180 L300 660 L255 660 Z" opacity="0.35"/>
                <line className="draw-path" style={dp(180, '0.6s')} x1="120" y1="684" x2="300" y2="684" strokeWidth="1.4"/>
              </g>

              {/* RIGHT DOOR */}
              <g className="gate-door-right">
                <path className="draw-path" style={dp(240, '0.3s')} d="M350 360 L350 330 L355 326 L455 326 L460 330 L460 360 Z"/>
                <line className="draw-path" style={dp(110, '0.4s')} x1="350" y1="344" x2="460" y2="344" opacity="0.6"/>
                <line className="draw-path" style={dp(300, '0.2s')} x1="380" y1="360" x2="380" y2="660"/>
                <line className="draw-path" style={dp(300, '0.25s')} x1="430" y1="360" x2="430" y2="660"/>
                <path className="draw-path" style={dp(160, '0.5s')} d="M368 660 L442 660 L450 672 L360 672 Z"/>
                <path className="draw-path" style={dp(200, '0.55s')} d="M350 672 L460 672 L468 684 L342 684 Z"/>
                <path className="draw-path" style={dp(400, '0.6s')} d="M405 360 C 430 380 375 395 400 420 C 425 440 375 455 400 480 C 425 500 375 515 400 540 C 425 560 375 575 400 600 C 425 615 380 630 405 650" opacity="0.9"/>
                <g opacity="0.95">
                  <path className="draw-path" style={dp(280, '0.7s')} d="M405 660 C 370 600 340 540 325 480 C 320 460 315 450 305 450" fill="none"/>
                  <path className="draw-path" style={dp(60, '0.85s')} d="M362 580 C 342 572 328 560 322 540"/>
                  <path className="draw-path" style={dp(60, '0.9s')} d="M348 540 C 330 534 318 524 314 508"/>
                  <path className="draw-path" style={dp(60, '0.95s')} d="M368 620 C 348 614 336 602 332 584"/>
                  <path d="M324 540 q3 -6 -4 -8 q-4 4 4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                  <path d="M314 508 q3 -6 -4 -8 q-4 4 4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                  <path d="M332 584 q3 -6 -4 -8 q-4 4 4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                  <path d="M322 540 q3 -6 -4 -8 q-4 4 4 8 Z" fill="var(--gate-stroke)" stroke="none"/>
                </g>
                <path d="M300 180 Q345 180 345 360 L345 660 L300 660 Z" opacity="0.35"/>
                <line className="draw-path" style={dp(180, '0.6s')} x1="300" y1="684" x2="480" y2="684" strokeWidth="1.4"/>
              </g>

              {/* CENTER STAR */}
              <g transform="translate(300 460)">
                <g strokeWidth="1">
                  <line className="draw-path" style={dp(44, '1.5s')} x1="0" y1="-22" x2="0" y2="22"/>
                  <line className="draw-path" style={dp(44, '1.55s')} x1="-22" y1="0" x2="22" y2="0"/>
                  <line className="draw-path" style={dp(44, '1.6s')} x1="-15.5" y1="-15.5" x2="15.5" y2="15.5"/>
                  <line className="draw-path" style={dp(44, '1.65s')} x1="-15.5" y1="15.5" x2="15.5" y2="-15.5"/>
                  <path d="M0 -8 L8 0 L0 8 L-8 0 Z"/>
                </g>
              </g>
            </svg>
          </div>
        </div>

        {/* Wordmark */}
        <div className="wordmark">MORIA</div>
        <div className="subtitle">zero-knowledge · zero-server · ephemeral</div>

        {/* Form */}
        <form className="entry-form" onSubmit={handleSubmit}>
          <div className={`input-wrap${error ? ' error' : ''}`}>
            <span className="input-float-label">Room secret</span>
            <input
              type={showPass ? 'text' : 'password'}
              className="password-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="enter shared secret..."
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

      {/* Relay status */}
      <div className="relay-status">
        <div className={`relay-dot${relayState === 'connecting' ? ' connecting' : relayState === 'offline' ? ' offline' : ''}`} />
        <span>
          {relayState === 'connecting' ? 'CONNECTING...' : relayState === 'online' ? 'ONLINE' : 'OFFLINE'}
        </span>
      </div>
    </div>
  )
}
