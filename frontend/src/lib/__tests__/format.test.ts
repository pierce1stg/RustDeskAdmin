import { describe, expect, it } from 'vitest'
import { formatBackupSize, formatBackupTime } from '../format'

describe('formatBackupSize', () => {
  it('bytes stay bytes, then KB/MB/GB with one decimal', () => {
    expect(formatBackupSize(0)).toBe('0 B')
    expect(formatBackupSize(847)).toBe('847 B')
    expect(formatBackupSize(1023)).toBe('1023 B')
    expect(formatBackupSize(1024)).toBe('1.0 KB')
    expect(formatBackupSize(847024)).toBe('827.2 KB')
    expect(formatBackupSize(1054930)).toBe('1.0 MB')
    expect(formatBackupSize(5 * 1024 ** 3)).toBe('5.0 GB')
  })

  it('garbage degrades to an em dash', () => {
    expect(formatBackupSize(NaN)).toBe('—')
    expect(formatBackupSize(-1)).toBe('—')
    expect(formatBackupSize(Infinity)).toBe('—')
  })
})

describe('formatBackupTime', () => {
  it('renders local date + time, degrades on garbage', () => {
    const out = formatBackupTime('2026-09-20T12:42:18Z')
    expect(out).toMatch(/20/)
    expect(out).toMatch(/2026/)
    expect(out).not.toBe('—')
    expect(formatBackupTime('')).toBe('—')
    expect(formatBackupTime('not-a-date')).toBe('—')
  })
})
