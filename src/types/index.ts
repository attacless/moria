export type PeerId = string          // Trystero peer ID (opaque)
export type RoomId = string          // Argon2id-derived hex, used as Trystero namespace
export type Alias  = string          // 8-char hex, ephemeral per session
export type HexStr = string

export interface SessionKeys {
  roomId:     RoomId     // Argon2id output - used for Trystero signaling
  dropId:     string     // Argon2id output - used for dead drop r tag ONLY
  roomKey:    Uint8Array // 32-byte symmetric key (never leaves browser)
  signingKey: Uint8Array // 32-byte Nostr private key - deterministic, enables cross-session NIP-09 deletion
  identity: {
    publicKey:  Uint8Array           // X25519 pubkey (shared with peers)
    privateKey: Uint8Array           // X25519 privkey (zeroed on disconnect)
  }
}

export interface PeerSession {
  peerId:     PeerId
  publicKey:  Uint8Array             // Their X25519 pubkey
  sessionKey: Uint8Array             // ECDH-derived symmetric key for this peer
}

export type MessageType = 'TEXT' | 'DECOY' | 'SYSTEM' | 'PUBKEY_HANDSHAKE' | 'TERMINATE' | 'DURESS'

export interface WireMessage {
  type:      MessageType
  alias:     Alias
  timestamp: number                  // Rounded to nearest 60s before encryption
  body:      string
}

export interface DisplayMessage {
  id:               string
  alias:            Alias
  timestamp:        number
  body:             string
  isMine:           boolean
  burnAt?:          number                // Unix ms when message self-destructs
  isDeadDrop?:      boolean              // fetched from Nostr relay on join
  confirmed?:       boolean              // true after RECEIVED pressed or peer joins
  queuedExpiresAt?: number              // unix ms when relay event expires (sender's own queued msgs only)
  queuedStatus?:    'sending' | 'queued' | 'failed'
}

export type AppScreen = 'entry' | 'chat'

export interface AppState {
  screen:      AppScreen
  session:     SessionKeys | null
  peers:       Map<PeerId, PeerSession>
  messages:    DisplayMessage[]
  alias:       Alias
}
