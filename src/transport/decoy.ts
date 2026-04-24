import { encryptDecoy } from '@crypto/chacha20'
import type { PeerId, PeerSession } from '@/types'

type PeerMap = Map<PeerId, PeerSession>
type SendFn  = (data: Uint8Array, targets: PeerId[]) => void

const MIN_INTERVAL_MS = 10_000   // 10 seconds
const MAX_INTERVAL_MS = 60_000   // 60 seconds

let decoyTimer: ReturnType<typeof setTimeout> | null = null

function randomInterval(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS)
}

// Start the decoy engine. Call after joining a room.
// sendFn: the Trystero sendWire action sender
// getPeers: live reference to peer map (checked at fire time, not at start)
export function startDecoyEngine(
  sendFn:   SendFn,
  getPeers: () => PeerMap
): void {
  stopDecoyEngine()

  function fire(): void {
    const peers = getPeers()

    if (peers.size > 0) {
      peers.forEach((peer, peerId) => {
        try {
          const decoy = encryptDecoy(peer.sessionKey)
          sendFn(decoy, [peerId])
        } catch {
          // Peer may have disconnected between check and send — ignore
        }
      })
    }

    decoyTimer = setTimeout(fire, randomInterval())
  }

  decoyTimer = setTimeout(fire, randomInterval())
}

// Stop the decoy engine. Call on room leave, disconnect, or panic.
export function stopDecoyEngine(): void {
  if (decoyTimer !== null) {
    clearTimeout(decoyTimer)
    decoyTimer = null
  }
}
