let clickAudio:        HTMLAudioElement | null = null
let notificationAudio: HTMLAudioElement | null = null

export function initSounds(): void {
  clickAudio               = new Audio('/sounds/click.mp3')
  clickAudio.volume        = 0.3
  notificationAudio        = new Audio('/sounds/notification.mp3')
  notificationAudio.volume = 0.4
}

export function playClick(): void {
  if (!clickAudio) return
  clickAudio.currentTime = 0
  clickAudio.play().catch(() => {})
}

export function playNotification(): void {
  if (!notificationAudio) return
  notificationAudio.currentTime = 0
  notificationAudio.play().catch(() => {})
}
