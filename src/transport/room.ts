import { joinRoom } from 'trystero/nostr'
import type { Room, ActionSender } from 'trystero'
import { syncDerivePeerSessionKey, syncDecrypt, syncEncrypt, destroyIdentity, destroyPeerSession } from '@/wasm'
import { roundTimestamp } from '@crypto/chacha20'
import { resetDeadDropRateLimits } from './deadDrop'
import type { SessionKeys, PeerSession, PeerId, WireMessage, DisplayMessage, Alias } from '@/types'

// Trystero delivers binary action data as ArrayBuffer regardless of the
// declared TypeScript generic type. Coerce before any crypto processing.
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new Error(`Unexpected binary type: ${Object.prototype.toString.call(data)}`)
}

// ── Config ──────────────────────────────────────────────────────────────────

const APP_ID   = 'moria-chat-v1'
const MAX_PEERS = 49  // 50 total including self


// ── State (module-scoped, wiped on leave) ───────────────────────────────────

let activeRoom:   Room | null = null
let sessionKeys:  SessionKeys | null = null
let peers:        Map<PeerId, PeerSession> = new Map()
let rawPeerCount: number = 0

let sendPubkey:  ActionSender<Uint8Array> | null = null
let sendWire:    ActionSender<Uint8Array> | null = null

// ── Public API ───────────────────────────────────────────────────────────────

export interface RoomCallbacks {
  onMessage:       (msg: DisplayMessage) => void
  onPeerJoin:      (peerId: PeerId) => void   // crypto-confirmed
  onPeerLeave:     (peerId: PeerId) => void
  onPresenceJoin:  (peerId: PeerId) => void   // raw Trystero presence (immediate)
  onPresenceLeave: (peerId: PeerId) => void
  onTerminate:     (alias: Alias) => void
  onRoomFull:      () => void
}

export async function joinChatRoom(
  keys: SessionKeys,
  callbacks: RoomCallbacks
): Promise<void> {
  if (activeRoom) leaveRoom()

  sessionKeys = keys

  const room = joinRoom(
    {
      appId:     APP_ID,
      relayUrls: [
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://nostr.wine',
        'wss://relay.nostrplebs.com',
        'wss://nostr-pub.wellorder.net',
        'wss://relay.nostr.wirednet.jp',
      ],
      // Trystero's peer.mjs builds the RTCPeerConnection config as:
      //   { iceServers: defaultIceServers, ...rtcConfig }
      // Object spread means our iceServers key replaces the defaults entirely.
      // Verified in @trystero-p2p/core/dist/peer.mjs - Google/Cloudflare STUN
      // (the Trystero defaults) are not contacted when rtcConfig.iceServers is set.
      rtcConfig: {
        iceServers: [
          { urls: 'stun:stun.mullvad.net' },
          { urls: 'stun:stun.nextcloud.com:443' },
          { urls: 'stun:stunserver.stunprotocol.org' },
        ],
      },
    },
    keys.roomId,
    {
      onJoinError: (details) => {
        console.warn('[room] join error:', details.error)
      },
    }
  )

  activeRoom = room

  // ── Data channel actions ──────────────────────────────────────────────────

  // PUBKEY_HANDSHAKE: exchange X25519 public keys on peer join
  const [_sendPubkey, getPubkey] = room.makeAction<Uint8Array>('pubkey')
  sendPubkey = _sendPubkey

  // WIRE: encrypted padded message blobs (8220 bytes each)
  const [_sendWire, getWire] = room.makeAction<Uint8Array>('wire')
  sendWire = _sendWire

  // ── Peer join ─────────────────────────────────────────────────────────────

  room.onPeerJoin((peerId) => {
    rawPeerCount++
    callbacks.onPresenceJoin(peerId)   // immediate - peer is in room

    if (peers.size >= MAX_PEERS) {
      callbacks.onRoomFull()
      return  // do not send pubkey - peer will not handshake
    }

    if (sendPubkey && sessionKeys) {
      sendPubkey(sessionKeys.identity.publicKey, [peerId])
    }
    // Do NOT call callbacks.onPeerJoin here - wait for crypto handshake
  })

  // ── Pubkey receipt -> session key derivation ──────────────────────────────

  getPubkey((theirPubkey, peerId) => {
    if (!sessionKeys) return

    // Coerce - arrives as ArrayBuffer over WebRTC data channel
    const pubkeyBytes = toBytes(theirPubkey)

    try {
      const sessionKey = syncDerivePeerSessionKey(
        sessionKeys.identity.privateKey,
        pubkeyBytes
      )

      peers.set(peerId, {
        peerId,
        publicKey:  pubkeyBytes,
        sessionKey,
      })

      // Now the peer is crypto-confirmed - fire the callback
      callbacks.onPeerJoin(peerId)
    } catch (err) {
      console.error('[room] key derivation failed for peer', peerId, err)
    }
  })

  // ── Wire receipt -> decrypt -> display ───────────────────────────────────

  getWire((wire, peerId) => {
    const peer = peers.get(peerId)
    if (!peer) return  // no session key yet - drop

    // Coerce - arrives as ArrayBuffer over WebRTC data channel
    const wireBytes = toBytes(wire)

    const msg = syncDecrypt(wireBytes, peer.sessionKey)
    if (!msg) return                  // auth failure - silently drop
    if (msg.type === 'DECOY') return  // decoy - silently discard

    if (msg.type === 'TERMINATE') {
      callbacks.onTerminate(msg.alias)
      return
    }

    const display: DisplayMessage = {
      id:        crypto.randomUUID(),
      alias:     msg.alias,
      timestamp: msg.timestamp,
      body:      msg.body,
      isMine:    false,
      burnAt:    Date.now() + 5 * 60 * 1000,
    }

    callbacks.onMessage(display)
  })

  // ── Peer leave ────────────────────────────────────────────────────────────

  room.onPeerLeave((peerId) => {
    rawPeerCount = Math.max(0, rawPeerCount - 1)
    callbacks.onPresenceLeave(peerId)

    const peer = peers.get(peerId)
    if (peer) {
      destroyPeerSession(peer.sessionKey)
      peers.delete(peerId)
    }
    callbacks.onPeerLeave(peerId)
  })
}

// ── Send a message to all peers (encrypt separately per peer) ───────────────

export function sendChatMessage(
  body:    string,
  alias:   Alias,
  myAlias: Alias
): DisplayMessage | null {
  if (!activeRoom || !sendWire || peers.size === 0) return null

  const wire: WireMessage = {
    type:      'TEXT',
    alias,
    timestamp: roundTimestamp(Date.now()),
    body,
  }

  // Encrypt separately for each peer and unicast - never broadcast raw key
  peers.forEach((peer, peerId) => {
    try {
      const encrypted = syncEncrypt(wire, peer.sessionKey)
      sendWire!(encrypted, [peerId])
    } catch (err) {
      console.error('[room] encrypt failed for peer', peerId, err)
    }
  })

  return {
    id:        crypto.randomUUID(),
    alias:     myAlias,
    timestamp: wire.timestamp,
    body,
    isMine:    true,
    burnAt:    Date.now() + 5 * 60 * 1000,
  }
}

// ── Leave room and zero all key material ─────────────────────────────────────

export function leaveRoom(): void {
  resetDeadDropRateLimits()
  rawPeerCount = 0

  if (activeRoom) {
    activeRoom.leave()
    activeRoom = null
  }

  if (sessionKeys) {
    destroyIdentity(sessionKeys.identity)
    sessionKeys.roomKey.fill(0)
    sessionKeys = null
  }

  peers.forEach((peer) => destroyPeerSession(peer.sessionKey))
  peers.clear()

  sendPubkey = null
  sendWire   = null
}

// ── Terminate: broadcast TERMINATE then leave ────────────────────────────────

export function terminateAndLeave(alias: Alias): void {
  if (sendWire && peers.size > 0) {
    const wire: WireMessage = {
      type:      'TERMINATE',
      alias,
      timestamp: roundTimestamp(Date.now()),
      body:      '',
    }
    peers.forEach((peer, peerId) => {
      try {
        const encrypted = syncEncrypt(wire, peer.sessionKey)
        sendWire!(encrypted, [peerId])
      } catch (_) {
        // best-effort - peer may have disconnected
      }
    })
  }
  leaveRoom()
}

// ── Accessors ────────────────────────────────────────────────────────────────

export function getPeerCount():    number   { return peers.size }
export function getRawPeerCount(): number   { return rawPeerCount }
export function getPeerIds():      PeerId[] { return Array.from(peers.keys()) }
export function isInRoom():        boolean  { return activeRoom !== null }

// Raw wire sender - used by decoy engine
export function sendRawWire(data: Uint8Array, targets: PeerId[]): void {
  if (sendWire) sendWire(data, targets)
}

// Peer session map accessor - used by decoy engine
export function getPeerSessions(): Map<PeerId, PeerSession> {
  return new Map(peers)
}
