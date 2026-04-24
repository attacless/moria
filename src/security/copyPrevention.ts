const STYLE_ID      = 'void-copy-prevention'
const CLIPBOARD_TTL = 15_000   // 15 seconds

let clipboardTimer: ReturnType<typeof setTimeout> | null = null
let hasCopied = false

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .chat-messages {
      user-select: none;
      -webkit-user-select: none;
    }
    .chat-messages * {
      user-select: none;
      -webkit-user-select: none;
    }
  `
  document.head.appendChild(style)
}

function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove()
}

function handleContextMenu(e: Event): void {
  e.preventDefault()
}

function handleCopy(): void {
  hasCopied = true
  if (clipboardTimer) clearTimeout(clipboardTimer)
  clipboardTimer = setTimeout(() => {
    navigator.clipboard.writeText('').catch(() => {})
    hasCopied = false
    clipboardTimer = null
  }, CLIPBOARD_TTL)
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden' && hasCopied) {
    navigator.clipboard.writeText('').catch(() => {})
    hasCopied = false
    if (clipboardTimer) {
      clearTimeout(clipboardTimer)
      clipboardTimer = null
    }
  }
}

function handlePageHide(): void {
  if (hasCopied) {
    navigator.clipboard.writeText('').catch(() => {})
    hasCopied = false
  }
}

export function disableCopyPrevention(): void {
  removeStyle()
  document.removeEventListener('contextmenu', handleContextMenu)
}

export function enableCopyPrevention(): void {
  injectStyle()
  document.addEventListener('contextmenu', handleContextMenu)
}

export function mountCopyPrevention(): void {
  injectStyle()
  document.addEventListener('contextmenu', handleContextMenu)
  document.addEventListener('copy', handleCopy)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', handlePageHide)
}

export function unmountCopyPrevention(): void {
  removeStyle()
  document.removeEventListener('contextmenu', handleContextMenu)
  document.removeEventListener('copy', handleCopy)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('pagehide', handlePageHide)
  if (clipboardTimer) {
    clearTimeout(clipboardTimer)
    clipboardTimer = null
  }
  if (hasCopied) {
    navigator.clipboard.writeText('').catch(() => {})
    hasCopied = false
  }
}
