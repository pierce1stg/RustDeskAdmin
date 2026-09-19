// Persisted expanded state for the settings-page cards (per browser).
// Default is collapsed-everything: only explicitly expanded ids are stored.
// Pure helpers so they unit-test without React.
const KEY = 'rd-settings-open'

export function loadOpenIds(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

export function saveOpenIds(ids: string[]): void {
  try {
    localStorage?.setItem(KEY, JSON.stringify(ids))
  } catch {
    // private mode — expand state simply doesn't persist
  }
}

// Next expanded-id list after toggling one card (open=true means the card is
// being expanded). Idempotent: no duplicates, no-op removals.
export function toggleOpenId(ids: string[], id: string, open: boolean): string[] {
  const has = ids.includes(id)
  if (open && !has) return [...ids, id]
  if (!open && has) return ids.filter((x) => x !== id)
  return ids
}
