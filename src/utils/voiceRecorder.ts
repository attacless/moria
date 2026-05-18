let mediaRecorder:     MediaRecorder | null = null
let chunks:            Blob[]               = []
let stream:            MediaStream | null   = null
let totalBytes:        number               = 0
let maxBytesLimit:     number               = 0
let autoStopCallback:  (() => void) | null  = null
let recordingStartTime: number             = 0

export async function startRecording(maxBytes: number, onAutoStop: () => void): Promise<void> {
  stream            = await navigator.mediaDevices.getUserMedia({ audio: true })
  maxBytesLimit     = maxBytes
  autoStopCallback  = onAutoStop
  totalBytes        = 0
  recordingStartTime = Date.now()

  const options: MediaRecorderOptions = {
    mimeType:           'audio/webm;codecs=opus',
    audioBitsPerSecond: 32_000,
  }

  if (!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    options.mimeType = 'audio/mp4'
    delete options.audioBitsPerSecond
  }

  mediaRecorder = new MediaRecorder(stream, options)
  chunks         = []

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data)
      totalBytes += e.data.size
      if (maxBytesLimit > 0 && totalBytes >= maxBytesLimit) {
        autoStopCallback?.()
      }
    }
  }

  mediaRecorder.start(100)
}

export async function stopRecording(): Promise<{ blob: Blob; duration: number } | null> {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return null

  // Capture elapsed time before the async stop so we always get the wall-clock
  // recording length regardless of what the audio file headers say.
  const duration = Math.max(1, Math.round((Date.now() - recordingStartTime) / 1000))

  return new Promise((resolve) => {
    mediaRecorder!.onstop = () => {
      const mimeType = mediaRecorder!.mimeType
      const blob     = new Blob(chunks, { type: mimeType })
      chunks         = []
      totalBytes     = 0

      stream?.getTracks().forEach(t => t.stop())
      stream = null

      resolve({ blob, duration })
    }
    mediaRecorder!.stop()
  })
}

export function cancelRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null   // prevent any pending Promise from resolving
    mediaRecorder.stop()
  }
  chunks             = []
  totalBytes         = 0
  recordingStartTime = 0
  stream?.getTracks().forEach(t => t.stop())
  stream = null
}

export function isRecording(): boolean {
  return mediaRecorder?.state === 'recording'
}
