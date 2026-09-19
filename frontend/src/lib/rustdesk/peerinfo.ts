// Pure PeerInfo snapshot helpers (no imports): safe to unit-test in the
// isolated vitest env and to reuse from the API layer and pages.

export interface PeerInfoDisplay {
  name?: string | null
  x?: number
  y?: number
  width: number
  height: number
}

export interface PeerInfoSnapshot {
  hostname?: string | null
  username?: string | null
  platform?: string | null
  host_version?: string | null
  displays?: PeerInfoDisplay[]
}

/** One monitor per line: `#1 1920×1080`. Falls back to []. */
export function formatDisplays(displaysJson: string | null): string[] {
  if (!displaysJson) return []
  try {
    const arr = JSON.parse(displaysJson) as PeerInfoDisplay[]
    if (!Array.isArray(arr)) return []
    return arr
      .filter((d) => Number.isFinite(d?.width) && Number.isFinite(d?.height))
      .slice(0, 16)
      .map((d, i) => `#${i + 1} ${d.width}×${d.height}`)
  } catch {
    return []
  }
}

/** Tooltip detail per monitor: name and position when known. */
export function describeDisplays(displaysJson: string | null): string {
  if (!displaysJson) return ''
  try {
    const arr = JSON.parse(displaysJson) as PeerInfoDisplay[]
    if (!Array.isArray(arr)) return ''
    return arr
      .slice(0, 16)
      .map((d, i) => {
        const bits = [`#${i + 1}`, `${d?.width ?? '?'}×${d?.height ?? '?'}`]
        if (typeof d?.name === 'string' && d.name) bits.push(d.name)
        if (Number.isFinite(d?.x) && Number.isFinite(d?.y)) bits.push(`@${d.x},${d.y}`)
        return bits.join(' ')
      })
      .join('\n')
  } catch {
    return ''
  }
}
