const SOUNDS_ENABLED = false

let audioContext: AudioContext | null = null
let clickBuffer: AudioBuffer | null = null

export async function initSounds() {
  try {
    audioContext = new AudioContext()
    const response = await fetch('/sounds/click.mp3')
    const arrayBuffer = await response.arrayBuffer()
    clickBuffer = await audioContext.decodeAudioData(arrayBuffer)
  } catch (e) {
    console.warn('sounds init failed', e)
  }
}

export function playClick() {
  if (!SOUNDS_ENABLED) return
  if (!audioContext || !clickBuffer) return
  try {
    if (audioContext.state === 'suspended') audioContext.resume()
    const source = audioContext.createBufferSource()
    source.buffer = clickBuffer
    source.connect(audioContext.destination)
    source.start(0)
  } catch (e) {}
}

export function playNotification() {
  if (!SOUNDS_ENABLED) return
  // reserved for future use
}
