import { afterEach, describe, expect, it } from 'vitest'
import { loadOpenIds, saveOpenIds, toggleOpenId } from '../settingsCollapse'

afterEach(() => {
  localStorage.clear()
})

describe('settings expand persistence (collapsed by default)', () => {
  it('empty by default (everything collapsed)', () => {
    expect(loadOpenIds()).toEqual([])
  })

  it('round-trips save/load', () => {
    saveOpenIds(['web', 'chat'])
    expect(loadOpenIds()).toEqual(['web', 'chat'])
  })

  it('falls back on missing/garbage', () => {
    expect(loadOpenIds()).toEqual([])
    localStorage.setItem('rd-settings-open', 'nope')
    expect(loadOpenIds()).toEqual([])
    localStorage.setItem('rd-settings-open', '[1,{"a":2},"web"]')
    expect(loadOpenIds()).toEqual(['web'])
  })

  it('toggles one card idempotently', () => {
    expect(toggleOpenId([], 'web', true)).toEqual(['web'])
    expect(toggleOpenId(['web'], 'web', true)).toEqual(['web'])
    expect(toggleOpenId(['web', 'chat'], 'web', false)).toEqual(['chat'])
    expect(toggleOpenId(['chat'], 'web', false)).toEqual(['chat'])
  })
})
