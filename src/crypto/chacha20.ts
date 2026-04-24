import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import type { WireMessage } from '@/types'

const BLOCK_SIZE   = 8192   // fixed plaintext size after padding
const NONCE_SIZE   = 12     // ChaCha20-Poly1305 nonce
const TAG_SIZE     = 16     // Poly1305 authentication tag
const WIRE_SIZE    = NONCE_SIZE + BLOCK_SIZE + TAG_SIZE  // 8220 bytes total

// Pad plaintext to exactly BLOCK_SIZE bytes.
// Format: [2-byte LE length prefix][content][random fill to BLOCK_SIZE]
function pad(plaintext: Uint8Array): Uint8Array {
  if (plaintext.length > BLOCK_SIZE - 2) {
    throw new Error(`Message too long: ${plaintext.length} bytes (max ${BLOCK_SIZE - 2})`)
  }

  const padded = new Uint8Array(BLOCK_SIZE)

  // 2-byte little-endian length prefix
  padded[0] = plaintext.length & 0xff
  padded[1] = (plaintext.length >> 8) & 0xff

  // Content
  padded.set(plaintext, 2)

  // Random fill — not zeros, to prevent pattern leakage
  const fill = randomBytes(BLOCK_SIZE - 2 - plaintext.length)
  padded.set(fill, 2 + plaintext.length)

  return padded
}

// Extract original plaintext from padded block.
function unpad(padded: Uint8Array): Uint8Array {
  const length = padded[0]! | (padded[1]! << 8)
  return padded.slice(2, 2 + length)
}

// Round timestamp to nearest 60 seconds — prevents timing correlation attacks.
export function roundTimestamp(ms: number): number {
  return Math.round(ms / 60_000) * 60_000
}

// Encrypt a WireMessage for a specific peer.
// Returns an 8220-byte Uint8Array ready for Trystero data channel.
export function encryptMessage(
  message: WireMessage,
  peerSessionKey: Uint8Array
): Uint8Array {
  const json      = JSON.stringify(message)
  const plaintext = new TextEncoder().encode(json)
  const padded    = pad(plaintext)

  const nonce = randomBytes(NONCE_SIZE)
  const cipher = chacha20poly1305(peerSessionKey, nonce)
  const ciphertext = cipher.encrypt(padded)

  // Wire format: nonce || ciphertext+tag
  const wire = new Uint8Array(WIRE_SIZE)
  wire.set(nonce, 0)
  wire.set(ciphertext, NONCE_SIZE)

  return wire
}

// Decrypt a received wire blob.
// Returns null on authentication failure — do not throw, just drop the message.
export function decryptMessage(
  wire: Uint8Array,
  peerSessionKey: Uint8Array
): WireMessage | null {
  if (wire.length !== WIRE_SIZE) return null

  const nonce      = wire.slice(0, NONCE_SIZE)
  const ciphertext = wire.slice(NONCE_SIZE)

  try {
    const cipher  = chacha20poly1305(peerSessionKey, nonce)
    const padded  = cipher.decrypt(ciphertext)
    const plain   = unpad(padded)
    const json    = new TextDecoder().decode(plain)
    return JSON.parse(json) as WireMessage
  } catch {
    // Authentication tag mismatch or malformed — silently discard
    return null
  }
}

// Generate a decoy message blob encrypted with the peer session key.
// The receiver detects type === 'DECOY' and discards without displaying.
export function encryptDecoy(peerSessionKey: Uint8Array): Uint8Array {
  const decoy: WireMessage = {
    type:      'DECOY',
    alias:     '00000000',
    timestamp: roundTimestamp(Date.now()),
    body:      '',
  }
  return encryptMessage(decoy, peerSessionKey)
}
