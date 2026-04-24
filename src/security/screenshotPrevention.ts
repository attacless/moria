const BLOCKED: ((e: KeyboardEvent) => boolean)[] = [
  e => e.key === 'PrintScreen',
  e => e.key === 'PrintScreen' && e.ctrlKey,
  e => e.key === 'PrintScreen' && e.altKey,
  e => e.key === '3' && e.metaKey && e.shiftKey,
  e => e.key === '4' && e.metaKey && e.shiftKey,
  e => e.key === '5' && e.metaKey && e.shiftKey,
]

function handleKeydown(e: KeyboardEvent): void {
  if (BLOCKED.some(test => test(e))) {
    e.preventDefault()
    e.stopPropagation()
  }
}

export function mountScreenshotPrevention(): void {
  window.addEventListener('keydown', handleKeydown, { capture: true })
}

export function unmountScreenshotPrevention(): void {
  window.removeEventListener('keydown', handleKeydown, { capture: true })
}
