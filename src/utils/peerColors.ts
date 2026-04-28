const PEER_COLORS = [
  '#15be53',
  '#ea2261',
  '#3daeff',
  '#8B5CF6',
  '#fb565b',
  '#e6eb52',
]

const peerColorMap = new Map<string, string>()
let colorIndex = 0

export function getPeerColor(peerId: string): string {
  if (!peerColorMap.has(peerId)) {
    peerColorMap.set(peerId, PEER_COLORS[colorIndex % PEER_COLORS.length])
    colorIndex++
  }
  return peerColorMap.get(peerId)!
}

export function resetPeerColors(): void {
  peerColorMap.clear()
  colorIndex = 0
}
