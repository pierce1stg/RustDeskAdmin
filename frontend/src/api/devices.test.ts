import { describe, expect, it } from 'vitest'
import { describeDisplays, formatDisplays } from '../lib/rustdesk/peerinfo'

describe('formatDisplays', () => {
  it('lists one monitor per line, caps at 16, skips garbage', () => {
    const json = JSON.stringify([
      { name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080 },
      { name: 'HDMI-1', x: 1920, y: 0, width: 1920, height: 1080 },
    ])
    expect(formatDisplays(json)).toEqual(['#1 1920×1080', '#2 1920×1080'])
    expect(formatDisplays(null)).toEqual([])
    expect(formatDisplays('')).toEqual([])
    expect(formatDisplays('not-json')).toEqual([])
    expect(formatDisplays(JSON.stringify([{ height: 1080 }]))).toEqual([])
  })
})

describe('describeDisplays', () => {
  it('adds name and position detail for tooltips', () => {
    const json = JSON.stringify([{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080 }])
    expect(describeDisplays(json)).toBe('#1 1920×1080 DP-1 @0,0')
    expect(describeDisplays(null)).toBe('')
  })
})
