import { generateSecretKey, finalizeEvent, SimplePool } from 'nostr-tools'
import { encryptMessage, decryptMessage, roundTimestamp } from '@crypto/chacha20'
import type { WireMessage, Alias } from '@/types'

// Larger pool - more fallbacks if individual relays are down
const RELAY_POOL = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://relay.nostrplebs.com',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
]

const EVENT_KIND    = 1
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
  sk:        Uint8Array   // ephemeral signing key - kept for valid NIP-09 deletion
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
  body:    string,
  alias:   Alias,
  dropId:  string,
  roomKey: Uint8Array
): Promise<PublishResult> {
  const now = Date.now()
  if (now - lastPublishTime < PUBLISH_RATE_LIMIT_MS) {
    return { success: false, receipt: null, reason: 'rate_limited' }
  }
  lastPublishTime = now

  const wire: WireMessage = {
    type:      'TEXT',
    alias,
    timestamp: roundTimestamp(Date.now()),
    body,
  }

  const encrypted = encryptMessage(wire, roomKey)
  const b64 = btoa(
    Array.from(encrypted, b => String.fromCharCode(b)).join('')
  )

  const sk         = generateSecretKey()
  const expiration = Math.floor(Date.now() / 1000) + DROP_TTL_S

  const event = finalizeEvent(
    {
      kind:       EVENT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['r', dropId],
        ['expiration', String(expiration)],
      ],
      content: b64,
    },
    sk
  )

  const eventId    = event.id
  const liveRelays = await getLiveRelays(4)

  if (liveRelays.length === 0) {
    sk.fill(0)
    return { success: false, receipt: null, reason: 'no_relays' }
  }

  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish(liveRelays, event))
    const anySuccess = results.some(r => r.status === 'fulfilled')

    if (!anySuccess) {
      sk.fill(0)
      return { success: false, receipt: null, reason: 'publish_failed' }
    }

    // Do NOT zero sk - caller stores it for NIP-09 deletion on terminate
    const expiresAtMs = (Math.floor(Date.now() / 1000) + DROP_TTL_S) * 1000
    return { success: true, receipt: { eventId, sk, expiresAt: expiresAtMs } }
  } finally {
    pool.close(liveRelays)
  }
}

// NIP-09 deletion - signed with the original ephemeral keypair so relays
// that validate authorship will honor it. Best-effort: relays that ignore
// NIP-09 or are unreachable let the 24h NIP-40 expiration tag handle cleanup.
export async function deleteDeadDrops(
  receipts: DeadDropReceipt[],
  dropId:   string
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
          receipt.sk
        )
        return liveRelays.map(url => pool.publish([url], deletion))
      })
    )
  } finally {
    pool.close(liveRelays)
    receipts.forEach(r => r.sk.fill(0))
  }
}

export async function fetchDeadDrops(
  dropId:  string,
  roomKey: Uint8Array
): Promise<{ alias: Alias; timestamp: number; body: string }[]> {
  const nowMs = Date.now()
  if (nowMs - lastFetchTime < FETCH_RATE_LIMIT_MS) {
    console.warn('[deadDrop] fetch rate limited - too soon after last fetch')
    return []
  }
  lastFetchTime = nowMs

  const now    = Math.floor(nowMs / 1000)
  const seen   = new Set<string>()
  const results: { alias: Alias; timestamp: number; body: string }[] = []

  const liveRelays = await getLiveRelays(4)

  if (liveRelays.length === 0) return []

  const filter = {
    kinds: [EVENT_KIND],
    '#r':  [dropId],
    since: now - DROP_TTL_S,
  }

  function decryptEvent(event: { id: string; content: string; tags: string[][] }): void {
    if (seen.has(event.id)) return

    const expiryTag = event.tags.find(t => t[0] === 'expiration')
    if (expiryTag && parseInt(expiryTag[1] ?? '0') < now) return

    seen.add(event.id)

    try {
      const bytes     = Uint8Array.from(atob(event.content), c => c.charCodeAt(0))
      const decrypted = decryptMessage(bytes, roomKey)
      if (!decrypted || decrypted.type === 'DECOY') return

      results.push({
        alias:     decrypted.alias,
        timestamp: decrypted.timestamp,
        body:      decrypted.body,
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

    events.forEach(decryptEvent)

    // If empty, wait 2s and retry once - relay propagation delay
    if (results.length === 0 && events.length === 0) {
      await new Promise(r => setTimeout(r, 2_000))

      const retryEvents = await Promise.race([
        pool.querySync(liveRelays, filter),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('retry timeout')), FETCH_TIMEOUT)
        ),
      ]).catch(() => [] as Awaited<ReturnType<typeof pool.querySync>>)

      retryEvents.forEach(decryptEvent)
    }
  } catch {
    // fetch failed - return whatever we collected
  } finally {
    pool.close(liveRelays)
  }

  return results.sort((a, b) => a.timestamp - b.timestamp)
}
