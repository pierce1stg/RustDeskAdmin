import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, MonitorX, RefreshCw, ScreenShare, AlertTriangle, Info, ChevronDown, ChevronUp, Terminal, Activity, Pin, PinOff, X, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PasswordInput } from '@/components/ui/password-input'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { RemoteScreen, type RenderScale } from '@/components/RemoteScreen'
import { ChatWidget } from '@/components/ChatWidget'
import { probeBrowserCodecs, pickTurboCodec } from '@/lib/rustdesk/codecs'
import { LOG_CATEGORIES, LOG_LEVELS, splitHighlight } from '@/lib/rustdesk/logprefs'
import type { LogLevel } from '@/lib/rustdesk/session'
import { SessionToolbar, type ZoomMode, type CodecPreference } from '@/components/SessionToolbar'
import { useRustdeskControl } from '@/lib/rustdesk/useRustdeskControl'
import { useServerInfo } from '@/api/serverInfo'
import { fetchSavedPeerPassword, savePeerPassword, savePeerInfoSnapshot } from '@/api/devices'
import { useSettings, WEB_CLIENT_QUALITY_KEY, WEB_CLIENT_FPS_KEY, WEB_CLIENT_CODEC_KEY, WEB_CLIENT_CHAT_GREETING_KEY, DEFAULT_WEB_CLIENT_CHAT_GREETING, WEB_CLIENT_CHAT_GREETING_ENABLED_KEY, WEB_CLIENT_CHAT_CLOSE_KEY, DEFAULT_WEB_CLIENT_CHAT_CLOSE, WEB_CLIENT_CHAT_CLOSE_ENABLED_KEY, WEB_CLIENT_RENDER_SCALE_KEY, WEB_CLIENT_RENDER_SCALES, WEB_CLIENT_CURSOR_KEY, WEB_CLIENT_INPUT_MODE_KEY, WEB_CLIENT_NAME_KEY, DEFAULT_WEB_CLIENT_NAME } from '@/api/settings'
import { useToast } from '@/hooks/use-toast'

const LOG_LEVEL_STYLE: Record<LogLevel, string> = {
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  error: 'bg-red-500/15 text-red-700 dark:text-red-300',
  debug: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
}

const CHIP_BASE = 'raw-focus rounded-full px-2 py-0.5 font-mono text-[10px] leading-4 transition-colors select-none'
const CHIP_OFF = 'bg-muted text-muted-foreground hover:bg-muted/70'
const CHIP_CAT_ON = 'bg-primary/15 text-primary'

export function RemoteControlPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { toast } = useToast()
  const remoteAreaRef = useRef<HTMLDivElement>(null)

  const { data: serverInfo, isLoading: loadingInfo } = useServerInfo()
  const controls = useRustdeskControl()
  const { status, error } = controls.state

  // Kill the session whenever we leave this page for any reason (browser back,
  // direct URL, etc.), not only via the toolbar buttons.
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  useEffect(() => () => controlsRef.current.disconnect(), [])

  const peerId = (id ?? '').replace(/\s+/g, '')
  const [password, setPassword] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [remember, setRemember] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(true)
  const [quality, setQuality] = useState(3)
  const [fps, setFps] = useState(30)
  // Manual codec choice: 'auto' = all codecs supported, host picks the best.
  const [codec, setCodec] = useState<CodecPreference>(() => {
    try {
      const saved = localStorage.getItem('rd-codec')
      if (saved === 'vp8' || saved === 'vp9' || saved === 'av1') return saved
    } catch {
      // ignore
    }
    return 'auto'
  })

  // Hydrate the connect dialog from admin-set web-client defaults. The user's
  // own saved codec preference (localStorage) wins over the server default.
  const { data: serverSettings } = useSettings()
  const hydratedDefaultsRef = useRef(false)
  useEffect(() => {
    if (hydratedDefaultsRef.current || !serverSettings) return
    hydratedDefaultsRef.current = true
    const q = Number(serverSettings[WEB_CLIENT_QUALITY_KEY])
    if (q === 0 || q === 2 || q === 3 || q === 4) setQuality(q)
    const f = Number(serverSettings[WEB_CLIENT_FPS_KEY])
    if (Number.isInteger(f) && f >= 1 && f <= 240) setFps(f)
    setCodec((prev) => {
      if (prev !== 'auto') return prev
      const c = serverSettings[WEB_CLIENT_CODEC_KEY]
      // Software codecs only; a stale hardware default falls back to auto.
      if (c === 'vp8' || c === 'vp9' || c === 'av1') return c
      return 'auto'
    })
    // More admin defaults, same rule: the user's own saved choice
    // (localStorage) wins, the server fills in the rest. 'auto' input mode
    // keeps device detection (nothing to apply).
    const hasLocal = (k: string) => {
      try {
        return localStorage.getItem(k) !== null
      } catch {
        return false
      }
    }
    if (!hasLocal(RENDER_SCALE_KEY)) {
      const s = serverSettings[WEB_CLIENT_RENDER_SCALE_KEY]
      if (typeof s === 'string' && (WEB_CLIENT_RENDER_SCALES as readonly string[]).includes(s)) {
        setRenderScaleState(s as RenderScale)
      }
    }
    if (!hasLocal('rd-cursor')) {
      setCursorEnabled(serverSettings[WEB_CLIENT_CURSOR_KEY] === true)
    }
    if (!hasLocal(INPUT_MODE_KEY)) {
      const m = serverSettings[WEB_CLIENT_INPUT_MODE_KEY]
      if (m === 'touch' || m === 'pointer') setInputMode(m)
    }
  }, [serverSettings])
  const [fullscreen, setFullscreen] = useState(false)
  // Manual "freeze" of the remote picture (host keeps streaming; we just don't render).
  const [paused, setPaused] = useState(false)
  // The browser cannot decode the incoming video stream (unsupported codec).
  const [videoFatal, setVideoFatal] = useState<string | null>(null)
  // Codec steering succeeded (host moved from -> to): informational banner,
  // the picture should arrive on its own on the new codec.
  const [videoSteered, setVideoSteered] = useState<{ from: string; to: string } | null>(null)
  // Host-cursor overlay; off by default (format varies by client version).
  const [cursorEnabled, setCursorEnabled] = useState(() => {
    try {
      return localStorage.getItem('rd-cursor') === '1'
    } catch {
      return false
    }
  })
  const toggleCursor = () => {
    uiLog(`remote cursor ${!cursorEnabled ? 'shown' : 'hidden'}`)
    setCursorEnabled((v) => {
      const next = !v
      try {
        localStorage.setItem('rd-cursor', next ? '1' : '0')
      } catch {
        // storage unavailable — keep in-memory state only
      }
      return next
    })
  }
  // Touch input mode: 'touch' = finger taps directly, 'pointer' = finger moves
  // the remote cursor (trackpad) and a tap clicks at the cursor position.
  // Default to trackpad on touch devices; desktop keeps direct taps.
  const INPUT_MODE_KEY = 'rd-input-mode'
  const [inputMode, setInputMode] = useState<'touch' | 'pointer'>(() => {
    try {
      const stored = localStorage.getItem(INPUT_MODE_KEY)
      if (stored === 'touch' || stored === 'pointer') return stored
      const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
      return coarse ? 'pointer' : 'touch'
    } catch {
      return 'touch'
    }
  })
  const toggleInputMode = () => {
    uiLog(`input mode ${inputMode === 'pointer' ? 'touch' : 'pointer'}`)
    setInputMode((v) => {
      const next = v === 'pointer' ? 'touch' : 'pointer'
      try {
        localStorage.setItem(INPUT_MODE_KEY, next)
      } catch {
        // storage unavailable — keep in-memory state only
      }
      return next
    })
  }
  const showInputModeToggle =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  // Auto-reconnect after an unexpected drop (never after a deliberate one).
  const userDisconnectRef = useRef(false)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const [logsOpen, setLogsOpen] = useState(false)
  // Counter trigger: the toolbar chat button asks the floating widget to open.
  const [chatOpenReq, setChatOpenReq] = useState(0)
  const [logQuery, setLogQuery] = useState('')
  const [statsOpen, setStatsOpen] = useState(false)
  const [statsPinned, setStatsPinned] = useState(() => {
    try {
      return localStorage.getItem('rd-stats-pinned') === '1'
    } catch {
      return false
    }
  })
  // Last remote-cursor position (host coords) — surfaced in the connection
  // stats row. Feeds from RemoteScreen's onCursorPos callback.
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)

  const ZOOM_MODE_KEY = 'rd-zoom-mode'
  const ZOOM_PCT_KEY = 'rd-zoom-pct'
  const [zoomMode, setZoomModeState] = useState<ZoomMode>(() => {
    try {
      return (localStorage.getItem(ZOOM_MODE_KEY) as ZoomMode) || 'fit'
    } catch {
      return 'fit'
    }
  })
  const [zoomPct, setZoomPctState] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(ZOOM_PCT_KEY)) || 100
    } catch {
      return 100
    }
  })
  const setZoomMode = (m: ZoomMode) => {
    if (m !== zoomMode) uiLog(`zoom ${m}`)
    setZoomModeState(m)
    try {
      localStorage.setItem(ZOOM_MODE_KEY, m)
    } catch {
      /* noop */
    }
  }
  const setZoomPct = (p: number) => {
    if (p !== zoomPct) uiLog(`zoom ${p}%`)
    setZoomPctState(p)
    try {
      localStorage.setItem(ZOOM_PCT_KEY, String(p))
    } catch {
      /* noop */
    }
  }

  const address = serverInfo?.address?.value ?? ''
  const relayPort = serverInfo?.relay_port?.value ?? '21117'
  const serverKey = serverInfo?.public_key?.value ?? ''

  const canConnect = Boolean(address && serverKey && peerId)

  // Pre-fill a saved password when the device has one on this server.
  useEffect(() => {
    if (!canConnect) return
    let cancelled = false
    void fetchSavedPeerPassword(peerId).then((saved) => {
      if (cancelled || !saved) return
      setPassword(saved)
      toast({ title: t('control.passwordAutofilled'), variant: 'default' })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConnect])

  // Audit trail: every session-affecting user action lands in the journal
  // under the 'ui' category (recorded only if the category is enabled).
  // No-op before connect — actions are only possible mid-session anyway.
  const uiLog = (msg: string) => {
    controlsRef.current?.publishLog(`ui: ${msg}`, 'ui')
  }

  const handleQualityChange = (q: number) => {
    uiLog(`quality ${quality === 0 ? 'auto' : quality} -> ${q === 0 ? 'auto' : q} (fps ${fps})`)
    exitTurboSilent()
    setQuality(q)
    if (q === 0) {
      controls.setAutoMode(true)
      return
    }
    // setStreamOptions() already disables auto + sends once — no extra call.
    controls.setStreamOptions({ quality: q, fps })
  }
  const handleFpsChange = (f: number) => {
    uiLog(`fps ${fps} -> ${f} (quality ${quality === 0 ? 'auto' : quality})`)
    exitTurboSilent()
    setFps(f)
    controls.setStreamOptions({ quality, fps: f })
  }

  const handleCodecChange = (c: CodecPreference) => {
    uiLog(`codec ${codec} -> ${c}`)
    exitTurboSilent()
    if (c !== 'auto') {
      // Manual choice the browser cannot decode: warn and stay on the current
      // codec instead of sending a doomed stream (fallbacks run in auto only).
      // Variants share their family's engine support.
      void probeBrowserCodecs().then((support) => {
        if (!support[c]) {
          toast({
            title: t('control.codecUnsupported', { codec: c }),
            description: t('control.codecUnsupportedDesc'),
            variant: 'destructive',
          })
        } else {
          setCodec(c)
          try {
            localStorage.setItem('rd-codec', c)
          } catch {
            // ignore
          }
          controls.setCodecPreference(c)
        }
      })
      return
    }
    setCodec(c)
    try {
      localStorage.setItem('rd-codec', c)
    } catch {
      // ignore
    }
    controls.setCodecPreference(c)
  }

  const backToAutoCodec = () => {
    setVideoFatal(null)
    setVideoSteered(null)
    handleCodecChange('auto')
  }

  // Render-scale cap for the decoded picture (detail vs decode/paint speed).
  const RENDER_SCALE_KEY = 'rd-render-scale'
  const [renderScale, setRenderScaleState] = useState<RenderScale>(() => {
    try {
      const s = localStorage.getItem(RENDER_SCALE_KEY)
      if (
        s === 'original' ||
        s === '144p' ||
        s === '240p' ||
        s === '360p' ||
        s === '480p' ||
        s === '720p' ||
        s === '1080p' ||
        s === '1440p'
      )
        return s
    } catch {
      // ignore
    }
    return 'auto'
  })
  const handleRenderScaleChange = (s: RenderScale) => {
    uiLog(`render scale ${renderScale} -> ${s}`)
    exitTurboSilent()
    setRenderScaleState(s)
    try {
      localStorage.setItem(RENDER_SCALE_KEY, s)
    } catch {
      // ignore
    }
  }

  // Turbo (lowest-latency preset, session-only): snapshots the current setup,
  // applies Low/60/cheapest-codec/Auto-render, restores everything on exit.
  // Any manual knob exits turbo silently — the user's explicit choice wins,
  // no restore (the host already got the new manual values).
  const [turbo, setTurbo] = useState(false)
  const turboRef = useRef(false)
  turboRef.current = turbo
  const turboSnapshotRef = useRef<{
    quality: number
    fps: number
    codec: CodecPreference
    renderScale: RenderScale
    auto: boolean
  } | null>(null)

  const exitTurboSilent = () => {
    if (!turboRef.current) return
    turboRef.current = false
    setTurbo(false)
    turboSnapshotRef.current = null
  }

  const toggleTurbo = () => {
    if (turboRef.current) {
      // Exit: restore the snapshot instantly, then resume auto if it was on.
      const snap = turboSnapshotRef.current
      turboSnapshotRef.current = null
      setTurbo(false)
      if (!snap) {
        uiLog('turbo off')
        return
      }
      uiLog(
        `turbo off (restored codec ${snap.codec}, quality ${snap.quality}, ${snap.fps}fps, scale ${snap.renderScale})`,
      )
      setQuality(snap.quality)
      setFps(snap.fps)
      setCodec(snap.codec)
      setRenderScaleState(snap.renderScale)
      controls.setStreamOptions({ quality: snap.quality, fps: snap.fps })
      controls.setCodecPreference(snap.codec)
      if (snap.auto) controls.setAutoMode(true)
      return
    }
    turboSnapshotRef.current = {
      quality,
      fps,
      codec,
      renderScale,
      auto: quality === 0,
    }
    uiLog(`turbo on (was codec ${codec}, quality ${quality}, ${fps}fps, scale ${renderScale})`)
    setQuality(2)
    setFps(60)
    setRenderScaleState('auto')
    controls.setAutoMode(false)
    controls.setStreamOptions({ quality: 2, fps: 60 })
    setTurbo(true)
    // Cheapest mutually-supported codec lands async (probe); the rest of the
    // preset applies immediately above.
    void probeBrowserCodecs().then((browser) => {
      if (!turboRef.current) return
      const pick = pickTurboCodec(browser, controlsRef.current.getHostCodecs())
      if (!pick) return
      if (!turboRef.current) return
      setCodec(pick)
      controlsRef.current.setCodecPreference(pick)
    })
  }

  const toggleFullscreen = () => {
    uiLog(typeof document !== 'undefined' && !document.fullscreenElement ? 'fullscreen on' : 'fullscreen off')
    const el = remoteAreaRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.()
    } else {
      void document.exitFullscreen()
    }
  }

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggleStatsPin = () => {
    setStatsPinned((v) => {
      const next = !v
      try {
        localStorage.setItem('rd-stats-pinned', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
    setStatsOpen(false)
  }

  const doConnect = (passwordOverride?: string | null) => {
    if (!canConnect) return
    peerInfoSavedRef.current = false
    controls.connect({
      address,
      serverKey,
      peerId,
      password: passwordOverride ?? password,
      // null override = omit the password field entirely (variant B).
      omitPassword: passwordOverride === null,
      relayServer: address.includes(':') ? address : `${address}:${relayPort}`,
      video: {
        quality,
        fps,
      },
      auto: quality === 0,
      codec,
      clientName: String(serverSettings?.[WEB_CLIENT_NAME_KEY] ?? DEFAULT_WEB_CLIENT_NAME),
    })
    setDialogOpen(false)
  }

  const startConnection = () => {
    if (!canConnect) return
    // A manual connect always resets the auto-reconnect bookkeeping.
    reconnectAttemptsRef.current = 0
    setReconnectAttempts(0)
    userDisconnectRef.current = false
    setVideoFatal(null)
    setVideoSteered(null)
    doConnect()
    if (remember && password) {
      void savePeerPassword(peerId, password).then((ok) => {
        if (ok) toast({ title: t('control.passwordRemembered'), variant: 'success' })
      })
    }
    setDialogOpen(false)
  }

  // "Request access": dial omitting the password field entirely so a host in
  // click/both accept mode pops its Allow/Dismiss dialog instead of checking
  // a secret (verified against a live host — the omitted-field variant is the
  // one that triggers the dialog). Nothing is remembered.
  const requestAccess = () => {
    if (!canConnect) return
    reconnectAttemptsRef.current = 0
    setReconnectAttempts(0)
    userDisconnectRef.current = false
    setVideoFatal(null)
    setVideoSteered(null)
    doConnect(null)
    setDialogOpen(false)
  }

  const twoFactorPending = controls.state.twoFactorPending
  // Refs mirror render state for the status-driven effects below.
  const passwordRef = useRef(password)
  passwordRef.current = password
  const dialogOpenRef = useRef(dialogOpen)
  dialogOpenRef.current = dialogOpen
  // Pre-warm the WebCodecs probe while the user types the password, so the
  // media stack is spun up and getCachedSupport() is warm before connect().
  // Cached module-wide; zero cost on repeat opens.
  useEffect(() => {
    if (dialogOpen) void probeBrowserCodecs()
  }, [dialogOpen])
  const twoFactorRef = useRef(twoFactorPending)
  twoFactorRef.current = twoFactorPending
  const errorRef = useRef(error)
  errorRef.current = error
  // 2FA-aware reconnect: TOTP codes are one-time, so a dropped session that
  // passed 2FA cannot silently reconnect. Instead we ask for a fresh code and
  // auto-submit it on the next challenge after redialling.
  const [reconnect2FA, setReconnect2FA] = useState(false)
  const reconnect2FARef = useRef(false)
  reconnect2FARef.current = reconnect2FA
  const pendingAutoCodeRef = useRef<string | null>(null)
  const had2FARef = useRef(false)
  useEffect(() => {
    if (twoFactorPending) had2FARef.current = true
  }, [twoFactorPending])
  useEffect(() => {
    if (twoFactorPending && pendingAutoCodeRef.current) {
      const code = pendingAutoCodeRef.current
      pendingAutoCodeRef.current = null
      controlsRef.current.submit2FA(code)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twoFactorPending])

  const submit2FA = () => {
    const code = twoFactorCode.trim()
    if (!code) return
    if (reconnect2FA) {
      // Reconnect mode: redial with the stored password, then auto-submit
      // this fresh code on the new 2FA challenge.
      void (async () => {
        let pwd = passwordRef.current
        if (!pwd) {
          const saved = await fetchSavedPeerPassword(peerId)
          if (saved) {
            setPassword(saved)
            pwd = saved
          }
        }
        if (!pwd) {
          // Nothing to redial with — fall back to the password dialog.
          setReconnect2FA(false)
          pendingAutoCodeRef.current = null
          setDialogOpen(true)
          return
        }
        pendingAutoCodeRef.current = code
        setReconnect2FA(false)
        setTwoFactorCode('')
        reconnectAttemptsRef.current = 0
        setReconnectAttempts(0)
        userDisconnectRef.current = false
        doConnect(pwd)
      })()
      return
    }
    controls.submit2FA(code)
  }

  const cancel2FA = () => {
    if (reconnect2FA) {
      // Stay on the page in the disconnected view; don't retry behind the
      // user's back.
      setReconnect2FA(false)
      pendingAutoCodeRef.current = null
      setTwoFactorCode('')
      userDisconnectRef.current = true
      return
    }
    controls.disconnect()
  }

  // Reconnect after an unexpected drop: up to 5 tries with backoff+jitter,
  // then hand it back to the user via the "Reconnect" button in the status
  // area. The first retry is quick so a transient handshake hiccup recovers
  // almost invisibly.
  const scheduleReconnect = () => {
    const attempts = reconnectAttemptsRef.current
    if (attempts >= 5) {
      // Retries exhausted with no classification — ask for credentials rather
      // than looping silently forever.
      setDialogOpen(true)
      return
    }
    const base = [1000, 5000, 10000, 15000, 20000][attempts] ?? 20000
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectAttemptsRef.current += 1
      setReconnectAttempts(reconnectAttemptsRef.current)
      if (reconnectAttemptsRef.current <= 5) doConnect()
    }, delay)
  }
  // Auth-class errors (wrong password and friends) never auto-retry: open the
  // password dialog with the typed value kept. 2FA sessions can't silently
  // redial either (TOTP is one-time) — ask for a fresh code instead.
  const isAuthError = (msg: string | null) =>
    !!msg && /password|wrong|denied|auth|credential|login|2fa/i.test(msg)

  useEffect(() => {
    if (status === 'error' && isAuthError(errorRef.current)) {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      reconnectAttemptsRef.current = 0
      setReconnectAttempts(0)
      pendingAutoCodeRef.current = null
      setReconnect2FA(false)
      setDialogOpen(true)
      return
    }
    if (status === 'disconnected' && !userDisconnectRef.current) {
      // A dialog already owns the user's attention — never redial behind it.
      if (dialogOpenRef.current || twoFactorRef.current || reconnect2FARef.current) return
      if (had2FARef.current) {
        if (passwordRef.current) {
          setReconnect2FA(true)
        } else {
          setDialogOpen(true)
        }
        return
      }
      scheduleReconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // Peer switched inside the same mounted page (URL :id changed): drop the
  // previous host's secrets and reconnect bookkeeping so nothing leaks
  // across hosts (password, 2FA flags, pending codes, retry timers).
  const peerIdRef = useRef(peerId)
  useEffect(() => {
    if (peerIdRef.current === peerId) return
    peerIdRef.current = peerId
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    controlsRef.current.disconnect()
    userDisconnectRef.current = true
    reconnectAttemptsRef.current = 0
    setReconnectAttempts(0)
    had2FARef.current = false
    pendingAutoCodeRef.current = null
    setReconnect2FA(false)
    setTwoFactorCode('')
    setPassword('')
    setVideoFatal(null)
    setVideoSteered(null)
    setDialogOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId])
  useEffect(() => {
    if (status === 'connected') {
      reconnectAttemptsRef.current = 0
      setReconnectAttempts(0)
    }
  }, [status])
  useEffect(
    () => () => {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
    },
    [],
  )

  const openConnectDialog = () => {
    setPassword('')
    setDialogOpen(true)
  }

  const togglePause = () => {
    uiLog(paused ? 'pause off (resumed)' : 'pause on')
    return setPaused((p) => !p)
  }

  const goBack = () => {
    userDisconnectRef.current = true
    controls.disconnect()
    navigate('/devices')
  }

  const peerInfoSavedRef = useRef(false)
  const handleDisconnect = () => {
    // Close the session but stay on this page showing the "not connected" view.
    userDisconnectRef.current = true
    peerInfoSavedRef.current = false
    controls.disconnect()
  }

  const info = controls.state.info
  const visibleLogs = controls.visibleLogs(logQuery)
  const connected = status === 'connected'

  // Snapshot PeerInfo into the devices table once per connection (PeerInfo
  // only exists inside a live session; NULL until the first panel connect).
  useEffect(() => {
    if (!connected || !info || peerInfoSavedRef.current) return
    if (!info.hostname && !info.username && !info.platform && !info.version && (info.allDisplays?.length ?? 0) === 0) {
      return
    }
    peerInfoSavedRef.current = true
    void savePeerInfoSnapshot(peerId, {
      hostname: info.hostname,
      username: info.username,
      platform: info.platform,
      host_version: info.version ?? null,
      displays: (info.allDisplays ?? []).slice(0, 16).map((d) => ({
        name: d.name,
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
      })),
    })
  }, [connected, info, peerId])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" onClick={goBack} title={t('control.back')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0">
              <p className="truncate font-medium">{t('control.title')}: {peerId}</p>
              <p className="text-xs text-muted-foreground">
                  {info
                    ? `${info.username || '?'}@${info.hostname || '?'} · ${info.width}x${info.height}${
                        info.displayCount > 1 ? ` · ${(info.display ?? 0) + 1}/${info.displayCount}` : ''
                      }`
                    : address}
                </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={status} />
            {connected ? (
              <>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setStatsOpen((v) => !v)}
                  title={t('control.statsToggle')}
                  className={statsOpen || statsPinned ? 'text-primary' : ''}
                >
                  <Activity className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" onClick={handleDisconnect}>
                  <MonitorX className="me-2 h-4 w-4" /> {t('control.disconnect')}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={openConnectDialog} disabled={!canConnect}>
                <ScreenShare className="me-2 h-4 w-4" /> {t('control.connect')}
              </Button>
            )}
          </div>
        </CardContent>
        {connected && (statsOpen || statsPinned) && (
          <CardContent className="border-t border-border/60 p-2">
            <ConnectionStats
              stats={controls.state.stats}
              info={controls.state.info}
              cursorPos={cursorPos}
              pinned={statsPinned}
              onTogglePin={toggleStatsPin}
              onCollapse={() => setStatsOpen(false)}
            />
          </CardContent>
        )}
      </Card>

      <div ref={remoteAreaRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-muted/40 p-1">
        {/* Toolbar sits above the pause dim overlay (z-20) while paused so
            play and the whole panel stay visible and clickable. */}
        {connected && (
          <div
            className={`pointer-events-none absolute inset-x-0 top-2 flex flex-col items-center gap-2 ${
              paused ? 'z-30' : 'z-10'
            }`}
          >
            <SessionToolbar
              controls={controls}
                  paused={paused}
              onTogglePause={togglePause}
              cursorEnabled={cursorEnabled}
              onToggleCursor={toggleCursor}
              inputMode={inputMode}
              onToggleInputMode={toggleInputMode}
              showInputModeToggle={showInputModeToggle}
              quality={quality}
              onQualityChange={handleQualityChange}
              fps={fps}
              onFpsChange={handleFpsChange}
              codec={codec}
              onCodecChange={handleCodecChange}
              renderScale={renderScale}
              onRenderScaleChange={handleRenderScaleChange}
              turbo={turbo}
              onToggleTurbo={toggleTurbo}
              fullscreen={fullscreen}
              onToggleFullscreen={toggleFullscreen}
              zoomMode={zoomMode}
              onZoomModeChange={setZoomMode}
              zoomPct={zoomPct}
              onZoomPctChange={setZoomPct}
              onOpenChat={() => setChatOpenReq((n) => n + 1)}
            />
          </div>
        )}
        {connected && info && info.width > 0 && info.height > 0 ? (
          <RemoteScreen
            controls={controls}
            paused={paused}
            cursorEnabled={cursorEnabled}
            onPinchZoom={(pct) => {
              setZoomMode('custom')
              setZoomPct(pct)
            }}
            zoom={{ mode: zoomMode, pct: zoomPct }}
            inputMode={inputMode}
            renderScale={renderScale}
            turbo={turbo}
            onCursorPos={(x, y) => setCursorPos({ x, y })}
            onVideoFatal={(codec) => setVideoFatal(codec)}
            onCodecSteered={(from, to) => {
              setVideoFatal(null)
              setVideoSteered({ from, to })
            }}
          />
        ) : (
          <StatusArea
            loading={loadingInfo}
            status={status}
            error={error}
            canConnect={canConnect}
            approvalPending={controls.state.approvalPending}
            onCancel={handleDisconnect}
            onRetry={openConnectDialog}
            onReconnect={startConnection}
            reconnectAttempts={reconnectAttempts}
          />
        )}
        {connected && paused && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/50">
            <span className="rounded-lg bg-black/60 px-4 py-2 text-sm font-medium text-white">
              {t('control.pause')}
            </span>
          </div>
        )}
        {/* Floating session chat (window + bubble). Fixed positioning, so the
            mount point doesn't matter; lives while the session does (like the
            journal: drops keep it, explicit exit unmounts it). */}
        {status !== 'idle' && (
          <ChatWidget
            controls={controls}
            openRequest={chatOpenReq}
            autoMessages={{
              greeting: {
                enabled: (serverSettings?.[WEB_CLIENT_CHAT_GREETING_ENABLED_KEY] ?? true) as boolean,
                text: String(serverSettings?.[WEB_CLIENT_CHAT_GREETING_KEY] ?? DEFAULT_WEB_CLIENT_CHAT_GREETING),
              },
              closeNotice: {
                enabled: (serverSettings?.[WEB_CLIENT_CHAT_CLOSE_ENABLED_KEY] ?? true) as boolean,
                text: String(serverSettings?.[WEB_CLIENT_CHAT_CLOSE_KEY] ?? DEFAULT_WEB_CLIENT_CHAT_CLOSE),
              },
            }}
          />
        )}
        {connected && videoFatal && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-red-950/50 p-6 text-center">
            <AlertTriangle className="h-10 w-10 text-red-300" />
            <p className="text-sm font-medium text-white">{t('control.videoCodecTitle')}</p>
            <p className="max-w-sm text-xs text-white/80">
              {t('control.videoCodecDesc', { codec: videoFatal })}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="border-white/20 bg-white/10 text-white hover:bg-white/20"
                onClick={() => setVideoFatal(null)}
              >
                {t('control.videoCodecDismiss')}
              </Button>
              <Button size="sm" variant="secondary" onClick={backToAutoCodec}>
                {t('control.videoCodecAuto')}
              </Button>
              <Button size="sm" variant="destructive" onClick={handleDisconnect}>
                {t('control.videoCodecDisconnect')}
              </Button>
            </div>
          </div>
        )}
        {connected && videoSteered && (
          <div className="absolute left-1/2 top-3 z-20 w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2 rounded-lg border border-sky-400/30 bg-sky-950/90 p-3 text-left shadow-lg">
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-white">{t('control.videoSteeredTitle')}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-white/80">
                  {t('control.videoSteeredDesc', { from: videoSteered.from, to: videoSteered.to })}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 border-white/20 bg-white/10 px-2 text-[11px] text-white hover:bg-white/20"
                    onClick={() => setVideoSteered(null)}
                  >
                    {t('control.videoCodecDismiss')}
                  </Button>
                  <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={backToAutoCodec}>
                    {t('control.videoCodecAuto')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* The card lives while the session does (not only while lines exist):
          clearing empties the entries but keeps recording — the journal
          itself disappears only on explicit exit (status back to idle). */}
      {controls.state.status !== 'idle' && (
        <Card className="shrink-0">
          <button
            type="button"
            onClick={() => setLogsOpen((v) => !v)}
            className="raw-focus flex w-full select-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <Terminal className="h-4 w-4" />
            {t('control.logs')}
            <span className="ms-auto flex items-center gap-2">
              <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {controls.state.logs.length}
              </span>
              {logsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>
          </button>
          {logsOpen && (
            <CardContent className="space-y-2 p-3 pt-1">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={logQuery}
                    onChange={(e) => setLogQuery(e.target.value)}
                    placeholder={t('control.logSearch')}
                    className="h-7 ps-7 text-[11px]"
                  />
                  {logQuery && (
                    <button
                      type="button"
                      onClick={() => setLogQuery('')}
                      className="raw-focus absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label={t('control.logClearSearch')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => controls.clearLogs()}
                  title={t('control.logClear')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {/* Levels + categories share one row to keep the block compact. */}
              <div className="flex flex-wrap items-center gap-1">
                <span className="me-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t('control.logLevels')}</span>
                {LOG_LEVELS.map((l) => {
                  const on = controls.logPrefs.levels.includes(l)
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => controls.toggleLogLevel(l)}
                      className={`${CHIP_BASE} ${on ? LOG_LEVEL_STYLE[l] : CHIP_OFF}`}
                    >
                      {t(`control.logLevel_${l}`)}
                    </button>
                  )
                })}
                <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
                <span className="me-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t('control.logCategories')}</span>
                {LOG_CATEGORIES.map((c) => {
                  const on = controls.logPrefs.categories.includes(c)
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => controls.toggleLogCategory(c)}
                      className={`${CHIP_BASE} ${on ? CHIP_CAT_ON : CHIP_OFF}`}
                    >
                      {t(`control.logCat_${c}`)}
                    </button>
                  )
                })}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {t('control.logShown', { shown: visibleLogs.length, total: controls.state.logs.length })}
              </div>
              <div className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-tight text-muted-foreground">
                {visibleLogs.map((e, i) => (
                  <p key={`${e.ts}-${i}`} className={e.marker ? 'font-medium text-foreground' : undefined}>
                    <span className="opacity-70">[{e.ts}]</span>{' '}
                    {!e.marker && e.level !== 'info' && (
                      <span className={`me-1 rounded-sm px-1 ${LOG_LEVEL_STYLE[e.level]}`}>{t(`control.logLevel_${e.level}`)}</span>
                    )}
                    {!e.marker && (
                      <span className="me-1 opacity-70">[{t(`control.logCat_${e.category}`)}]</span>
                    )}
                    {splitHighlight(e.message, logQuery).map((part, j) =>
                      part.hit ? (
                        <mark key={j} className="rounded-[2px] bg-yellow-200/70 px-px text-inherit dark:bg-yellow-400/30">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={j}>{part.text}</span>
                      ),
                    )}
                  </p>
                ))}
                {visibleLogs.length === 0 && (
                  <p>{controls.state.logs.length === 0 ? t('control.logEmpty') : t('control.logNoMatch')}</p>
                )}
              </div>
            </CardContent>
          )}
        </Card>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        {/* Auto width: fits content up to viewport gutters, centered. No
            fixed widths, no scrollbars — survives any language. */}
        <DialogContent className="w-[calc(100vw-2rem)] sm:w-fit sm:max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{t('control.passwordTitle')}</DialogTitle>
            <DialogDescription>
              {t('control.passwordDesc')}
              <span className="mt-1 block max-w-[70vw] break-all font-mono text-[11px] sm:max-w-xs">{peerId}</span>
            </DialogDescription>
          </DialogHeader>
          {!loadingInfo && !canConnect && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {t('control.noServerConfig')}
            </p>
          )}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="remote-password">{t('control.password')}</Label>
              <PasswordInput
                id="remote-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') startConnection()
                }}
              />
              <p className="text-xs text-muted-foreground">{t('control.passwordOptional')}</p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              {t('control.rememberPassword')}
            </label>
          </div>
          {/* Stacked full-width on mobile, split row on desktop. Buttons may
              wrap instead of overflowing; sm:space-x-0 kills the base space-x
              so it doesn't double up with gap-2. */}
          <DialogFooter className="flex-col items-stretch gap-2 sm:space-x-0 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="secondary" size="sm" className="w-full whitespace-normal sm:w-auto" onClick={requestAccess} disabled={!canConnect}>
              {t('control.requestAccess')}
            </Button>
            <div className="flex flex-col gap-2 min-[420px]:flex-row">
              <Button variant="outline" className="w-full whitespace-normal min-[420px]:w-auto" onClick={() => setDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button className="w-full whitespace-normal min-[420px]:w-auto" onClick={startConnection} disabled={!canConnect}>
                {t('control.connect')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={twoFactorPending !== null || reconnect2FA}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:w-fit sm:max-w-[calc(100vw-2rem)]" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('control.2faTitle')}</DialogTitle>
            <DialogDescription>
              {reconnect2FA
                ? t('control.2faReconnectDesc')
                : twoFactorPending === 'Wrong 2FA Code'
                  ? t('control.2faWrong')
                  : t('control.2faDesc')}
              <span className="mt-1 block max-w-[70vw] break-all font-mono text-[11px] sm:max-w-xs">{peerId}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="remote-2fa">{t('control.2faCode')}</Label>
              <Input
                id="remote-2fa"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, ''))}
                placeholder={t('control.2faPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit2FA()
                }}
              />
            </div>
          </div>
          <DialogFooter className="flex-col-reverse items-stretch gap-2 sm:space-x-0 sm:flex-row sm:justify-end">
            <Button variant="outline" className="w-full whitespace-normal sm:w-auto" onClick={cancel2FA}>
              {t('common.cancel')}
            </Button>
            <Button className="w-full whitespace-normal sm:w-auto" onClick={submit2FA} disabled={!twoFactorCode.trim()}>
              {reconnect2FA ? t('control.reconnect') : t('control.2faVerify')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ConnectionStats({
  stats,
  info,
  cursorPos,
  pinned,
  onTogglePin,
  onCollapse,
}: {
  stats: import('@/lib/rustdesk/session').SessionStats | null
  info: import('@/lib/rustdesk/session').RemotePeerInfo | null
  cursorPos: { x: number; y: number } | null
  pinned: boolean
  onTogglePin: () => void
  onCollapse: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
      <span title={t('control.statDown')}>
        ↓{' '}
        <span className="font-semibold text-foreground">
          {stats ? `${stats.downKbps.toLocaleString('ru-RU')} kb/s` : '—'}
        </span>
      </span>
      <span title={t('control.statUp')}>
        ↑{' '}
        <span className="font-semibold text-foreground">
          {stats ? `${stats.upKbps.toLocaleString('ru-RU')} kb/s` : '—'}
        </span>
      </span>
      <span title={t('control.statFps')}>
        FPS{' '}
        <span className="font-semibold text-foreground">{stats ? stats.fps : '—'}</span>
        {stats && stats.queueDrops > 0 && (
          <span className="text-amber-600 dark:text-amber-400" title={t('control.statQueue')}>
            {' '}(−{stats.queueDrops})
          </span>
        )}
      </span>
      <span title={t('control.statCodec')}>
        {t('control.codec')}{' '}
        <span className="font-semibold text-foreground">
          {stats && stats.codec ? stats.codec.toUpperCase() : '—'}
        </span>
      </span>
      <span title={t('control.statPing')}>
        {t('control.ping')}{' '}
        <span className="font-semibold text-foreground">
          {stats && stats.pingMs != null ? `${stats.pingMs} ms` : '—'}
        </span>
      </span>
      <span title={t('control.statDecode')}>
        {t('control.decode')}{' '}
        <span className="font-semibold text-foreground">
          {stats && stats.decodeMs != null ? `${stats.decodeMs} ms` : '—'}
        </span>
      </span>
      <span title={t('control.statPaint')}>
        {t('control.paint')}{' '}
        <span className="font-semibold text-foreground">
          {stats && stats.paintMs != null ? `${stats.paintMs} ms` : '—'}
        </span>
      </span>
      {stats && (stats.queueWaitMs != null || stats.keyErrors > 0 || stats.deltaErrors > 0) && (
        <span title={t('control.statStreamHealth')}>
          Q{' '}
          <span className="font-semibold text-foreground">
            {stats.queueWaitMs != null ? `${stats.queueWaitMs} ms` : '—'}
          </span>{' '}
          <span className="text-muted-foreground">
            E{stats.keyErrors + stats.deltaErrors > 0 ? ` ${stats.keyErrors}/${stats.deltaErrors}` : ''}
          </span>
        </span>
      )}
      {info && info.width > 0 && (
        <span>
          {info.width}×{info.height}
        </span>
      )}
      {info && info.displayCount > 1 && (
        <span title={t('control.display')}>
          {t('control.display')} {info.display + 1}/{info.displayCount}
        </span>
      )}
      <span title={t('control.statCursorPos')}>
        {t('control.pos')}:
        <span className="font-semibold text-foreground">
          {cursorPos ? `${cursorPos.x}, ${cursorPos.y}` : '—'}
        </span>
      </span>
      <div className="ms-auto flex items-center gap-1">
        <Button size="icon" variant="outline" onClick={onTogglePin} title={pinned ? t('control.statsPinned') : t('control.statsPin')} className="h-6 w-6">
          {pinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
        </Button>
        {!pinned && (
          <Button size="icon" variant="outline" onClick={onCollapse} title={t('control.statsCollapse')} className="h-6 w-6">
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const map: Record<string, { cls: string; text: string }> = {
    connected: { cls: 'bg-green-500/15 text-green-600 dark:text-green-400', text: t('control.statusConnected') },
    connecting: { cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', text: t('control.statusConnecting') },
    error: { cls: 'bg-red-500/15 text-red-600 dark:text-red-400', text: t('control.statusError') },
    disconnected: { cls: 'bg-muted text-muted-foreground', text: t('control.statusDisconnected') },
    idle: { cls: 'bg-muted text-muted-foreground', text: t('control.statusIdle') },
  }
  const item = map[status] ?? map.idle
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${item.cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {item.text}
    </span>
  )
}

function StatusArea(props: {
  loading: boolean
  status: string
  error: string | null
  canConnect: boolean
  approvalPending: boolean
  onCancel: () => void
  onRetry: () => void
  onReconnect: () => void
  reconnectAttempts: number
}) {
  const { t } = useTranslation()
  // Host-side verdicts in human words; unknown strings pass through verbatim
  // (and stay in the session journal for mapping later).
  const friendlyError = (msg: string | null): string => {
    if (!msg) return ''
    if (/closed manually by the peer/i.test(msg)) return t('control.dismissedByHost')
    if (/^offline$/i.test(msg.trim())) return t('control.hostOffline')
    return msg.replace(/^host closed:\s*/i, '')
  }
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {props.loading ? (
          <>
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="text-sm text-muted-foreground">{t('control.loadingServer')}</p>
          </>
        ) : props.status === 'connecting' ? (
          props.approvalPending ? (
            <>
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              <p className="text-sm font-medium">{t('control.approvalWaiting')}</p>
              <p className="text-sm text-muted-foreground">{t('control.approvalDesc')}</p>
              <Button size="sm" variant="outline" onClick={props.onCancel}>
                <X className="me-2 h-4 w-4" /> {t('common.cancel')}
              </Button>
            </>
          ) : (
            <>
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              <p className="text-sm text-muted-foreground">{t('control.connecting')}</p>
            </>
          )
        ) : props.status === 'error' ? (
          <>
            <AlertTriangle className="h-10 w-10 text-destructive" />
            <p className="text-sm font-medium text-destructive">{friendlyError(props.error)}</p>
            <Button size="sm" onClick={props.onRetry}>
              <RefreshCw className="me-2 h-4 w-4" /> {t('control.retry')}
            </Button>
          </>
        ) : (
          <>
            <ScreenShare className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('control.notConnected')}</p>
            {props.status === 'disconnected' && (
              <Button
                size="sm"
                variant="outline"
                onClick={props.onReconnect}
                disabled={!props.canConnect}
              >
                <RefreshCw className="me-2 h-4 w-4" /> {t('control.reconnect')}
                {props.reconnectAttempts > 0 ? ` (${props.reconnectAttempts}/5)` : ''}
              </Button>
            )}
            {!props.canConnect && <p className="text-xs text-muted-foreground">{t('control.noServerConfig')}</p>}
          </>
        )}
      </div>
    </div>
  )
}