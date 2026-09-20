import { describe, expect, it } from 'vitest'
import { isFailedRollback } from '../panelStatus'

describe('isFailedRollback', () => {
  it('treats clean manual rollback as success', () => {
    expect(isFailedRollback({ phase: 'rolled_back' })).toBe(false)
    expect(isFailedRollback({ phase: 'rolled_back', error: '' })).toBe(false)
  })

  it('treats rollback with a kept cause as a failure', () => {
    expect(isFailedRollback({ phase: 'rolled_back', error: 'build died (exit 1)' })).toBe(true)
  })

  it('ignores other phases and empty input', () => {
    expect(isFailedRollback({ phase: 'error', error: 'x' })).toBe(false)
    expect(isFailedRollback({ phase: 'ok' })).toBe(false)
    expect(isFailedRollback(undefined)).toBe(false)
    expect(isFailedRollback(null)).toBe(false)
  })
})
