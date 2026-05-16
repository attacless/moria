import { wordlist } from './wordlist'

// Derive 4 verification words from an ECDH session key.
// Both peers derive the same words because X25519 is commutative:
//   x25519(alicePriv, bobPub) === x25519(bobPriv, alicePub)
// => same HKDF output => same SHA-256 hash => same 4 words.
//
// A domain separator is appended before hashing so the verification
// bytes are cryptographically separated from the encryption key.
// A passive MITM has a 1-in-4,294,967,296 chance of guessing all 4 words.
export async function deriveVerifyWords(sessionKey: Uint8Array): Promise<string[]> {
  const info  = new TextEncoder().encode('moria-verify-v1')
  const input = new Uint8Array(sessionKey.length + info.length)
  input.set(sessionKey)
  input.set(info, sessionKey.length)

  const hashBuffer = await crypto.subtle.digest('SHA-256', input)
  const bytes      = new Uint8Array(hashBuffer)

  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!].map(b => wordlist[b]!)
}
