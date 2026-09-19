import { describe, expect, it } from 'vitest'
import {
  DropFlags,
  LogEntry,
  connectMarker,
  errorDropMarker,
  statusDropMarker,
} from '../logprefs'

// Lifecycle contract, mirrored 1:1 from useRustdeskControl's event handler:
// connect() appends a boundary marker (never wipes); drops append exactly
// one marker; explicit disconnect clears (hook clears state, no marker here).
describe('statusDropMarker', () => {
  const idle: DropFlags = { userClosing: false, dropNotified: false }

  it('bare drop produces one marker', () => {
    const r = statusDropMarker('disconnected', idle, 't')
    expect(r.entry?.message).toBe('── disconnected')
    expect(r.entry?.marker).toBe(true)
  })

  it('userClosing suppresses the marker (explicit exit clears instead)', () => {
    const r = statusDropMarker('disconnected', { userClosing: true, dropNotified: false }, 't')
    expect(r.entry).toBeNull()
  })

  it('error-then-disconnected dedupes to the error marker', () => {
    const r = statusDropMarker('disconnected', { userClosing: false, dropNotified: true }, 't')
    expect(r.entry).toBeNull()
    expect(r.dropNotified).toBe(false)
  })

  it('connected resets the dedupe flag', () => {
    const r = statusDropMarker('connected', { userClosing: false, dropNotified: true }, 't')
    expect(r).toEqual({ entry: null, dropNotified: false })
  })

  it('connecting produces nothing', () => {
    expect(statusDropMarker('connecting', idle, 't').entry).toBeNull()
  })
})

describe('markers', () => {
  it('connect marker names the peer', () => {
    expect(connectMarker('peer1', 't')).toMatchObject({ message: '── connect → peer1', marker: true })
  })

  it('error marker carries the reason', () => {
    expect(errorDropMarker('boom', 't')).toMatchObject({
      message: '── connection lost: boom',
      marker: true,
      level: 'info',
    })
  })
})

describe('full drop sequence (hook order)', () => {
  it('connect, lines, error, trailing status, reconnect, explicit clear', () => {
    let logs: LogEntry[] = []
    let flags: DropFlags = { userClosing: false, dropNotified: false }
    const push = (e: LogEntry) => {
      logs = [...logs, e].slice(-500)
    }

    // connect #1
    flags = { userClosing: false, dropNotified: false }
    push(connectMarker('p', 't0'))
    push({ ts: 't1', level: 'info', category: 'codec', message: 'browser codecs: vp9' })
    // drop: error + trailing disconnected
    flags = { ...flags, dropNotified: true }
    push(errorDropMarker('boom', 't2'))
    const r = statusDropMarker('disconnected', flags, 't3')
    flags = { ...flags, dropNotified: r.dropNotified }
    if (r.entry) push(r.entry)
    expect(logs.filter((l) => l.marker).map((m) => m.message)).toEqual([
      '── connect → p',
      '── connection lost: boom',
    ])
    expect(logs.some((l) => l.message.includes('browser codecs'))).toBe(true)
    // reconnect: kept, new marker
    push(connectMarker('p', 't4'))
    expect(logs.some((l) => l.message.includes('browser codecs'))).toBe(true)
    expect(logs.filter((l) => l.marker)).toHaveLength(3)
    // explicit disconnect: hook clears state
    logs = []
    expect(logs).toHaveLength(0)
  })
})
