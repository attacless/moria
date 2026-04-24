interface WarnDialogProps {
  onStay:                 () => void
  onDisconnect:           () => void
  secondsUntilDisconnect: number
}

export function WarnDialog({ onStay, onDisconnect, secondsUntilDisconnect }: WarnDialogProps) {
  const countdownClass = secondsUntilDisconnect < 10 ? 'red'
    : secondsUntilDisconnect < 30 ? 'amber'
    : ''

  return (
    <div className="modal-backdrop">
      <div className="warn-dialog">
        <div className="warn-title">Session Inactive</div>
        <div className="warn-body">
          No activity detected. You will be disconnected automatically.
        </div>
        <div className={`warn-countdown${countdownClass ? ` ${countdownClass}` : ''}`}>
          {secondsUntilDisconnect}
        </div>
        <div className="warn-actions">
          <button className="warn-btn primary" onClick={onStay}>
            Stay Connected
          </button>
          <button className="warn-btn ghost" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      </div>
    </div>
  )
}
