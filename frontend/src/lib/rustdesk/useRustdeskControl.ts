import { useCallback, useRef, useState } from 'react'
import { WebRustDeskSession, SessionConfig, VideoPacket, RemotePeerInfo, SessionStats } from './session'
import type { LogCategory, LogLevel } from './session'
import {
  LogEntry,
  LogPrefs,
  connectMarker,
  errorDropMarker,
  filterLogEntries,
  loadLogPrefs,
  saveLogPrefs,
  shouldRecord,
  statusDropMarker,
  toggleInList,
} from './logprefs'

export type ControlStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected'

export interface ControlState {
  status: ControlStatus
  error: string | null
  logs: LogEntry[]
  info: RemotePeerInfo | null
  stats: SessionStats | null
  // Session chat with the human at the host. Session-scoped like the
  // journal: kept across drops/reconnects, cleared on explicit disconnect.
  chat: ChatMsg[]
  // Incoming messages not yet seen (widget open resets it).
  unreadChat: number
  // Non-null while the host is waiting for a TOTP code ("2FA Required" /
  // the last error: "Wrong 2FA Code").
  twoFactorPending: string | null
  // True while a LoginRequest is sent but unanswered — most likely a human
  // approval dialog open on the host (click-accept mode).
  approvalPending: boolean
}

export interface ChatMsg {
  from: 'host' | 'self'
  text: string
  ts: string
}

const MAX_CHAT = 200

export interface RustdeskControls {
  state: ControlState
  connect: (config: SessionConfig) => void
  disconnect: () => void
  sendMouse: (x: number, y: number, mask: number, modifiers?: number[]) => void
  sendKeyEvent: (body: import('./proto').KeyEventBody) => void
  sendHotkey: (controlKey: number, modifiers?: number[]) => void
  sendSwitchDisplay: () => void
  setStreamOptions: (options: Partial<import('./proto').SessionVideoOptions>) => void
  setAutoMode: (enabled: boolean) => void
  publishVideoStats: (stats: {
    decodeMs?: number | null
    paintMs?: number | null
    renderFps?: number | null
    queueDrops?: number
    queueWaitMs?: number | null
    keyErrors?: number
    deltaErrors?: number
  }) => void
  requestKeyframe: () => void
  // Unthrottled refresh for rare events (monitor switch) where a dropped
  // keyframe request would stall the picture.
  requestKeyframeNow: () => void
  // Manual codec choice (panel): re-advertises supported_decoding mid-session.
  // Software codecs only (auto, vp8, vp9, av1); the choice is literal.
  setCodecPreference: (codec: 'auto' | import('./proto').CodecName) => void
  // Called by the decoder when WebCodecs proves a codec undecodable in this
  // engine: re-negotiates supported_decoding with the host so it switches
  // encoders. AUTO mode only — a manual pin is literal, so this returns null
  // and the caller surfaces the fatal banner instead. Returns the switch
  // target, or null when every candidate is exhausted.
  negotiateDecoderFallback: (codec: string) => string | null
  sendClipboardText: (text: string) => void
  registerVideo: (handler: (packet: VideoPacket) => void) => void
  registerClipboard: (handler: (text: string) => void) => void
  registerCursor: (handler: (cursor: import('./proto').ParsedCursor) => void) => void
  // Codecs the host can encode (peerEncoding-filtered). Used by presets.
  getHostCodecs: () => import('./proto').CodecName[]
  // Absolute remote-pointer position (host CursorPosition messages). Anchors
  // the phone "pointer mode" indicator and click target.
  registerCursorPosition: (handler: (x: number, y: number) => void) => void
  sendMouseRelative: (dx: number, dy: number) => void
  setShowRemoteCursor: (enabled: boolean) => void
  publishLog: (message: string, category?: LogCategory, level?: LogLevel) => void
  submit2FA: (code: string) => void
  clear: () => void
  // Journal filtering (persisted prefs; the LINES always reset on disconnect).
  logPrefs: LogPrefs
  toggleLogLevel: (level: LogLevel) => void
  toggleLogCategory: (category: LogCategory) => void
  // Flip the live session's debug emission (the chip works without reconnect).
  setSessionDebug: (v: boolean) => void
  // Session chat: send (appends own message), mark incoming as seen.
  sendChat: (text: string) => void
  markChatRead: () => void
  // Visible rows for the current prefs + search query (markers always pass).
  visibleLogs: (query: string) => LogEntry[]
  // Empty the journal without touching the session.
  clearLogs: () => void
}

const MAX_LOGS = 500

function ts(): string {
  return new Date().toISOString().slice(11, 23)
}

export function useRustdeskControl(): RustdeskControls {
  const sessionRef = useRef<WebRustDeskSession | null>(null)
  const videoHandlerRef = useRef<((packet: VideoPacket) => void) | null>(null)
  const clipboardHandlerRef = useRef<((text: string) => void) | null>(null)
  const cursorHandlerRef = useRef<((cursor: import('./proto').ParsedCursor) => void) | null>(null)
  const cursorPositionHandlerRef = useRef<((x: number, y: number) => void) | null>(null)

  const [state, setState] = useState<ControlState>({
    status: 'idle',
    error: null,
    logs: [],
    info: null,
    stats: null,
    chat: [],
    unreadChat: 0,
    twoFactorPending: null,
    approvalPending: false,
  })

  // Filter prefs (persisted) + a ref mirror: the session callback is created
  // once per connect, so it must read current prefs without re-subscribing.
  const [logPrefs, setLogPrefs] = useState<LogPrefs>(loadLogPrefs)
  const prefsRef = useRef(logPrefs)
  // True while an explicit user disconnect is in flight (vs a drop): drops
  // keep the journal (+marker), explicit exits clear it.
  const userClosingRef = useRef(false)
  // An 'error' event already produced its marker — the trailing
  // 'disconnected' status must not add a second one.
  const dropNotifiedRef = useRef(false)

  const pushLogs = useCallback((entries: LogEntry[]) => {
    if (entries.length === 0) return
    setState((s) => ({ ...s, logs: [...s.logs, ...entries].slice(-MAX_LOGS) }))
  }, [])

  const stopSession = useCallback(() => {
    sessionRef.current?.disconnect()
    sessionRef.current = null
  }, [])

  const disconnect = useCallback(() => {
    userClosingRef.current = true
    stopSession()
    setState({ status: 'idle', error: null, logs: [], info: null, stats: null, chat: [], unreadChat: 0, twoFactorPending: null, approvalPending: false })
  }, [stopSession])

  const clearLogs = useCallback(() => {
    setState((s) => ({ ...s, logs: [] }))
  }, [])

  const toggleLogLevel = useCallback((level: LogLevel) => {
    setLogPrefs((p) => {
      const next = { ...p, levels: toggleInList(p.levels, level) }
      saveLogPrefs(next)
      // The debug chip drives the running session too: without this it only
      // filtered display while the session emitted nothing (needed ?debug=1).
      if (level === 'debug') sessionRef.current?.setSessionDebug(next.levels.includes('debug'))
      return next
    })
  }, [])

  const toggleLogCategory = useCallback((category: LogCategory) => {
    setLogPrefs((p) => {
      const next = { ...p, categories: toggleInList(p.categories, category) }
      saveLogPrefs(next)
      return next
    })
  }, [])

  const visibleLogs = useCallback(
    (query: string) => filterLogEntries(state.logs, prefsRef.current, query),
    [state.logs],
  )

  // NOTE: prefsRef must track logPrefs for the session callback below.
  prefsRef.current = logPrefs

  const connect = useCallback(
    (config: SessionConfig) => {
      // A (re)connect never wipes the journal: drops stay visible. Only an
      // explicit disconnect() clears. Stop the old session silently.
      stopSession()
      userClosingRef.current = false
      dropNotifiedRef.current = false

      const session = new WebRustDeskSession(config, (ev) => {
        if (sessionRef.current !== session) return
        if (ev.type === 'status') {
          if (ev.status === 'connected') dropNotifiedRef.current = false
          const r = statusDropMarker(ev.status, {
            userClosing: userClosingRef.current,
            dropNotified: dropNotifiedRef.current,
          }, ts())
          dropNotifiedRef.current = r.dropNotified
          if (r.entry) pushLogs([r.entry])
          setState((s) => ({
            ...s,
            status: ev.status,
            error: null,
            twoFactorPending: ev.status === 'connected' || ev.status === 'disconnected' ? null : s.twoFactorPending,
            approvalPending: false,
          }))
        } else if (ev.type === 'error') {
          dropNotifiedRef.current = true
          pushLogs([errorDropMarker(ev.message, ts())])
          setState((s) => ({ ...s, status: 'error', error: ev.message, twoFactorPending: null, approvalPending: false }))
        } else if (ev.type === 'two-fa') {
          setState((s) => ({ ...s, twoFactorPending: ev.message, approvalPending: false }))
        } else if (ev.type === 'approval-pending') {
          setState((s) => ({ ...s, approvalPending: true }))
        } else if (ev.type === 'peer-info') {
          setState((s) => ({ ...s, info: ev.info }))
        } else if (ev.type === 'video') {
          videoHandlerRef.current?.(ev.packet)
        } else if (ev.type === 'clipboard') {
          clipboardHandlerRef.current?.(ev.text)
        } else if (ev.type === 'chat') {
          // Incoming chat: append + raise unread (the widget clears it when
          // open). No journal line — message content stays out of the log.
          const entry: ChatMsg = { from: 'host', text: ev.text, ts: ts() }
          setState((s) => ({ ...s, chat: [...s.chat, entry].slice(-MAX_CHAT), unreadChat: s.unreadChat + 1 }))
        } else if (ev.type === 'cursor') {
          cursorHandlerRef.current?.(ev.cursor)
        } else if (ev.type === 'cursor_position') {
          cursorPositionHandlerRef.current?.(ev.x, ev.y)
        } else if (ev.type === 'log') {
          // Disabled classes are dropped here — never recorded, never rendered.
          if (!shouldRecord(ev.level, ev.category, prefsRef.current)) return
          pushLogs([{ ts: ts(), level: ev.level, category: ev.category, message: ev.message }])
        } else if (ev.type === 'stats') {
          setState((s) => ({ ...s, stats: ev.stats }))
        }
      })

      // A persisted debug pref applies from the first line (no ?debug=1 needed).
      session.setSessionDebug(prefsRef.current.levels.includes('debug'))
      if (videoHandlerRef.current) session.setVideoHandler(videoHandlerRef.current)

      sessionRef.current = session
      setState((s) => ({ status: 'connecting', error: null, info: null, stats: null, twoFactorPending: null, approvalPending: false, logs: s.logs, chat: s.chat, unreadChat: s.unreadChat }))
      pushLogs([connectMarker(config.peerId, ts())])
      session.connect()
    },
    [stopSession, pushLogs],
  )

  const registerVideo = useCallback((handler: (packet: VideoPacket) => void) => {
    videoHandlerRef.current = handler
    sessionRef.current?.setVideoHandler(handler)
  }, [])

  const registerClipboard = useCallback((handler: (text: string) => void) => {
    clipboardHandlerRef.current = handler
  }, [])

  const registerCursor = useCallback((handler: (cursor: import('./proto').ParsedCursor) => void) => {
    cursorHandlerRef.current = handler
  }, [])

  const registerCursorPosition = useCallback((handler: (x: number, y: number) => void) => {
    cursorPositionHandlerRef.current = handler
  }, [])

  const getHostCodecs = useCallback(() => {
    return sessionRef.current?.getHostCodecs() ?? []
  }, [])

  const sendMouseRelative = useCallback((dx: number, dy: number) => {
    sessionRef.current?.sendMouseRelative(dx, dy)
  }, [])

  const setShowRemoteCursor = useCallback((enabled: boolean) => {
    sessionRef.current?.setShowRemoteCursor(enabled)
  }, [])

  const publishLog = useCallback((message: string, category: LogCategory = 'system', level: LogLevel = 'info') => {
    sessionRef.current?.logInfo(message, category, level)
  }, [])

  const sendMouse = useCallback((x: number, y: number, mask: number, modifiers: number[] = []) => {
    sessionRef.current?.sendMouse(x, y, mask, modifiers)
  }, [])

  const sendKeyEvent = useCallback((body: import('./proto').KeyEventBody) => {
    sessionRef.current?.sendKeyEvent(body)
  }, [])

  const sendHotkey = useCallback((controlKey: number, modifiers: number[] = []) => {
    sessionRef.current?.sendHotkey(controlKey, modifiers)
  }, [])

  const sendSwitchDisplay = useCallback(() => {
    sessionRef.current?.sendSwitchDisplay()
  }, [])

  const requestKeyframe = useCallback(() => {
    sessionRef.current?.requestKeyframe()
  }, [])

  const requestKeyframeNow = useCallback(() => {
    sessionRef.current?.requestKeyframeNow()
  }, [])

  const setCodecPreference = useCallback((codec: 'auto' | import('./proto').CodecName) => {
    sessionRef.current?.setCodecPreference(codec)
  }, [])

  const negotiateDecoderFallback = useCallback((codec: string) => {
    return sessionRef.current?.negotiateDecoderFallback(codec) ?? null
  }, [])

  const setStreamOptions = useCallback((options: Partial<import('./proto').SessionVideoOptions>) => {
    sessionRef.current?.setStreamOptions(options)
  }, [])

  const setAutoMode = useCallback((enabled: boolean) => {
    sessionRef.current?.setAutoMode(enabled)
  }, [])


  const publishVideoStats = useCallback(
    (stats: {
      decodeMs?: number | null
      paintMs?: number | null
      renderFps?: number | null
      queueDrops?: number
      queueWaitMs?: number | null
      keyErrors?: number
      deltaErrors?: number
    }) => {
      sessionRef.current?.publishVideoStats(stats)
    },
    [],
  )

  const sendClipboardText = useCallback((text: string) => {
    sessionRef.current?.sendClipboardText(text)
  }, [])

  const sendChat = useCallback((text: string) => {
    if (!text) return
    sessionRef.current?.sendChatMessage(text)
    const entry: ChatMsg = { from: 'self', text, ts: ts() }
    setState((s) => ({ ...s, chat: [...s.chat, entry].slice(-MAX_CHAT) }))
  }, [])

  const markChatRead = useCallback(() => {
    setState((s) => (s.unreadChat === 0 ? s : { ...s, unreadChat: 0 }))
  }, [])

  const setSessionDebug = useCallback((v: boolean) => {
    sessionRef.current?.setSessionDebug(v)
  }, [])

  const submit2FA = useCallback((code: string) => {
    sessionRef.current?.submit2FACode(code)
  }, [])

  return {
    state,
    connect,
    disconnect,
    sendMouse,
    sendKeyEvent,
    sendHotkey,
    sendSwitchDisplay,
    setStreamOptions,
    setAutoMode,
    publishVideoStats,
    requestKeyframe,
    requestKeyframeNow,
    setCodecPreference,
    negotiateDecoderFallback,
    sendClipboardText,
    registerVideo,
    registerClipboard,
    getHostCodecs,
    registerCursor,
    registerCursorPosition,
    sendMouseRelative,
    setShowRemoteCursor,
    publishLog,
    submit2FA,
    clear: disconnect,
    logPrefs,
    toggleLogLevel,
    toggleLogCategory,
    setSessionDebug,
    sendChat,
    markChatRead,
    visibleLogs,
    clearLogs,
  }
}