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

export interface PeerWatchwords {
  alias:        Alias
  peerId:       PeerId
  words:        string[]
  hasChatAlias: boolean   // false when alias is a fallback peer ID truncation
}

export type MessageType = 'TEXT' | 'DECOY' | 'SYSTEM' | 'PUBKEY_HANDSHAKE' | 'TERMINATE' | 'DURESS' | 'TYPING' | 'DEADMAN' | 'IMAGE' | 'IMAGE_CHUNK' | 'DEADMAN_ARMED' | 'DEADMAN_CANCELLED'

export interface ReplyTo {
  id:    string
  body:  string
  alias: Alias
}

export interface WireMessage {
  type:           MessageType
  alias:          Alias
  timestamp:      number                  // Rounded to nearest 60s before encryption
  body:           string
  replyTo?:       ReplyTo
  activateAfter?: number                  // Unix seconds - DEADMAN only; client enforces
  tokenHash?:     string                  // SHA-256 hex of cancellation token - DEADMAN only
  imageId?:       string                  // IMAGE_CHUNK only: shared ID for all chunks of one image
  chunkIndex?:    number                  // IMAGE_CHUNK only: zero-based index of this chunk
  totalChunks?:   number                  // IMAGE_CHUNK only: total chunk count
  imageData?:     string                  // IMAGE_CHUNK only: base64 chunk payload
  mimeType?:      string                  // IMAGE_CHUNK only: image MIME type (first chunk only)
  eventId?:       string                  // DEADMAN_ARMED / DEADMAN_CANCELLED only: relay event ID
}

export interface DisplayMessage {
  id:               string
  alias:            Alias
  timestamp:        number
  body:             string
  isMine:           boolean
  burnAt?:          number                // Unix ms when message self-destructs
  isDeadDrop?:      boolean              // fetched from Nostr relay on join
  isDeadMan?:       boolean              // activated DEADMAN relay event
  activateAfter?:   number              // Unix seconds - for pending DEADMAN (unused in display msgs)
  confirmed?:       boolean              // true after RECEIVED pressed or peer joins
  queuedExpiresAt?: number              // unix ms when relay event expires (sender's own queued msgs only)
  queuedStatus?:    'sending' | 'queued' | 'failed'
  replyTo?:         ReplyTo
  imageUrl?:        string              // object URL for inline image (revoked on session end)
}

export interface PendingDeadMan {
  eventId:    string
  alias:      Alias
  timestamp:  number    // Unix ms when published
  activateAt: number    // Unix seconds when it activates
  body:       string
  tokenHash?: string    // SHA-256 hex of cancellation token
}

export type AppScreen = 'entry' | 'chat'

export interface AppState {
  screen:      AppScreen
  session:     SessionKeys | null
  peers:       Map<PeerId, PeerSession>
  messages:    DisplayMessage[]
  alias:       Alias
}
