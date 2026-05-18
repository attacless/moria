import { finalizeEvent, SimplePool } from 'nostr-tools'
import { encryptMessage, decryptMessage } from '@/wasm'
import { roundTimestamp } from '@crypto/chacha20'
import type { WireMessage, Alias, MessageType, ReplyTo } from '@/types'

// Larger pool - more fallbacks if individual relays are down
const RELAY_POOL = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostrplebs.com',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
]

const EVENT_KIND    = 1337  // custom regular kind - not indexed by social Nostr clients
const DROP_TTL_S    = 86_400
const PROBE_TIMEOUT = 2_000    // 2s to confirm relay is reachable
const FETCH_TIMEOUT = 8_000    // 8s for actual query once reachable

const FETCH_RATE_LIMIT_MS   = 30_000
const PUBLISH_RATE_LIMIT_MS = 5_000
let lastFetchTime      = 0
let lastDeadManFetch   = 0
let lastPublishTime    = 0

export function resetDeadDropRateLimits(): void {
  lastFetchTime    = 0
  lastDeadManFetch = 0
  lastPublishTime  = 0
}

// Pre-flight: open a WebSocket to the relay and wait for open or failure.
function probeRelay(url: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const ws    = new WebSocket(url)
      const timer = setTimeout(() => { ws.close(); resolve(false) }, PROBE_TIMEOUT)
      ws.onopen  = () => { clearTimeout(timer); ws.close(); resolve(true) }
      ws.onerror = () => { clearTimeout(timer); resolve(false) }
    } catch {
      resolve(false)
    }
  })
}

// Probe all pool relays in parallel, return up to n that are reachable.
async function getLiveRelays(n: number): Promise<string[]> {
  const results = await Promise.all(
    RELAY_POOL.map(async url => ({ url, live: await probeRelay(url) }))
  )
  return results.filter(r => r.live).map(r => r.url).slice(0, n)
}

export interface DeadDropReceipt {
  eventId:   string
  expiresAt: number       // unix ms when relay event expires
}

export type PublishFailReason =
  | 'rate_limited'
  | 'no_relays'
  | 'too_large'
  | 'invalid_format'
  | 'publish_failed'

export interface PublishResult {
  success: boolean
  receipt: DeadDropReceipt | null
  reason?: PublishFailReason
}

export async function publishDeadDrop(
  body:           string,
  alias:          Alias,
  dropId:         string,
  roomKey:        Uint8Array,
  signingKey:     Uint8Array,
  ttlSeconds:     number = DROP_TTL_S,
  replyTo?:       ReplyTo,
  activateAfter?: number,
  tokenHash?:     string
): Promise<PublishResult> {
  // Privacy envelopes applied to dead drop publishing:
  // 1. created_at jittered backward 0-120s (breaks relay-level timestamp correlation)
  // 2. NIP-40 expiration anchored to real time, not jittered time
  // 3. Random 0-10s publish delay (breaks network-level timing correlation)
  // 4. Payload padded to 8,192 bytes (inherited from encrypt function)

  const nowMs = Date.now()
  if (nowMs - lastPublishTime < PUBLISH_RATE_LIMIT_MS) {
    return { success: false, receipt: null, reason: 'rate_limited' }
  }
  lastPublishTime = nowMs

  const wire: WireMessage = {
    type:      activateAfter ? 'DEADMAN' : 'TEXT',
    alias,
    timestamp: roundTimestamp(Date.now()),
    body,
    ...(replyTo       ? { replyTo }       : {}),
    ...(activateAfter ? { activateAfter } : {}),
    ...(tokenHash     ? { tokenHash }     : {}),
  }

  const encrypted = await encryptMessage(wire, roomKey)
  const b64 = btoa(
    Array.from(encrypted, b => String.fromCharCode(b)).join('')
  )

  const now = Math.floor(nowMs / 1000)

  // Jitter created_at backward 0-120s to break relay-level timestamp correlation.
  const jitter            = Math.floor(Math.random() * 121)
  const jitteredTimestamp = now - jitter

  // Anchor expiration to real time so blobs don't expire early due to jitter.
  const expiration = now + ttlSeconds

  // Sign with deterministic key - same key for all events in this room.
  // Enables cross-session NIP-09 deletion without storing per-event keys.
  const event = finalizeEvent(
    {
      kind:       EVENT_KIND,
      created_at: jitteredTimestamp,
      tags: [
        ['r', dropId],
        ['expiration', String(expiration)],
      ],
      content: b64,
    },
    signingKey
  )

  const eventId    = event.id
  const liveRelays = await getLiveRelays(4)

  if (liveRelays.length === 0) {
    return { success: false, receipt: null, reason: 'no_relays' }
  }

  // Privacy envelope: random 0-10s delay breaks correlation between
  // user action timing and relay-visible publish timing.
  const delay = Math.floor(Math.random() * 10001)
  await new Promise(resolve => setTimeout(resolve, delay))

  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish(liveRelays, event))
    const anySuccess = results.some(r => r.status === 'fulfilled')

    if (!anySuccess) {
      return { success: false, receipt: null, reason: 'publish_failed' }
    }

    const expiresAtMs = expiration * 1000
    return { success: true, receipt: { eventId, expiresAt: expiresAtMs } }
  } finally {
    pool.close(liveRelays)
  }
}

// NIP-09 deletion for known event IDs - signed with the deterministic signing
// key so relays that validate authorship will honor it. Best-effort: relays
// that ignore NIP-09 fall back to the NIP-40 expiration tag.
export async function deleteDeadDrops(
  receipts:   DeadDropReceipt[],
  dropId:     string,
  signingKey: Uint8Array
): Promise<void> {
  if (receipts.length === 0) return

  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return

  const pool = new SimplePool()
  try {
    await Promise.allSettled(
      receipts.flatMap(receipt => {
        const deletion = finalizeEvent(
          {
            kind:       5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['e', receipt.eventId],
              ['r', dropId],
            ],
            content: '',
          },
          signingKey
        )
        return liveRelays.map(url => pool.publish([url], deletion))
      })
    )
  } finally {
    pool.close(liveRelays)
  }
}

// Fetches event IDs eligible for deletion on TERMINATE.
// Decrypts each event to identify armed DEADMAN switches and skip them.
// Armed DEADMAN (activateAfter > now) survives TERMINATE - only the
// 6-character cancellation token can disarm it.
// Decryption failures are treated as deletable (safe default).
async function fetchDeletableEventIds(dropId: string, roomKey: Uint8Array): Promise<string[]> {
  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return []

  const now    = Math.floor(Date.now() / 1000)
  const filter = {
    kinds: [EVENT_KIND],
    '#r':  [dropId],
    since: now - DROP_TTL_S,
  }

  const pool = new SimplePool()
  try {
    const events = await Promise.race([
      pool.querySync(liveRelays, filter),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT)
      ),
    ])

    const seen      = new Set<string>()
    const deletable: string[] = []

    await Promise.all(events.map(async event => {
      if (seen.has(event.id)) return
      seen.add(event.id)
      try {
        const bytes     = Uint8Array.from(atob(event.content), c => c.charCodeAt(0))
        const decrypted = await decryptMessage(bytes, roomKey)
        // Armed event (any type with activateAfter > now): skip so it outlives the session.
        // Covers DEADMAN text switches and VOICE_CHUNK voice switches.
        if (decrypted?.activateAfter && decrypted.activateAfter > now) {
          return
        }
      } catch {
        // Decryption failed - include for deletion
      }
      deletable.push(event.id)
    }))

    return deletable
  } catch {
    return []
  } finally {
    pool.close(liveRelays)
  }
}

// NIP-09 deletion for ALL events matching this drop ID - does not require
// prior receipts. Re-derives event IDs from the relay, signs deletions with
// the deterministic signing key. Called only by terminate(). Enables:
//   - Cross-session deletion (new session, same key, old relay events)
//   - Full wipe on TERMINATE (all relay events, not just this-session receipts)
export async function deleteAllDeadDrops(
  dropId:     string,
  roomKey:    Uint8Array,
  signingKey: Uint8Array
): Promise<void> {
  const eventIds = await fetchDeletableEventIds(dropId, roomKey)
  if (eventIds.length === 0) return

  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return

  const now  = Math.floor(Date.now() / 1000)
  const pool = new SimplePool()
  try {
    await Promise.allSettled(
      eventIds.flatMap(eventId => {
        const deletion = finalizeEvent(
          {
            kind:       5,
            created_at: now,
            tags: [
              ['e', eventId],
              ['r', dropId],
            ],
            content: '',
          },
          signingKey
        )
        return liveRelays.map(url => pool.publish([url], deletion))
      })
    )
  } finally {
    pool.close(liveRelays)
  }
}

// Best-effort poison event - published to the REAL drop when duress password is used.
// Warns the recipient that the sender may be under coercion. Bypasses rate limiter.
// Signed with the real room's deterministic signing key so it authenticates correctly.
export async function publishPoisonEvent(
  dropId:     string,
  roomKey:    Uint8Array,
  signingKey: Uint8Array
): Promise<void> {
  const wire: WireMessage = {
    type:      'DURESS',
    alias:     'system',
    timestamp: roundTimestamp(Date.now()),
    body:      'duress',
  }

  const encrypted = await encryptMessage(wire, roomKey)
  const b64 = btoa(Array.from(encrypted, b => String.fromCharCode(b)).join(''))

  const now = Math.floor(Date.now() / 1000)

  const event = finalizeEvent(
    {
      kind:       EVENT_KIND,
      created_at: now,
      tags: [
        ['r', dropId],
        ['expiration', String(now + DROP_TTL_S)],
      ],
      content: b64,
    },
    signingKey
  )

  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return

  const pool = new SimplePool()
  try {
    await Promise.allSettled(pool.publish(liveRelays, event))
  } finally {
    pool.close(liveRelays)
  }
}

// ── Shared relay query helper ────────────────────────────────────────────────
// Queries liveRelays for all encrypted events in this room, decrypts them,
// and returns the results sorted by timestamp. Includes a single retry on
// empty results to absorb relay propagation delays.

type DropEvent = {
  alias:               Alias
  timestamp:           number
  body:                string
  type:                MessageType
  activateAfter?:      number
  tokenHash?:          string
  eventId:             string
  // VOICE_CHUNK fields (mapped from WireMessage's imageId/imageData/etc.)
  voiceId?:            string
  voiceChunkIndex?:    number
  voiceTotalChunks?:   number
  voiceAudioData?:     string
  voiceMimeType?:      string
  voiceAudioDuration?: number
  // TEXT_CHUNK fields
  textChunkId?:        string
  textChunkIndex?:     number
  textTotalChunks?:    number
  replyTo?:            import('@/types').ReplyTo
}

export type { DropEvent }

async function queryRoomEvents(dropId: string, roomKey: Uint8Array, liveRelays: string[]): Promise<DropEvent[]> {
  const now     = Math.floor(Date.now() / 1000)
  const seen    = new Set<string>()
  const results: DropEvent[] = []

  const filter = { kinds: [EVENT_KIND], '#r': [dropId], since: now - DROP_TTL_S }

  async function decryptEvent(event: { id: string; content: string; tags: string[][] }): Promise<void> {
    if (seen.has(event.id)) return
    const expiryTag = event.tags.find(t => t[0] === 'expiration')
    if (expiryTag && parseInt(expiryTag[1] ?? '0') < now) return
    seen.add(event.id)
    try {
      const bytes     = Uint8Array.from(atob(event.content), c => c.charCodeAt(0))
      const decrypted = await decryptMessage(bytes, roomKey)
      if (!decrypted || decrypted.type === 'DECOY') return
      results.push({
        alias:     decrypted.alias,
        timestamp: decrypted.timestamp,
        body:      decrypted.body,
        type:      decrypted.type,
        eventId:   event.id,
        ...(decrypted.activateAfter    ? { activateAfter:      decrypted.activateAfter }    : {}),
        ...(decrypted.tokenHash        ? { tokenHash:          decrypted.tokenHash }        : {}),
        // VOICE_CHUNK fields - reuses WireMessage imageId/imageData/chunkIndex/totalChunks/mimeType
        ...(decrypted.type === 'VOICE_CHUNK' && decrypted.imageId      !== undefined ? { voiceId:            decrypted.imageId }         : {}),
        ...(decrypted.type === 'VOICE_CHUNK' && decrypted.chunkIndex   !== undefined ? { voiceChunkIndex:    decrypted.chunkIndex }       : {}),
        ...(decrypted.type === 'VOICE_CHUNK' && decrypted.totalChunks  !== undefined ? { voiceTotalChunks:   decrypted.totalChunks }      : {}),
        ...(decrypted.type === 'VOICE_CHUNK' && decrypted.imageData    !== undefined ? { voiceAudioData:     decrypted.imageData }        : {}),
        ...(decrypted.type === 'VOICE_CHUNK' && decrypted.mimeType     !== undefined ? { voiceMimeType:      decrypted.mimeType }         : {}),
        ...(decrypted.type === 'VOICE_CHUNK' && decrypted.audioDuration !== undefined ? { voiceAudioDuration: decrypted.audioDuration }   : {}),
        // TEXT_CHUNK fields - reuses WireMessage imageId/chunkIndex/totalChunks; body carries chunk text
        ...(decrypted.type === 'TEXT_CHUNK' && decrypted.imageId     !== undefined ? { textChunkId:    decrypted.imageId }    : {}),
        ...(decrypted.type === 'TEXT_CHUNK' && decrypted.chunkIndex  !== undefined ? { textChunkIndex:  decrypted.chunkIndex } : {}),
        ...(decrypted.type === 'TEXT_CHUNK' && decrypted.totalChunks !== undefined ? { textTotalChunks: decrypted.totalChunks }: {}),
        ...(decrypted.type === 'TEXT_CHUNK' && decrypted.replyTo     !== undefined ? { replyTo:         decrypted.replyTo }   : {}),
      })
    } catch {
      // malformed - skip
    }
  }

  const pool = new SimplePool()
  try {
    const events = await Promise.race([
      pool.querySync(liveRelays, filter),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetch timeout')), FETCH_TIMEOUT)),
    ])
    await Promise.all(events.map(decryptEvent))

    // If empty, wait 2s and retry once for relay propagation delay
    if (results.length === 0 && events.length === 0) {
      await new Promise(r => setTimeout(r, 2_000))
      const retryEvents = await Promise.race([
        pool.querySync(liveRelays, filter),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('retry timeout')), FETCH_TIMEOUT)),
      ]).catch(() => [] as Awaited<ReturnType<typeof pool.querySync>>)
      await Promise.all(retryEvents.map(decryptEvent))
    }
  } catch {
    // fetch failed - return whatever was collected
  } finally {
    pool.close(liveRelays)
  }

  return results.sort((a, b) => a.timestamp - b.timestamp)
}

// ── Public fetch functions ───────────────────────────────────────────────────

// Fetches all relay events for dead drop messaging. Returns null when the fetch
// is skipped (rate-limited or no relays reachable) so callers can distinguish
// a genuine empty result from a skipped fetch and avoid incorrect reconciliation.
export async function fetchDeadDrops(
  dropId:  string,
  roomKey: Uint8Array
): Promise<DropEvent[] | null> {
  const nowMs = Date.now()
  if (nowMs - lastFetchTime < FETCH_RATE_LIMIT_MS) {
    console.warn('[deadDrop] fetch rate limited - too soon after last fetch')
    return null  // skipped - caller must not reconcile state against this
  }
  lastFetchTime = nowMs

  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return null

  return queryRoomEvents(dropId, roomKey, liveRelays)
}

// Fetches only DEADMAN-type relay events for dead man switch reconciliation.
// Uses an independent rate limit so it never conflicts with fetchDeadDrops.
// Returns null when skipped; an array (possibly empty) when the relay was queried.
export async function fetchDeadManEvents(
  dropId:  string,
  roomKey: Uint8Array
): Promise<DropEvent[] | null> {
  const nowMs = Date.now()
  if (nowMs - lastDeadManFetch < FETCH_RATE_LIMIT_MS) {
    return null  // skipped
  }
  lastDeadManFetch = nowMs

  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return null

  const all = await queryRoomEvents(dropId, roomKey, liveRelays)
  // Return DEADMAN text events plus armed VOICE_CHUNK events (for voice dead man switches)
  return all.filter(e => e.type === 'DEADMAN' || (e.type === 'VOICE_CHUNK' && !!e.activateAfter))
}

// ── Voice chunk batch publisher ───────────────────────────────────────────────
// Publishes all chunks of a voice recording as separate Nostr events in one
// relay session. Does not apply the per-message 5s rate limiter (this is a
// batch operation). Updates lastPublishTime after the batch so a normal text
// message publish cannot immediately follow.
export async function publishVoiceChunks(
  chunks:        string[],
  voiceId:       string,
  mimeType:      string,
  audioDuration: number,
  alias:         Alias,
  dropId:        string,
  roomKey:       Uint8Array,
  signingKey:    Uint8Array,
  ttlSeconds:    number,
  activateAfter?: number,
  tokenHash?:     string
): Promise<{ success: boolean; eventIds: string[] }> {
  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return { success: false, eventIds: [] }

  const now        = Math.floor(Date.now() / 1000)
  const expiration = now + ttlSeconds
  const eventIds:   string[]       = []
  const events:     ReturnType<typeof finalizeEvent>[] = []

  for (let i = 0; i < chunks.length; i++) {
    const wire: WireMessage = {
      type:      'VOICE_CHUNK',
      alias,
      timestamp: roundTimestamp(Date.now()),
      body:      '',
      imageId:   voiceId,
      chunkIndex:  i,
      totalChunks: chunks.length,
      imageData:   chunks[i]!,
      mimeType:    i === 0 ? mimeType : '',
      ...(i === 0      ? { audioDuration }  : {}),
      ...(activateAfter ? { activateAfter } : {}),
      ...(tokenHash     ? { tokenHash }     : {}),
    }

    const encrypted = await encryptMessage(wire, roomKey)
    const b64       = btoa(Array.from(encrypted, b => String.fromCharCode(b)).join(''))
    const jitter    = Math.floor(Math.random() * 121)

    const event = finalizeEvent(
      {
        kind:       EVENT_KIND,
        created_at: now - jitter,
        tags:       [['r', dropId], ['expiration', String(expiration)]],
        content:    b64,
      },
      signingKey
    )

    eventIds.push(event.id)
    events.push(event)
    if (i < chunks.length - 1) {
      await new Promise<void>(r => setTimeout(r, 15))
    }
  }

  // Block immediate TEXT publish after this batch
  lastPublishTime = Date.now()

  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(
      events.flatMap(event => liveRelays.map(url => pool.publish([url], event)))
    )
    const anySuccess = results.some(r => r.status === 'fulfilled')
    return { success: anySuccess, eventIds }
  } finally {
    pool.close(liveRelays)
  }
}

// ── Text chunk batch publisher ────────────────────────────────────────────────
// Publishes all chunks of a long text message as separate Nostr events.
// Does not apply the per-message 5s rate limiter (batch operation).
// Each chunk reuses the imageId/chunkIndex/totalChunks WireMessage fields;
// body carries the chunk text directly (no base64 encoding needed).
export async function publishTextChunks(
  chunks:     string[],
  chunkId:    string,
  alias:      Alias,
  dropId:     string,
  roomKey:    Uint8Array,
  signingKey: Uint8Array,
  ttlSeconds: number,
  replyTo?:   import('@/types').ReplyTo
): Promise<{ success: boolean; eventIds: string[] }> {
  const liveRelays = await getLiveRelays(4)
  if (liveRelays.length === 0) return { success: false, eventIds: [] }

  const now        = Math.floor(Date.now() / 1000)
  const expiration = now + ttlSeconds
  const eventIds:  string[] = []
  const events:    ReturnType<typeof finalizeEvent>[] = []

  for (let i = 0; i < chunks.length; i++) {
    const wire: WireMessage = {
      type:        'TEXT_CHUNK',
      alias,
      timestamp:   roundTimestamp(Date.now()),
      body:        chunks[i]!,
      imageId:     chunkId,
      chunkIndex:  i,
      totalChunks: chunks.length,
      ...(i === 0 && replyTo ? { replyTo } : {}),
    }

    const encrypted = await encryptMessage(wire, roomKey)
    const b64       = btoa(Array.from(encrypted, b => String.fromCharCode(b)).join(''))
    const jitter    = Math.floor(Math.random() * 121)

    const event = finalizeEvent(
      {
        kind:       EVENT_KIND,
        created_at: now - jitter,
        tags:       [['r', dropId], ['expiration', String(expiration)]],
        content:    b64,
      },
      signingKey
    )

    eventIds.push(event.id)
    events.push(event)
    if (i < chunks.length - 1) {
      await new Promise<void>(r => setTimeout(r, 15))
    }
  }

  lastPublishTime = Date.now()

  const pool = new SimplePool()
  try {
    const allResults = await Promise.allSettled(
      events.flatMap(event => liveRelays.map(url => pool.publish([url], event)))
    )
    const anySuccess = allResults.some(r => r.status === 'fulfilled')
    return { success: anySuccess, eventIds }
  } finally {
    pool.close(liveRelays)
  }
}
