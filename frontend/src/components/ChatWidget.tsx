import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircle, Minus, Send, Smile, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { CHAT_MAX_CHARS } from '@/lib/rustdesk/proto'
import { EMOJI_GROUPS, insertAtCursor } from '@/lib/chatEmoji'
import {
  CHAT_BUBBLE_KEY,
  CHAT_BUBBLE_SIZE,
  CHAT_WIN_H,
  CHAT_WIN_W,
  clampChatPos,
  defaultBubblePos,
  anchorWinToBubble,
  allowDragStart,
  loadChatPos,
  saveChatPos,
  type ChatPos,
} from '@/lib/rustdesk/chatpos'
import type { RustdeskControls } from '@/lib/rustdesk/useRustdeskControl'

const CLICK_SLOP = 6

function viewport(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: 1280, vh: 800 }
  return { vw: window.innerWidth, vh: window.innerHeight }
}

type ChatMode = 'closed' | 'open' | 'bubble'

export interface ChatAutoMessages {
  greeting: { enabled: boolean; text: string }
  closeNotice: { enabled: boolean; text: string }
}

export function ChatWidget({
  controls,
  openRequest,
  autoMessages,
}: {
  controls: RustdeskControls
  openRequest: number
  autoMessages: ChatAutoMessages
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [mode, setMode] = useState<ChatMode>('closed')
  const [bubblePos, setBubblePos] = useState<ChatPos>(() => {
    const { vw, vh } = viewport()
    const d = defaultBubblePos(vw, vh)
    return clampChatPos(loadChatPos(CHAT_BUBBLE_KEY, d), vw, vh, CHAT_BUBBLE_SIZE, CHAT_BUBBLE_SIZE)
  })
  // Window position is derived from the bubble on every open (the window
  // lives where the bubble is); dragging the window never moves the bubble,
  // so minimizing always returns to the bubble's spot. Not persisted.
  const [winPos, setWinPos] = useState<ChatPos>(() => {
    const { vw, vh } = viewport()
    return clampChatPos(defaultBubblePos(vw, vh), vw, vh, CHAT_WIN_W, CHAT_WIN_H)
  })
  const [draft, setDraft] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiGroup, setEmojiGroup] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; orig: ChatPos; moved: boolean } | null>(null)
  const dragTargetRef = useRef<'bubble' | 'win' | null>(null)
  const greetedRef = useRef(false)

  const chat = controls.state.chat
  const unread = controls.state.unreadChat

  // Window opens anchored to the bubble: same spot, clamped to fit.
  const openWindow = () => {
    const { vw, vh } = viewport()
    setWinPos(anchorWinToBubble(bubblePos, vw, vh))
    setMode('open')
  }

  // Auto-greeting (once per session, user-initiated opens only — never as a
  // reply to an incoming message, and never for an empty/disabled text).
  const maybeGreet = () => {
    if (greetedRef.current) return
    greetedRef.current = true
    const g = autoMessages.greeting
    if (!g.enabled || !g.text.trim()) return
    controls.sendChat(g.text)
    controls.publishLog('ui: chat greeting sent', 'ui')
  }

  // Toolbar button (or any external trigger) opens the window.
  useEffect(() => {
    if (openRequest > 0) {
      maybeGreet()
      openWindow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])

  // Incoming messages activate the chat straight into the bubble (unless the
  // window is already open). Read history alone never pops anything up.
  useEffect(() => {
    if (mode === 'closed' && unread > 0) setMode('bubble')
  }, [mode, unread, chat.length])

  // Seen while open: clear the badge.
  useEffect(() => {
    if (mode === 'open') controls.markChatRead()
  }, [mode, chat.length, controls])

  // New messages keep the open window pinned to the bottom.
  useEffect(() => {
    const el = listRef.current
    if (el && mode === 'open') el.scrollTop = el.scrollHeight
  }, [chat.length, mode])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    if (text.length > CHAT_MAX_CHARS) {
      toast({ title: t('control.chatTooLong'), variant: 'destructive' })
      return
    }
    controls.sendChat(text)
    controls.publishLog(`ui: chat sent (${text.length} chars)`, 'ui')
    setDraft('')
    setEmojiOpen(false)
  }

  const insertEmoji = (e: string) => {
    const ta = taRef.current
    const start = ta?.selectionStart ?? draft.length
    const end = ta?.selectionEnd ?? draft.length
    const next = insertAtCursor(draft, e, start, end)
    setDraft(next.value)
    requestAnimationFrame(() => {
      ta?.focus()
      try {
        ta?.setSelectionRange(next.caret, next.caret)
      } catch {
        // non-text inputs — ignore
      }
    })
  }

  const beginDrag = (e: React.PointerEvent, target: 'bubble' | 'win', pos: ChatPos, selfIsButton = false) => {
    // Clicks on header buttons (minimize/close) must reach the buttons: never
    // start a drag — and never capture the pointer — from inside a <button>.
    // (Capturing on pointerdown retargets pointerup to the header, which is
    // exactly what used to eat every button click.) The bubble itself IS a
    // button, so its own presses always drag (click opens via CLICK_SLOP).
    if (!allowDragStart(e.target, selfIsButton)) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture?.(e.pointerId)
    dragTargetRef.current = target
    dragRef.current = { startX: e.clientX, startY: e.clientY, orig: pos, moved: false }
  }

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const target = dragTargetRef.current
    if (!d || !target) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) d.moved = true
    if (!d.moved) return
    const next = { x: d.orig.x + dx, y: d.orig.y + dy }
    if (target === 'bubble') setBubblePos(next)
    else setWinPos(next)
  }

  const endDrag = (target: 'bubble' | 'win', pos: ChatPos): boolean => {
    // Returns true when it was a click (no real movement). Only the bubble
    // persists (the window re-anchors to the bubble on every open).
    const d = dragRef.current
    dragRef.current = null
    dragTargetRef.current = null
    if (!d || !d.moved) return true
    const { vw, vh } = viewport()
    if (target === 'bubble') {
      const clamped = clampChatPos(pos, vw, vh, CHAT_BUBBLE_SIZE, CHAT_BUBBLE_SIZE)
      setBubblePos(clamped)
      saveChatPos(CHAT_BUBBLE_KEY, clamped)
    } else {
      setWinPos(clampChatPos(pos, vw, vh, CHAT_WIN_W, CHAT_WIN_H))
    }
    return false
  }

  if (mode === 'closed') return null

  if (mode === 'bubble') {
    return (
      <button
        type="button"
        aria-label={t('control.chatOpen')}
        title={t('control.chatTitle')}
        onPointerDown={(e) => beginDrag(e, 'bubble', bubblePos, true)}
        onPointerMove={onDragMove}
        onPointerUp={() => {
          if (endDrag('bubble', bubblePos)) {
            maybeGreet()
            openWindow()
          }
        }}
        className="raw-focus fixed z-40 flex select-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
        style={{ left: bubblePos.x, top: bubblePos.y, width: CHAT_BUBBLE_SIZE, height: CHAT_BUBBLE_SIZE, touchAction: 'none' }}
      >
        <MessageCircle className="h-6 w-6" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 font-mono text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    )
  }

  return (
    <div
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      style={{ left: winPos.x, top: winPos.y, width: `min(${CHAT_WIN_W}px, 90vw)`, height: `min(${CHAT_WIN_H}px, 70vh)` }}
    >
      <div
        className="flex cursor-move touch-none select-none items-center gap-2 border-b bg-muted/60 px-3 py-2"
        onPointerDown={(e) => beginDrag(e, 'win', winPos)}
        onPointerMove={onDragMove}
        onPointerUp={() => endDrag('win', winPos)}
      >
        <MessageCircle className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 truncate text-xs font-medium">{t('control.chatTitle')}</span>
        <button
          type="button"
          aria-label={t('control.chatMinimize')}
          title={t('control.chatMinimize')}
          onClick={() => setMode('bubble')}
          className="raw-focus rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t('control.chatClose')}
          title={t('control.chatClose')}
          onClick={() => {
            // Closing dismisses: pending unread goes with it (history stays).
            // A non-empty chat also notifies the host, if configured — the
            // protocol has no remote-close, so a notice message is the way.
            const n = autoMessages.closeNotice
            if (n.enabled && n.text.trim() && chat.length > 0) {
              controls.sendChat(n.text)
              controls.publishLog('ui: chat close notice sent', 'ui')
            }
            controls.markChatRead()
            setMode('closed')
          }}
          className="raw-focus rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {chat.length === 0 && <p className="text-center text-xs text-muted-foreground">{t('control.chatEmpty')}</p>}
        {chat.map((m, i) => (
          <div key={`${m.ts}-${i}`} className={`flex ${m.from === 'self' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] break-words rounded-lg px-2.5 py-1.5 text-[13px] leading-snug ${
                m.from === 'self' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
              }`}
            >
              <div className="whitespace-pre-wrap">{m.text}</div>
              <div className={`mt-0.5 text-right font-mono text-[10px] opacity-70`}>{m.ts}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="relative flex items-end gap-2 border-t p-2">
        {emojiOpen && (
          <div className="absolute bottom-full left-2 right-2 z-10 mb-2 rounded-lg border bg-background p-2 shadow-xl">
            <div className="mb-1.5 flex flex-wrap gap-1">
              {EMOJI_GROUPS.map((g, i) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setEmojiGroup(i)}
                  className={`raw-focus rounded px-1.5 py-0.5 text-base leading-6 ${
                    i === emojiGroup ? 'bg-primary/15' : 'hover:bg-muted'
                  }`}
                >
                  {g.emojis[0]}
                </button>
              ))}
            </div>
            <div className="grid max-h-36 grid-cols-8 gap-0.5 overflow-y-auto">
              {EMOJI_GROUPS[emojiGroup].emojis.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => insertEmoji(e)}
                  className="raw-focus rounded px-1 py-0.5 text-xl leading-7 hover:bg-muted"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        <Button
          size="icon"
          onClick={() => setEmojiOpen((v) => !v)}
          aria-label={t('control.chatEmoji')}
          title={t('control.chatEmoji')}
          variant="ghost"
          className="h-9 w-9 shrink-0"
        >
          <Smile className="h-4 w-4" />
        </Button>
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape') {
              setEmojiOpen(false)
            }
          }}
          placeholder={t('control.chatPlaceholder')}
          rows={2}
          maxLength={CHAT_MAX_CHARS + 100}
          className="max-h-24 min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-[13px] shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button size="icon" onClick={send} aria-label={t('control.chatSend')} title={t('control.chatSend')} className="h-9 w-9 shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
