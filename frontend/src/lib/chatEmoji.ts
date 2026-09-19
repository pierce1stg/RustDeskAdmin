// Curated emoji palette for the session-chat picker (no third-party deps:
// zero bundle/network risk on the relay hosts). Grouped; the widget renders
// the first emoji of each group as its tab, so no locale keys are needed.
export interface EmojiGroup {
  id: string
  emojis: string[]
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  { id: 'faces', emojis: ['😀', '😁', '😂', '🙂', '😉', '😍', '🤔', '😮', '😢', '😡', '👍', '👎'] },
  { id: 'gestures', emojis: ['👋', '✋', '🤝', '🙏', '💪', '👏', '🫡', '🤞', '✌️', '🤟'] },
  { id: 'hearts', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💯'] },
  { id: 'objects', emojis: ['💡', '🔧', '🔨', '💻', '🖥️', '⌨️', '🖱️', '📱', '🔋', '💾'] },
  { id: 'nature', emojis: ['☀️', '🌙', '⭐', '🔥', '💧', '🌈', '🌳', '🌸', '🐱', '🐶'] },
  { id: 'food', emojis: ['🍎', '🍕', '🍔', '🍩', '☕', '🍺', '🍷', '🎂', '🍉', '🌽'] },
  { id: 'activity', emojis: ['⚽', '🏀', '🎮', '🎲', '🎯', '🚗', '✈️', '🚀', '🎉', '🎁'] },
  { id: 'symbols', emojis: ['✅', '❌', '⚠️', '❓', '❗', '➡️', '⬅️', '🔄', '⏰', '🔒'] },
]

// Insert text at the cursor (UTF-16 offsets, so astral-plane emoji with
// surrogate pairs land correctly). Returns the next value + caret offset.
export function insertAtCursor(value: string, insert: string, start: number, end: number): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length))
  const e = Math.max(s, Math.min(end, value.length))
  const next = value.slice(0, s) + insert + value.slice(e)
  return { value: next, caret: s + insert.length }
}
