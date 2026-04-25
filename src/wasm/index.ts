import { USE_WASM_CRYPTO } from './config'
import init, {
  ping,
  derive_room_id, derive_room_key, derive_drop_id,
  encrypt as wasm_encrypt,
  decrypt as wasm_decrypt,
  generate_keypair as wasm_generate_keypair,
  derive_peer_session_key as wasm_derive_peer_session_key,
} from './pkg/moria_crypto.js'
import {
  deriveRoomId  as jsDeriveRoomId,
  deriveRoomKey as jsDeriveRoomKey,
  deriveDropId  as jsDeriveDropId,
} from '@crypto/argon2id'
import {
  encryptMessage as jsEncryptMessage,
  decryptMessage as jsDecryptMessage,
} from '@crypto/chacha20'
import {
  generateIdentity      as jsGenerateIdentity,
  derivePeerSessionKey  as jsDeriveSessionKey,
  destroyIdentity       as jsDestroyIdentity,
  destroyPeerSession    as jsDestroyPeerSession,
} from '@crypto/x25519'
import type { WireMessage } from '@/types'
import type { IdentityKeypair } from '@crypto/x25519'

let initialized = false

export async function initCrypto(): Promise<void> {
  if (initialized) return
  await init()
  initialized = true
  ping() // smoke-test: throws if WASM failed to load — intentional
}

export function isCryptoReady(): boolean {
  return initialized
}

// Bytes → hex
const toHex = (b: Uint8Array): string =>
  Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')

// ── WASM-direct exports (always WASM, bypass flag) ────────────────────────
// Retained for phase-2/3/4 verification blocks — remove with them.

export async function wasmDeriveRoomId(secret: string): Promise<Uint8Array> {
  await initCrypto()
  return derive_room_id(secret)
}
export async function wasmDeriveRoomKey(secret: string): Promise<Uint8Array> {
  await initCrypto()
  return derive_room_key(secret)
}
export async function wasmDeriveDropId(secret: string): Promise<Uint8Array> {
  await initCrypto()
  return derive_drop_id(secret)
}

// encrypt(plaintext bytes, key) → 8220-byte wire blob — throws on error
export async function wasmEncrypt(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await initCrypto()
  return wasm_encrypt(plaintext, key)
}

// decrypt(8220-byte wire, key) → plaintext bytes, null on auth failure
export async function wasmDecrypt(wire: Uint8Array, key: Uint8Array): Promise<Uint8Array | null> {
  await initCrypto()
  try {
    return wasm_decrypt(wire, key)
  } catch {
    return null
  }
}

// generate_keypair → { privateKey: 32 bytes, publicKey: 32 bytes }
export async function wasmGenerateKeypair(): Promise<IdentityKeypair> {
  await initCrypto()
  const bytes = wasm_generate_keypair() // 64 bytes: private[0..32] || public[32..64]
  return {
    privateKey: bytes.slice(0, 32),
    publicKey:  bytes.slice(32, 64),
  }
}

// derive_peer_session_key → 32-byte session key, throws on error
export async function wasmDerivePeerSessionKey(
  myPrivateKey:   Uint8Array,
  theirPublicKey: Uint8Array,
): Promise<Uint8Array> {
  await initCrypto()
  return wasm_derive_peer_session_key(myPrivateKey, theirPublicKey)
}

// ── Unified exports — routed through feature flag ─────────────────────────
// Return types match @crypto/argon2id / @crypto/chacha20 / @crypto/x25519
// for drop-in replacement. JS originals are sync; bridge is async.

// Returns hex string — matches deriveRoomId() from @crypto/argon2id
export async function deriveRoomId(secret: string): Promise<string> {
  if (USE_WASM_CRYPTO) {
    await initCrypto()
    return toHex(derive_room_id(secret))
  }
  return jsDeriveRoomId(secret)
}

// Returns raw bytes — matches deriveRoomKey() from @crypto/argon2id
export async function deriveRoomKey(secret: string): Promise<Uint8Array> {
  if (USE_WASM_CRYPTO) {
    await initCrypto()
    return derive_room_key(secret)
  }
  return jsDeriveRoomKey(secret)
}

// Returns hex string — matches deriveDropId() from @crypto/argon2id
export async function deriveDropId(secret: string): Promise<string> {
  if (USE_WASM_CRYPTO) {
    await initCrypto()
    return toHex(derive_drop_id(secret))
  }
  return jsDeriveDropId(secret)
}

// Returns 8220-byte wire blob — matches encryptMessage() from @crypto/chacha20
export async function encryptMessage(message: WireMessage, key: Uint8Array): Promise<Uint8Array> {
  if (USE_WASM_CRYPTO) {
    await initCrypto()
    const json      = JSON.stringify(message)
    const plaintext = new TextEncoder().encode(json)
    return wasm_encrypt(plaintext, key)
  }
  return jsEncryptMessage(message, key)
}

// Returns WireMessage | null — matches decryptMessage() from @crypto/chacha20
export async function decryptMessage(wire: Uint8Array, key: Uint8Array): Promise<WireMessage | null> {
  if (USE_WASM_CRYPTO) {
    await initCrypto()
    try {
      const plaintext = wasm_decrypt(wire, key)
      return JSON.parse(new TextDecoder().decode(plaintext)) as WireMessage
    } catch {
      return null
    }
  }
  return jsDecryptMessage(wire, key)
}

// Returns IdentityKeypair — matches generateIdentity() from @crypto/x25519
// NOTE: Call sites in useRoom.ts will need to await when swapped in Phase 5.
export async function generateIdentity(): Promise<IdentityKeypair> {
  if (USE_WASM_CRYPTO) {
    await initCrypto()
    const bytes = wasm_generate_keypair()
    return {
      privateKey: bytes.slice(0, 32),
      publicKey:  bytes.slice(32, 64),
    }
  }
  return jsGenerateIdentity()
}

// Returns 32-byte session key — matches derivePeerSessionKey() from @crypto/x25519
// NOTE: Call sites in room.ts will need to await when swapped in Phase 5.
export async function derivePeerSessionKey(
  myPrivateKey:   Uint8Array,
  theirPublicKey: Uint8Array,
): Promise<Uint8Array> {
  if (USE_WASM_CRYPTO) {
    await initCrypto()
    return wasm_derive_peer_session_key(myPrivateKey, theirPublicKey)
  }
  return jsDeriveSessionKey(myPrivateKey, theirPublicKey)
}

// destroyIdentity / destroyPeerSession: pure memory zeroing — no WASM path needed.
// Re-exported here so Phase 5 can import everything from a single entry point.
export function destroyIdentity(identity: IdentityKeypair): void {
  jsDestroyIdentity(identity)
}
export function destroyPeerSession(sessionKey: Uint8Array): void {
  jsDestroyPeerSession(sessionKey)
}

// ── Synchronous bridge variants — for Trystero callbacks ─────────────────────
// Trystero's ActionReceiver discards the return value of its handler; async
// callbacks produce silently-dropped Promises.  These sync variants call the
// WASM functions directly (WASM is guaranteed initialized before joinChatRoom)
// and fall back to the JS originals when USE_WASM_CRYPTO is false.

export function syncDerivePeerSessionKey(
  myPrivateKey:   Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  return USE_WASM_CRYPTO
    ? wasm_derive_peer_session_key(myPrivateKey, theirPublicKey)
    : jsDeriveSessionKey(myPrivateKey, theirPublicKey)
}

export function syncDecrypt(wire: Uint8Array, key: Uint8Array): WireMessage | null {
  if (USE_WASM_CRYPTO) {
    try {
      const plain = wasm_decrypt(wire, key)
      return JSON.parse(new TextDecoder().decode(plain)) as WireMessage
    } catch { return null }
  }
  return jsDecryptMessage(wire, key)
}

export function syncEncrypt(message: WireMessage, key: Uint8Array): Uint8Array {
  if (USE_WASM_CRYPTO) {
    return wasm_encrypt(new TextEncoder().encode(JSON.stringify(message)), key)
  }
  return jsEncryptMessage(message, key)
}
