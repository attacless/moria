import { useState, useEffect, useRef } from 'react'
import type { DisplayMessage } from '@/types'

interface StegoModeProps {
  messages: DisplayMessage[]
  myAlias:  string
  onSend:   (body: string) => void
  onExit:   () => void
}

const SHIFT_COUNT  = 5
const SHIFT_WINDOW = 1_000

export function StegoMode({ messages, myAlias: _myAlias, onSend, onExit }: StegoModeProps) {
  const [input, setInput] = useState('')
  const presses           = useRef<number[]>([])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Shift') return
      const now = Date.now()
      presses.current.push(now)
      presses.current = presses.current.filter(t => now - t < SHIFT_WINDOW)
      if (presses.current.length >= SHIFT_COUNT) {
        presses.current = []
        onExit()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onExit])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (input.trim()) { onSend(input.trim()); setInput('') }
    }
  }

  return (
    <div className="stego-mode">
      {/* Fake menu bar */}
      <div className="stego-menubar">
        {['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Help'].map(item => (
          <span key={item} className="stego-menu-item">{item}</span>
        ))}
      </div>

      {/* Fake toolbar */}
      <div className="stego-toolbar">
        {['B', 'I', 'U'].map(t => (
          <button key={t} className="stego-tool-btn"
            style={{ fontWeight: t === 'B' ? 'bold' : 'normal', fontStyle: t === 'I' ? 'italic' : 'normal', textDecoration: t === 'U' ? 'underline' : 'none' }}>
            {t}
          </button>
        ))}
        <div className="stego-sep" />
        <select className="stego-font-select" defaultValue="Arial">
          <option>Arial</option>
          <option>Times New Roman</option>
          <option>Courier New</option>
        </select>
        <select className="stego-font-select" defaultValue="12">
          <option>10</option>
          <option>11</option>
          <option>12</option>
          <option>14</option>
        </select>
      </div>

      {/* Document body — messages as paragraphs */}
      <div className="chat-messages stego-body">
        {messages
          .filter(m => m.alias !== 'system')
          .map(msg => (
            <p key={msg.id} style={{ marginBottom: '8px' }}>
              {msg.body}
            </p>
          ))}
        <span className="stego-cursor" />
      </div>

      {/* Input as document continuation */}
      <div className="stego-input-area">
        <textarea
          className="stego-textarea"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder=""
          autoFocus
          rows={2}
        />
      </div>
    </div>
  )
}
