import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { zeroBytes } from './argon2id'

export interface IdentityKeypair {
  publicKey:  Uint8Array   // 32 bytes - share with peers on join
  privateKey: Uint8Array   // 32 bytes - never leave this device
}

// Generate a fresh ephemeral X25519 keypair.
// Call once on session start. Store result in SessionKeys.identity.
export function generateIdentity(): IdentityKeypair {
  const privateKey = x25519.utils.randomSecretKey()
  const publicKey  = x25519.getPublicKey(privateKey)
  return { publicKey, privateKey }
}

// Derive a 32-byte symmetric session key for a specific peer.
// Call once per peer on pubkey receipt. Store in PeerSession.sessionKey.
// HKDF info field binds the key to this app and version.
export function derivePeerSessionKey(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  const sharedSecret = x25519.getSharedSecret(myPrivateKey, theirPublicKey)

  const sessionKey = hkdf(
    sha256,
    sharedSecret,
    undefined,                              // no salt - shared secret is high-entropy
    new TextEncoder().encode('moria-p2p-session-key-v1'),
    32
  )

  // Zero the raw shared secret - we only keep the HKDF output
  sharedSecret.fill(0)

  return sessionKey
}

// Zero all identity key material. Call on disconnect, room leave, and panic.
export function destroyIdentity(identity: IdentityKeypair): void {
  zeroBytes(identity.privateKey)
  zeroBytes(identity.publicKey)
}

// Zero all peer session keys. Call on peer disconnect or room teardown.
export function destroyPeerSession(sessionKey: Uint8Array): void {
  zeroBytes(sessionKey)
}
