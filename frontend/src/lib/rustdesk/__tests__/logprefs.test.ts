import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LEVELS,
  LOG_CATEGORIES,
  LOG_LEVELS,
  filterLogEntries,
  loadLogPrefs,
  LogEntry,
  saveLogPrefs,
  shouldRecord,
  splitHighlight,
  toggleInList,
} from '../logprefs'

function entry(partial: Partial<LogEntry> & { message: string }): LogEntry {
  return { ts: '00:00:00.000', level: 'info', category: 'system', ...partial }
}

beforeEach(() => {
  localStorage.clear()
})

describe('loadLogPrefs', () => {
  it('defaults: info+warn+error, all categories', () => {
    expect(loadLogPrefs()).toEqual({ levels: DEFAULT_LEVELS, categories: LOG_CATEGORIES })
  })

  it('ignores garbage, falls back per key', () => {
    localStorage.setItem('rd-log-levels', 'info,nope')
    localStorage.setItem('rd-log-cats', 'bogus')
    const prefs = loadLogPrefs()
    expect(prefs.levels).toEqual(['info'])
    expect(prefs.categories).toEqual(LOG_CATEGORIES)
  })

  it('round-trips save/load', () => {
    saveLogPrefs({ levels: ['error'], categories: ['codec', 'ui'] })
    expect(loadLogPrefs()).toEqual({ levels: ['error'], categories: ['codec', 'ui'] })
  })

  it("migration: stored lists predate 'ui', so it is appended", () => {
    localStorage.setItem('rd-log-cats', 'codec,video')
    expect(loadLogPrefs().categories).toEqual(['codec', 'video', 'ui'])
  })

  it("migration: explicit 'ui' is not duplicated", () => {
    localStorage.setItem('rd-log-cats', 'codec,ui')
    expect(loadLogPrefs().categories).toEqual(['codec', 'ui'])
  })

  it("migration: fresh users get 'ui' via defaults", () => {
    expect(loadLogPrefs().categories).toContain('ui')
  })
})

describe('shouldRecord', () => {
  const prefs = { levels: ['info', 'warn', 'error'] as const, categories: [...LOG_CATEGORIES] }
  it('debug off by default', () => {
    expect(shouldRecord('debug', 'codec', { levels: [...prefs.levels], categories: [...prefs.categories] })).toBe(false)
    expect(shouldRecord('info', 'codec', { levels: [...prefs.levels], categories: [...prefs.categories] })).toBe(true)
  })

  it('disabled category drops', () => {
    expect(
      shouldRecord('info', 'cursor', { levels: ['info', 'warn', 'error'], categories: ['codec'] }),
    ).toBe(false)
  })
})

describe('filterLogEntries', () => {
  const prefs = { levels: ['info', 'warn', 'error'], categories: [...LOG_CATEGORIES] }

  it('markers bypass filters', () => {
    const rows = [entry({ message: '── connect → p', marker: true })]
    expect(filterLogEntries(rows, { levels: [], categories: [] }, '')).toHaveLength(1)
  })

  it('query matches case-insensitively', () => {
    const rows = [entry({ message: 'hbbs connected' }), entry({ message: 'LoginRequest sent' })]
    expect(filterLogEntries(rows, prefs, 'HBBS')).toHaveLength(1)
    expect(filterLogEntries(rows, prefs, '')).toHaveLength(2)
    expect(filterLogEntries(rows, prefs, 'zzz')).toHaveLength(0)
  })

  it('level filter applies', () => {
    const rows = [entry({ message: 'a', level: 'debug', category: 'codec' })]
    expect(filterLogEntries(rows, prefs, '')).toHaveLength(0)
  })
})

describe('splitHighlight', () => {
  it('empty query returns plain', () => {
    expect(splitHighlight('abc', '')).toEqual([{ text: 'abc', hit: false }])
    expect(splitHighlight('abc', '  ')).toEqual([{ text: 'abc', hit: false }])
  })

  it('finds case-insensitive hits', () => {
    expect(splitHighlight('hbbs Connected', 'HBBS')).toEqual([
      { text: 'hbbs', hit: true },
      { text: ' Connected', hit: false },
    ])
  })

  it('finds multiple hits', () => {
    const parts = splitHighlight('aXbXc', 'x')
    expect(parts.filter((p) => p.hit)).toHaveLength(2)
    expect(parts.map((p) => p.text).join('')).toBe('aXbXc')
  })

  it('no match returns plain', () => {
    expect(splitHighlight('abc', 'zzz')).toEqual([{ text: 'abc', hit: false }])
  })
})

describe('toggleInList', () => {
  it('toggles both ways', () => {
    expect(toggleInList(['a', 'b'], 'b')).toEqual(['a'])
    expect(toggleInList(['a'], 'b')).toEqual(['a', 'b'])
  })
})

describe('constants', () => {
  it('four levels, nine categories (incl. ui audit trail)', () => {
    expect(LOG_LEVELS).toEqual(['info', 'warn', 'error', 'debug'])
    expect(LOG_CATEGORIES).toHaveLength(9)
    expect(LOG_CATEGORIES).toContain('ui')
  })

  it('ui actions record by default', () => {
    const prefs = loadLogPrefs()
    expect(shouldRecord('info', 'ui', prefs)).toBe(true)
  })
})
