import type { LogCategory, LogLevel } from './session'

// One stored journal row. `marker` rows (connect/disconnect boundaries)
// bypass level/category filters — they must survive any filter combo.
export interface LogEntry {
  ts: string
  level: LogLevel
  category: LogCategory
  message: string
  marker?: boolean
}

export const LOG_LEVELS: LogLevel[] = ['info', 'warn', 'error', 'debug']
export const LOG_CATEGORIES: LogCategory[] = [
  'connection',
  'codec',
  'video',
  'decoder',
  'input',
  'clipboard',
  'cursor',
  'system',
  'ui', // user actions in the session toolbar (audit trail)
]

export const DEFAULT_LEVELS: LogLevel[] = ['info', 'warn', 'error']
const LEVELS_KEY = 'rd-log-levels'
const CATS_KEY = 'rd-log-cats'

export interface LogPrefs {
  levels: LogLevel[]
  categories: LogCategory[]
}

function parseList<T extends string>(raw: string | null, valid: T[], fallback: T[]): T[] {
  if (!raw) return [...fallback]
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is T => (valid as string[]).includes(s))
  return picked.length > 0 ? picked : [...fallback]
}

function readLS(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

// Filter preferences survive refresh (localStorage); the LINES never do —
// they live in React state and reset on explicit disconnect (see the hook).
export function loadLogPrefs(): LogPrefs {
  const rawCats = readLS(CATS_KEY)
  const categories = parseList(rawCats, LOG_CATEGORIES, LOG_CATEGORIES)
  // Migration: lists stored before the 'ui' category existed lack it, and
  // recording drops disabled classes BEFORE storing — without this, ui
  // actions would silently never record for existing users.
  if (rawCats !== null && !rawCats.split(',').includes('ui') && !categories.includes('ui')) {
    categories.push('ui')
  }
  return {
    levels: parseList(readLS(LEVELS_KEY), LOG_LEVELS, DEFAULT_LEVELS),
    categories,
  }
}

export function saveLogPrefs(prefs: LogPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LEVELS_KEY, prefs.levels.join(','))
    localStorage.setItem(CATS_KEY, prefs.categories.join(','))
  } catch {
    // private mode — preferences simply don't persist
  }
}

// Disabled classes are dropped BEFORE recording: they cost no memory,
// no re-render, and never touch the stored journal.
export function shouldRecord(level: LogLevel, category: LogCategory, prefs: LogPrefs): boolean {
  return prefs.levels.includes(level) && prefs.categories.includes(category)
}

export function filterLogEntries(entries: LogEntry[], prefs: LogPrefs, query: string): LogEntry[] {
  const q = query.trim().toLowerCase()
  return entries.filter((e) => {
    if (!e.marker && !shouldRecord(e.level, e.category, prefs)) return false
    if (q && !e.message.toLowerCase().includes(q)) return false
    return true
  })
}

// Split text into plain/hit runs for <mark> highlighting (case-insensitive).
export function splitHighlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim().toLowerCase()
  if (!q) return [{ text, hit: false }]
  const parts: Array<{ text: string; hit: boolean }> = []
  const lower = text.toLowerCase()
  let i = 0
  for (;;) {
    const at = lower.indexOf(q, i)
    if (at < 0) break
    if (at > i) parts.push({ text: text.slice(i, at), hit: false })
    parts.push({ text: text.slice(at, at + q.length), hit: true })
    i = at + q.length
  }
  if (i < text.length) parts.push({ text: text.slice(i), hit: false })
  return parts.length > 0 ? parts : [{ text, hit: false }]
}

export function toggleInList<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

// ---------------------------------------------------------------------------
// Drop/keep decisions for the journal lifecycle. Pure and unit-tested; the
// hook below is a thin wrapper, so the contract holds without React tests:
// - explicit user disconnect clears (hook clears state, no marker);
// - connect() never wipes, only appends a boundary marker;
// - a drop (error / bare 'disconnected') appends exactly one marker;
// - an 'error' followed by its trailing 'disconnected' dedupes to one.
export interface DropFlags {
  userClosing: boolean
  dropNotified: boolean
}

export function connectMarker(peerId: string, ts: string): LogEntry {
  return { ts, level: 'info', category: 'system', message: `── connect → ${peerId}`, marker: true }
}

export function errorDropMarker(message: string, ts: string): LogEntry {
  return { ts, level: 'info', category: 'system', message: `── connection lost: ${message}`, marker: true }
}

export function statusDropMarker(
  status: 'connecting' | 'connected' | 'disconnected',
  flags: DropFlags,
  ts: string,
): { entry: LogEntry | null; dropNotified: boolean } {
  if (status === 'connected') return { entry: null, dropNotified: false }
  if (status !== 'disconnected') return { entry: null, dropNotified: flags.dropNotified }
  if (flags.userClosing || flags.dropNotified) return { entry: null, dropNotified: false }
  return {
    entry: { ts, level: 'info', category: 'system', message: '── disconnected', marker: true },
    dropNotified: false,
  }
}
