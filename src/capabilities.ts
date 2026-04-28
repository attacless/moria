// ── Runtime capability detection ─────────────────────────────────────────────
// Evaluated once at module load. Safe to import anywhere - no side effects.

export const webRTCAvailable: boolean =
  typeof RTCPeerConnection !== 'undefined' &&
  typeof RTCSessionDescription !== 'undefined'

export const wasmAvailable: boolean = typeof WebAssembly !== 'undefined'
