// Dependency-free device-online diagnostics (safe to unit-test in the
// isolated vitest sandbox, which cannot resolve app node_modules).

export type OnlineSourceKind = 'conn' | 'shared' | 'hbbs' | 'grace' | 'unknown'

export interface ParsedOnlineSource {
  kind: OnlineSourceKind
  /** Remote IP holding the peer online (kind conn/shared). */
  ip?: string
  /** RFC3339 expiry of the grace hold (kind grace). */
  until?: string
}

// Backend wire format from device.service onlineSource ("conn:<ip>" /
// "shared:<ip>" / "hbbs" / "grace:<rfc3339>"). Anything else is unknown.
export function parseOnlineSource(src: string | null | undefined): ParsedOnlineSource {
  if (!src) return { kind: 'unknown' }
  if (src === 'hbbs') return { kind: 'hbbs' }
  if (src.startsWith('conn:')) {
    const ip = src.slice('conn:'.length)
    return ip ? { kind: 'conn', ip } : { kind: 'unknown' }
  }
  if (src.startsWith('shared:')) {
    const ip = src.slice('shared:'.length)
    return ip ? { kind: 'shared', ip } : { kind: 'unknown' }
  }
  if (src.startsWith('grace:')) {
    const until = src.slice('grace:'.length)
    return until ? { kind: 'grace', until } : { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

// Max possible grace hold: max refresh interval (300s, backend store clamp)
// times 3. An online peer unseen for longer is stuck, not graced.
export const MAX_ONLINE_GRACE_MS = 15 * 60_000

export function isStaleOnline(
  online: boolean,
  lastSeenIso: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!online || !lastSeenIso) return false
  const ts = new Date(lastSeenIso).getTime()
  if (Number.isNaN(ts)) return false
  return nowMs - ts > MAX_ONLINE_GRACE_MS
}

export type DotPresence = boolean | 'uncertain'

// Tri-state for the status dot: offline stays off; online with a certain
// source (live dedicated socket, fresh activity) is green; online held by a
// shared socket, an unknown source, or activity older than max grace is
// yellow (uncertain) instead of a lying green.
export function onlineDotState(
  online: boolean,
  src: ParsedOnlineSource,
  lastSeenIso: string | null | undefined,
  nowMs: number = Date.now(),
): DotPresence {
  if (!online) return false
  // hbbs heartbeat is authoritative per peer ID: certain by construction.
  if (src.kind === 'hbbs') return true
  if (src.kind === 'shared' || src.kind === 'unknown') return 'uncertain'
  if (isStaleOnline(online, lastSeenIso, nowMs)) return 'uncertain'
  return true
}
