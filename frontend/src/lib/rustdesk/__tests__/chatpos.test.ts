import { afterEach, describe, expect, it } from 'vitest'
import {
  CHAT_BUBBLE_SIZE,
  allowDragStart,
  anchorWinToBubble,
  clampChatPos,
  defaultBubblePos,
  isButtonPress,
  loadChatPos,
  saveChatPos,
} from '../chatpos'

afterEach(() => {
  localStorage.clear()
})

describe('chatpos defaults', () => {
  it('bubble defaults to the middle of the left edge', () => {
    expect(defaultBubblePos(1280, 800)).toEqual({ x: 12, y: 800 / 2 - CHAT_BUBBLE_SIZE / 2 })
  })
})

describe('anchorWinToBubble', () => {
  it('window opens exactly where the bubble is', () => {
    expect(anchorWinToBubble({ x: 12, y: 376 }, 1280, 800)).toEqual({ x: 12, y: 376 })
    expect(anchorWinToBubble({ x: 900, y: 100 }, 1280, 800)).toEqual({ x: 900, y: 100 })
  })

  it('clamps when the bubble sits where the window would overflow', () => {
    // Bottom-right bubble: window shifts up-left to fit (320x420).
    expect(anchorWinToBubble({ x: 1250, y: 770 }, 1280, 800)).toEqual({ x: 960, y: 380 })
  })
})

describe('clampChatPos', () => {
  it('keeps the element fully on screen', () => {
    expect(clampChatPos({ x: -50, y: 900 }, 1280, 800, 48, 48)).toEqual({ x: 0, y: 752 })
    expect(clampChatPos({ x: 2000, y: 10 }, 1280, 800, 320, 420)).toEqual({ x: 960, y: 10 })
    expect(clampChatPos({ x: 100, y: 100 }, 1280, 800, 48, 48)).toEqual({ x: 100, y: 100 })
  })

  it('tiny viewports pin to origin instead of going negative', () => {
    expect(clampChatPos({ x: 100, y: 100 }, 30, 30, 48, 48)).toEqual({ x: 0, y: 0 })
  })
})

describe('isButtonPress (drag vs button clicks)', () => {
  it('presses inside buttons must not start a drag', () => {
    const header = document.createElement('div')
    const btn = document.createElement('button')
    const icon = document.createElement('span')
    btn.appendChild(icon)
    header.appendChild(btn)
    const plain = document.createElement('span')
    header.appendChild(plain)
    // Button itself and anything nested in it (svg icons etc.).
    expect(isButtonPress(btn)).toBe(true)
    expect(isButtonPress(icon)).toBe(true)
    // Header background and non-element targets start drags.
    expect(isButtonPress(header)).toBe(false)
    expect(isButtonPress(plain)).toBe(false)
    expect(isButtonPress(null)).toBe(false)
    expect(isButtonPress(undefined)).toBe(false)
    expect(isButtonPress('button')).toBe(false)
  })

  it('allowDragStart: bubble drags itself, headers yield to nested buttons', () => {
    const header = document.createElement('div')
    const btn = document.createElement('button')
    header.appendChild(btn)
    // Window header: background drags, buttons click.
    expect(allowDragStart(header, false)).toBe(true)
    expect(allowDragStart(btn, false)).toBe(false)
    // Bubble is a button itself: its own presses always drag
    // (click-vs-drag settled by movement, so open-on-click still works).
    expect(allowDragStart(btn, true)).toBe(true)
    expect(allowDragStart(header, true)).toBe(true)
  })
})

describe('load/save round-trip', () => {
  it('persists and restores', () => {
    saveChatPos('k', { x: 123, y: 456 })
    expect(loadChatPos('k', { x: 0, y: 0 })).toEqual({ x: 123, y: 456 })
  })

  it('falls back on missing/garbage', () => {
    expect(loadChatPos('missing', { x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
    localStorage.setItem('k', 'not-json')
    expect(loadChatPos('k', { x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
    localStorage.setItem('k', '{"x":"a","y":null}')
    expect(loadChatPos('k', { x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
    localStorage.setItem('k', '{"x":1,"y":null}')
    expect(loadChatPos('k', { x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
  })
})
