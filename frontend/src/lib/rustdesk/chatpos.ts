// Pure positioning helpers for the floating session-chat widget (bubble +
// window). No React/DOM imports, so they unit-test cleanly; the component is
// a thin renderer over these.
export interface ChatPos {
  x: number
  y: number
}

export const CHAT_BUBBLE_KEY = 'rd-chat-bubble'
export const CHAT_BUBBLE_SIZE = 48
export const CHAT_WIN_W = 320
export const CHAT_WIN_H = 420

// Default bubble spot: middle of the LEFT edge (spec). The window anchors to
// the bubble on every open, so it needs no persisted position of its own.
export function defaultBubblePos(vw: number, vh: number): ChatPos {
  return { x: 12, y: Math.max(12, vh / 2 - CHAT_BUBBLE_SIZE / 2) }
}

// Window anchor: the window opens with its top-left at the bubble spot
// (same place), clamped so it always fits on screen.
export function anchorWinToBubble(bubble: ChatPos, vw: number, vh: number): ChatPos {
  return clampChatPos(bubble, vw, vh, CHAT_WIN_W, CHAT_WIN_H)
}

// Keep a floating element fully on screen (called on load and after drags).
export function clampChatPos(p: ChatPos, vw: number, vh: number, w: number, h: number): ChatPos {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, vw - w)),
    y: Math.min(Math.max(0, p.y), Math.max(0, vh - h)),
  }
}

export function loadChatPos(key: string, fallback: ChatPos): ChatPos {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const p = JSON.parse(raw) as Partial<ChatPos>
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return fallback
    }
    return { x: p.x, y: p.y }
  } catch {
    return fallback
  }
}

export function saveChatPos(key: string, p: ChatPos): void {
  try {
    localStorage?.setItem(key, JSON.stringify(p))
  } catch {
    // private mode — position simply doesn't persist
  }
}

// True when a pointerdown must NOT start a window/bubble drag: presses born
// inside a <button> belong to the button (minimize/close/...). Starting a
// drag there captures the pointer and retargets pointerup away from the
// button, so the click never fires (regression: dead minimize/close).
export function isButtonPress(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const closest = (target as { closest?: unknown }).closest
  if (typeof closest !== 'function') return false
  return !!(closest as (sel: string) => unknown).call(target, 'button')
}

// Drag-start decision: the bubble IS a <button> itself, so its own presses
// always drag (click-vs-drag is settled by movement, see CLICK_SLOP); window
// headers must yield to nested buttons.
export function allowDragStart(target: unknown, selfIsButton: boolean): boolean {
  if (selfIsButton) return true
  return !isButtonPress(target)
}
