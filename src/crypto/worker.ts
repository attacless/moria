import { argon2id } from '@noble/hashes/argon2.js'

export type WorkerRequest = {
  password: string
  type: 'room-id' | 'room-key' | 'drop-id' | 'drop-signing-key'
  epoch?: string
}

export type WorkerResponse = {
  type: 'room-id' | 'room-key' | 'drop-id' | 'drop-signing-key'
  result: Uint8Array
}

// Domain-separated salts - never reuse the same salt for different derivations
const SALTS: Record<WorkerRequest['type'], Uint8Array> = {
  'room-id':          new TextEncoder().encode('moria-room-id-v1-salt'),
  'room-key':         new TextEncoder().encode('moria-room-key-v1-salt'),
  'drop-id':          new TextEncoder().encode('moria-drop-id-v1-salt'),
  'drop-signing-key': new TextEncoder().encode('moria-drop-signing-v1-salt'),
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { password, type, epoch } = e.data
  const pass = new TextEncoder().encode(password)

  // For timed rooms, append the epoch index to the salt for domain separation.
  // NEVER expiry: use original salt unchanged (backwards compatible).
  const baseSalt = SALTS[type]
  const salt = epoch !== undefined
    ? new TextEncoder().encode(new TextDecoder().decode(baseSalt) + '-exp-' + epoch)
    : baseSalt

  const result = argon2id(pass, salt, {
    m: 16384,   // 16 MiB memory
    t: 3,       // 3 iterations
    p: 1,       // 1 thread (browser limitation)
    dkLen: 32,  // 32-byte output
  })

  // Zero the password bytes immediately after use
  pass.fill(0)

  self.postMessage({ type, result } satisfies WorkerResponse)
}
