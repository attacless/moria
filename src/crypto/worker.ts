import { argon2id } from '@noble/hashes/argon2.js'

export type WorkerRequest = {
  password: string
  type: 'room-id' | 'room-key' | 'drop-id'
}

export type WorkerResponse = {
  type: 'room-id' | 'room-key' | 'drop-id'
  result: Uint8Array
}

// Domain-separated salts — never reuse the same salt for both derivations
const SALTS: Record<WorkerRequest['type'], Uint8Array> = {
  'room-id':  new TextEncoder().encode('moria-room-id-v1-salt'),
  'room-key': new TextEncoder().encode('moria-room-key-v1-salt'),
  'drop-id':  new TextEncoder().encode('moria-drop-id-v1-salt'),
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { password, type } = e.data
  const pass = new TextEncoder().encode(password)

  const result = argon2id(pass, SALTS[type], {
    m: 16384,   // 16 MiB memory
    t: 3,       // 3 iterations
    p: 1,       // 1 thread (browser limitation)
    dkLen: 32,  // 32-byte output
  })

  // Zero the password bytes immediately after use
  pass.fill(0)

  self.postMessage({ type, result } satisfies WorkerResponse)
}
