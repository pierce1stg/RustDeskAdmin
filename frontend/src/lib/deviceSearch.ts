// Dependency-free device-search filter model (safe to unit-test in the
// isolated vitest sandbox).

export const SEARCH_FIELDS = [
  'alias',
  'peer_id',
  'hostname',
  'username',
  'platform',
  'host_version',
] as const

export type SearchField = (typeof SEARCH_FIELDS)[number]
export type SearchOp = 'contains' | 'exact' | 'starts'

export interface FieldRule {
  on: boolean
  op: SearchOp
}

export type SearchConfig = Record<SearchField, FieldRule>

const STORAGE_KEY = 'rd-devices-search'

export function defaultSearchConfig(): SearchConfig {
  return {
    alias: { on: true, op: 'contains' },
    peer_id: { on: true, op: 'contains' },
    hostname: { on: true, op: 'contains' },
    username: { on: true, op: 'contains' },
    platform: { on: true, op: 'contains' },
    host_version: { on: true, op: 'contains' },
  }
}

function sanitize(raw: unknown): SearchConfig {
  const fallback = defaultSearchConfig()
  if (!raw || typeof raw !== 'object') return fallback
  const cfg = defaultSearchConfig()
  for (const f of SEARCH_FIELDS) {
    const r = (raw as Record<string, unknown>)[f] as { on?: unknown; op?: unknown } | undefined
    if (!r || typeof r !== 'object') continue
    if (typeof r.on === 'boolean') cfg[f].on = r.on
    if (r.op === 'contains' || r.op === 'exact' || r.op === 'starts') cfg[f].op = r.op
  }
  return cfg
}

export function loadSearchConfig(storage?: Pick<Storage, 'getItem'>): SearchConfig {
  try {
    const s = (storage ?? localStorage).getItem(STORAGE_KEY)
    if (!s) return defaultSearchConfig()
    return sanitize(JSON.parse(s))
  } catch {
    return defaultSearchConfig()
  }
}

export function saveSearchConfig(cfg: SearchConfig, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const store = storage ?? localStorage
    store.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* private mode etc. — filter just won't persist */
  }
}

export interface SearchQueryParams {
  fields?: string
  ops?: string
}

// Serializes to backend params. Default (all on + all contains) serializes
// to nothing so the query key stays stable and short.
export function searchConfigToParams(cfg: SearchConfig): SearchQueryParams {
  const onFields = SEARCH_FIELDS.filter((f) => cfg[f].on)
  const ops = SEARCH_FIELDS.filter((f) => cfg[f].on && cfg[f].op !== 'contains').map(
    (f) => `${f}:${cfg[f].op}`,
  )
  const allOn = onFields.length === SEARCH_FIELDS.length
  if (allOn && ops.length === 0) return {}
  const out: SearchQueryParams = {}
  if (!allOn) out.fields = onFields.join(',')
  if (ops.length > 0) out.ops = ops.join(',')
  return out
}
