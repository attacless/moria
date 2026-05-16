import type { WorkerRequest, WorkerResponse } from './worker'

function deriveViaWorker(
  password: string,
  type: WorkerRequest['type'],
  epoch?: string
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./worker.ts', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === type) {
        resolve(e.data.result)
        worker.terminate()
      }
    }

    worker.onerror = (err) => {
      reject(new Error(`Argon2id worker error: ${err.message}`))
      worker.terminate()
    }

    worker.postMessage({
      password,
      type,
      ...(epoch !== undefined ? { epoch } : {}),
    } satisfies WorkerRequest)
  })
}

// Returns hex string - used as Trystero roomId. Safe to send over network.
export async function deriveRoomId(password: string, epoch?: string): Promise<string> {
  const bytes = await deriveViaWorker(password, 'room-id', epoch)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Returns raw bytes - stays in browser RAM only. Never serialized.
export async function deriveRoomKey(password: string, epoch?: string): Promise<Uint8Array> {
  return deriveViaWorker(password, 'room-key', epoch)
}

// Returns hex string - used ONLY for dead drop 'r' tag.
// Deliberately different from roomId so Nostr relays
// cannot correlate signaling traffic with dead drop events.
export async function deriveDropId(password: string, epoch?: string): Promise<string> {
  const bytes = await deriveViaWorker(password, 'drop-id', epoch)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Returns raw 32-byte Nostr signing key - deterministic per room secret.
// Used to sign all dead drop events (publish, poison, NIP-09 deletion)
// so that cross-session deletion is possible without storing per-event keys.
// Caller is responsible for zeroing after use.
export async function deriveDropSigningKey(password: string, epoch?: string): Promise<Uint8Array> {
  return deriveViaWorker(password, 'drop-signing-key', epoch)
}

// Zero a key buffer in place. Call this on all key material on disconnect.
export function zeroBytes(buf: Uint8Array): void {
  crypto.getRandomValues(buf as Uint8Array<ArrayBuffer>) // overwrite with random before zero
  buf.fill(0)
}
