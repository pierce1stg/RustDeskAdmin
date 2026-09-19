import { describe, expect, it } from 'vitest'
import { EMOJI_GROUPS, insertAtCursor } from '../chatEmoji'

describe('EMOJI_GROUPS invariants', () => {
  it('non-empty groups of non-empty unique emoji', () => {
    expect(EMOJI_GROUPS.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    for (const g of EMOJI_GROUPS) {
      expect(g.id).toBeTruthy()
      expect(g.emojis.length).toBeGreaterThan(0)
      for (const e of g.emojis) {
        expect(e.length).toBeGreaterThan(0)
        expect(seen.has(e)).toBe(false)
        seen.add(e)
      }
    }
  })
})

describe('insertAtCursor', () => {
  it('inserts mid-string and returns the caret after the insert', () => {
    expect(insertAtCursor('hello', 'X', 2, 2)).toEqual({ value: 'heXllo', caret: 3 })
  })

  it('replaces a selection', () => {
    expect(insertAtCursor('hello', 'X', 1, 4)).toEqual({ value: 'hXo', caret: 2 })
  })

  it('astral-plane emoji counts in UTF-16 offsets (surrogate pairs)', () => {
    const smile = '😀'
    expect(smile.length).toBe(2)
    expect(insertAtCursor('', smile, 0, 0)).toEqual({ value: smile, caret: 2 })
    expect(insertAtCursor('a', smile, 1, 1)).toEqual({ value: `a${smile}`, caret: 3 })
  })

  it('clamps out-of-range offsets', () => {
    expect(insertAtCursor('hi', 'X', -5, 99)).toEqual({ value: 'X', caret: 1 })
    expect(insertAtCursor('hi', 'X', 2, 1)).toEqual({ value: 'hiX', caret: 3 })
  })
})
