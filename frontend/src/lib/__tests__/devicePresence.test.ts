import { describe, expect, it } from 'vitest'
import { parseOnlineSource, isStaleOnline, onlineDotState, MAX_ONLINE_GRACE_MS } from '../devicePresence'

describe('parseOnlineSource', () => {
  it('parses conn sources', () => {
    expect(parseOnlineSource('conn:95.70.19.235')).toEqual({ kind: 'conn', ip: '95.70.19.235' })
  })

  it('parses shared sources', () => {
    expect(parseOnlineSource('shared:95.70.19.235')).toEqual({ kind: 'shared', ip: '95.70.19.235' })
  })

  it('parses grace sources', () => {
    expect(parseOnlineSource('grace:2026-09-20T07:19:33Z')).toEqual({
      kind: 'grace',
      until: '2026-09-20T07:19:33Z',
    })
  })

  it('parses hbbs verdicts', () => {
    expect(parseOnlineSource('hbbs')).toEqual({ kind: 'hbbs' })
  })

  it('degrades garbage to unknown', () => {
    expect(parseOnlineSource(null)).toEqual({ kind: 'unknown' })
    expect(parseOnlineSource(undefined)).toEqual({ kind: 'unknown' })
    expect(parseOnlineSource('')).toEqual({ kind: 'unknown' })
    expect(parseOnlineSource('conn:')).toEqual({ kind: 'unknown' })
    expect(parseOnlineSource('shared:')).toEqual({ kind: 'unknown' })
    expect(parseOnlineSource('grace:')).toEqual({ kind: 'unknown' })
    expect(parseOnlineSource('socket:1.2.3.4')).toEqual({ kind: 'unknown' })
  })
})

describe('isStaleOnline', () => {
  const now = new Date('2026-09-20T08:00:00Z').getTime()

  it('flags online peers unseen beyond max grace', () => {
    expect(isStaleOnline(true, '2026-09-20T07:27:08Z', now)).toBe(true)
    expect(isStaleOnline(true, '2026-09-20T07:59:00Z', now)).toBe(false)
  })

  it('ignores offline peers and garbage', () => {
    expect(isStaleOnline(false, '2026-09-20T07:27:08Z', now)).toBe(false)
    expect(isStaleOnline(true, null, now)).toBe(false)
    expect(isStaleOnline(true, 'not-a-date', now)).toBe(false)
  })

  it('uses the documented max-grace window', () => {
    expect(MAX_ONLINE_GRACE_MS).toBe(15 * 60_000)
  })
})

describe('onlineDotState', () => {
  const now = new Date('2026-09-20T08:00:00Z').getTime()

  it('offline stays off', () => {
    expect(onlineDotState(false, { kind: 'conn', ip: '1.2.3.4' }, '2026-09-20T07:59:00Z', now)).toBe(false)
  })

  it('live dedicated socket with fresh activity is green', () => {
    expect(onlineDotState(true, { kind: 'conn', ip: '1.2.3.4' }, '2026-09-20T07:59:00Z', now)).toBe(true)
  })

  it('hbbs verdicts are green without freshness checks', () => {
    expect(onlineDotState(true, { kind: 'hbbs' }, '2026-09-20T07:27:08Z', now)).toBe(true)
  })

  it('shared, unknown and stale sources are uncertain', () => {
    expect(onlineDotState(true, { kind: 'shared', ip: '1.2.3.4' }, '2026-09-20T07:59:00Z', now)).toBe(
      'uncertain',
    )
    expect(onlineDotState(true, { kind: 'unknown' }, '2026-09-20T07:59:00Z', now)).toBe('uncertain')
    expect(onlineDotState(true, { kind: 'conn', ip: '1.2.3.4' }, '2026-09-20T07:27:08Z', now)).toBe(
      'uncertain',
    )
    expect(onlineDotState(true, { kind: 'grace', until: '2026-09-20T08:01:00Z' }, null, now)).toBe(true)
  })
})
