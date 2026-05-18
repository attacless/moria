// 2 MB ceiling enforced before calling chunkImage
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024

// Max base64 chars per IMAGE_CHUNK wire message
const CHUNK_SIZE = 6_000

// Batch size for fromCharCode to avoid call-stack overflow on large files
const ENCODE_BATCH = 8_192

export async function chunkImage(
  file: File
): Promise<{ imageId: string; mimeType: string; chunks: string[] }> {
  const imageId = crypto.randomUUID().substring(0, 8)
  const buffer  = await file.arrayBuffer()
  const bytes   = new Uint8Array(buffer)

  // Batched base64 encoding - spreading a large Uint8Array directly into
  // String.fromCharCode causes a stack overflow on files above ~100 KB.
  let binary = ''
  for (let i = 0; i < bytes.length; i += ENCODE_BATCH) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + ENCODE_BATCH, bytes.length)))
  }
  const base64 = btoa(binary)

  const chunks: string[] = []
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.substring(i, i + CHUNK_SIZE))
  }

  return { imageId, mimeType: file.type || 'image/jpeg', chunks }
}

// Chunk an arbitrary Blob (audio, etc.) into base64 strings ready for WireMessage.
// Uses the same batched encoding as chunkImage to avoid call-stack overflow on large blobs.
export async function chunkBlob(blob: Blob): Promise<{
  voiceId:  string
  mimeType: string
  chunks:   string[]
}> {
  const voiceId = crypto.randomUUID().substring(0, 8)
  const buffer  = await blob.arrayBuffer()
  const bytes   = new Uint8Array(buffer)

  let binary = ''
  for (let i = 0; i < bytes.length; i += ENCODE_BATCH) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + ENCODE_BATCH, bytes.length)))
  }
  const base64 = btoa(binary)

  const chunks: string[] = []
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.substring(i, i + CHUNK_SIZE))
  }

  return { voiceId, mimeType: blob.type || 'audio/webm', chunks }
}

// Reassemble base64 chunks into an object URL (works for any media type).
export function reassembleChunks(chunks: Map<number, string>, mimeType: string): string {
  const sorted = [...chunks.entries()].sort((a, b) => a[0] - b[0])
  const base64 = sorted.map(([, data]) => data).join('')
  const binary = atob(base64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
}

export function reassembleImage(chunks: Map<number, string>, mimeType: string): string {
  const sorted = [...chunks.entries()].sort((a, b) => a[0] - b[0])
  const base64  = sorted.map(([, data]) => data).join('')
  const binary  = atob(base64)
  const bytes   = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob      = new Blob([bytes], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)
  return objectUrl
}
