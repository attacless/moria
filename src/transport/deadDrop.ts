import { finalizeEvent, SimplePool } from 'nostr-tools'
import { encryptMessage, decryptMessage } from '@/wasm'
import { roundTimestamp } from '@crypto/chacha20'
import type { WireMessage, Alias, MessageType } from '@/types'

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
let lastFetchTime   = 0
let lastPublishTime = 0

export function resetDeadDropRateLimits(): void {
  lastFetchTime   = 0
  lastPublishTime = 0
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
  body:       string,
  alias:      Alias,
  dropId:     string,
  roomKey:    Uint8Array,
  signingKey: Uint8Array,
  ttlSeconds: number = DROP_TTL_S
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
    type:      'TEXT',
    alias,
    timestamp: roundTimestamp(Date.now()),
    body,
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

// Fetches all event IDs for a drop ID without decrypting content.
// Used by deleteAllDeadDrops to build NIP-09 deletion targets.
async function fetchDropEventIds(dropId: string): Promise<string[]> {
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
    // Deduplicate across relay responses
    return [...new Set(events.map(e => e.id))]
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
  signingKey: Uint8Array
): Promise<void> {
  const eventIds = await fetchDropEventIds(dropId)
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

export async function fetchDeadDrops(
  dropId:  string,
  roomKey: Uint8Array
): Promise<{ alias: Alias; timestamp: number; body: string; type: MessageType }[]> {
  const nowMs = Date.now()
  if (nowMs - lastFetchTime < FETCH_RATE_LIMIT_MS) {
    console.warn('[deadDrop] fetch rate limited - too soon after last fetch')
    return []
  }
  lastFetchTime = nowMs

  const now    = Math.floor(nowMs / 1000)
  const seen   = new Set<string>()
  const results: { alias: Alias; timestamp: number; body: string; type: MessageType }[] = []

  const liveRelays = await getLiveRelays(4)

  if (liveRelays.length === 0) return []

  const filter = {
    kinds: [EVENT_KIND],
    '#r':  [dropId],
    since: now - DROP_TTL_S,
  }

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
      })
    } catch {
      // malformed - skip
    }
  }

  const pool = new SimplePool()

  try {
    const events = await Promise.race([
      pool.querySync(liveRelays, filter),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fetch timeout')), FETCH_TIMEOUT)
      ),
    ])

    await Promise.all(events.map(decryptEvent))

    // If empty, wait 2s and retry once - relay propagation delay
    if (results.length === 0 && events.length === 0) {
      await new Promise(r => setTimeout(r, 2_000))

      const retryEvents = await Promise.race([
        pool.querySync(liveRelays, filter),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('retry timeout')), FETCH_TIMEOUT)
        ),
      ]).catch(() => [] as Awaited<ReturnType<typeof pool.querySync>>)

      await Promise.all(retryEvents.map(decryptEvent))
    }
  } catch {
    // fetch failed - return whatever we collected
  } finally {
    pool.close(liveRelays)
  }

  return results.sort((a, b) => a.timestamp - b.timestamp)
}
