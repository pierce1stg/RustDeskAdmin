import { useEffect, useRef, useState } from 'react'
import { decompress as zstdDecompress } from '@/lib/fzstd'
import { VideoFrameDecoder } from '@/lib/rustdesk/decoder'
import { buildKeyEvent, shouldForwardToHost } from '@/lib/rustdesk/keymap'
import type { RustdeskControls } from '@/lib/rustdesk/useRustdeskControl'

// event_type: 0=move, 1=down, 2=up, 3=wheel
const MOUSE_TYPE_DOWN = 1
const MOUSE_TYPE_UP = 2
const MOUSE_TYPE_WHEEL = 3
// browser button index -> RustDesk button bit
const BUTTON_MAP: Record<number, number> = { 0: 0x01, 1: 0x04, 2: 0x02 }
const MODIFIER_KEYS = ['ctrl', 'alt', 'shift', 'meta'] as const
// minimum finger travel (px) per wheel step during two-finger scroll
const SCROLL_STEP_PX = 36

function getMods(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): number[] {
  const mods: number[] = []
  for (const m of MODIFIER_KEYS) {
    if (m === 'ctrl' && e.ctrlKey) mods.push(4)
    else if (m === 'alt' && e.altKey) mods.push(1)
    else if (m === 'shift' && e.shiftKey) mods.push(29)
    else if (m === 'meta' && e.metaKey) mods.push(23)
  }
  return mods
}

function getModNames(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string[] {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (e.metaKey) mods.push('meta')
  return mods
}

// Fallback visual drawn while the host cursor bitmap has not arrived (yet), so
// the remote pointer position is still visible. Shape matches the decoded
// bitmap record (hot(0,0) = arrow tip at the top-left corner).
function makeArrow(): {
  draw: HTMLCanvasElement
  url: string
  w: number
  h: number
  hotx: number
  hoty: number
} {
  const draw = document.createElement('canvas')
  draw.width = 32
  draw.height = 32
  const g = draw.getContext('2d')
  if (g) {
    g.save()
    g.scale(0.5, 0.5)
    g.translate(1, 1)
    g.shadowColor = 'rgba(0,0,0,0.4)'
    g.shadowBlur = 3
    g.fillStyle = '#ffffff'
    g.strokeStyle = '#000000'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(2, 2)
    g.lineTo(2, 50)
    g.lineTo(9, 43)
    g.lineTo(16, 52)
    g.lineTo(25, 48)
    g.lineTo(17, 41)
    g.lineTo(45, 10)
    g.lineTo(49, 6)
    g.closePath()
    g.fill()
    g.stroke()
    g.restore()
  }
  return { draw, url: draw.toDataURL('image/png'), w: 32, h: 32, hotx: 0, hoty: 0 }
}

export type RenderScale =
  | 'auto'
  | 'original'
  | '144p'
  | '240p'
  | '360p'
  | '480p'
  | '720p'
  | '1080p'
  | '1440p'

// Set false to remove the capture indicator ring (functionality unchanged).
const SHOW_CAPTURE_RING = true

export function RemoteScreen({
  controls,
  paused,
  cursorEnabled,
  onPinchZoom,
  zoom,
  inputMode,
  onCursorPos,
  onVideoFatal,
  onCodecSteered,
  renderScale = 'auto',
  turbo = false,
}: {
  controls: RustdeskControls
  paused: boolean
  cursorEnabled: boolean
  onPinchZoom: (pct: number) => void
  zoom: { mode: 'fit' | 'original' | 'custom'; pct: number }
  inputMode: 'touch' | 'pointer'
  onCursorPos?: (x: number, y: number) => void
  onVideoFatal?: (codec: string) => void
  // Codec steering succeeded (host moved from -> to because the stream was
  // undecodable): the page shows an informational banner, not the fatal one.
  onCodecSteered?: (from: string, to: string) => void
  // Turbo (lowest-latency preset): tightens the decoder backlog watermark and
  // disables canvas smoothing (faster paint, crisper downscaled text).
  turbo?: boolean
  // Backing-store cap for the decoded picture. 'auto' keeps the current
  // behaviour (fit mode draws at on-screen size, zoom modes at full source
  // resolution); the caps downscale 1:1 detail but cut decode/paint cost on
  // weak machines (e.g. 4K host). CSS sizing is untouched.
  renderScale?: RenderScale
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const fitRafRef = useRef(0)
  const renderScaleRef = useRef<RenderScale>(renderScale)
  renderScaleRef.current = renderScale
  const turboRef = useRef(turbo)
  turboRef.current = turbo
  const decoderRef = useRef<VideoFrameDecoder | null>(null)
  // Input capture: keyboard goes to the host ONLY while the pointer is
  // inside the remote-screen zone. Cursor position and keyboard focus are
  // different things — without this, keystrokes land in whatever panel
  // control kept focus (e.g. a toolbar select keeps eating arrows).
  const [captured, setCapturedState] = useState(false)
  const capturedRef = useRef(false)
  const setCaptured = (v: boolean) => {
    capturedRef.current = v
    setCapturedState(v)
    // Capture lost while keys held (down inside, up outside): release them
    // on the host, otherwise they stick forever.
    if (!v) releaseHeldKeys()
  }
  // Keys pressed down while captured (code -> event snapshot for release).
  const heldKeysRef = useRef(
    new Map<string, { key: string; keyCode: number; code?: string; modifiers: string[]; platform?: string | null }>(),
  )
  const releaseHeldKeys = () => {
    const held = heldKeysRef.current
    if (held.size === 0) return
    for (const h of held.values()) {
      const body = buildKeyEvent({ down: false, key: h.key, keyCode: h.keyCode, code: h.code, modifiers: [], platform: h.platform })
      if (body) controlsRef.current.sendKeyEvent(body)
    }
    held.clear()
  }
  const onVideoFatalRef = useRef(onVideoFatal)
  onVideoFatalRef.current = onVideoFatal
  const onCodecSteeredRef = useRef(onCodecSteered)
  onCodecSteeredRef.current = onCodecSteered
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const fitRef = useRef<() => void>(() => {})
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const scrollRef = useRef({ active: false, lastY: 0, accumulator: 0 })
  const prevSizeKeyRef = useRef('')
  const scrollableRef = useRef(false)
  // Decode/paint telemetry for the connection panel (published at most every 250ms).
  const lastDecodeMsRef = useRef<number | null>(null)
  const lastPaintMsRef = useRef<number | null>(null)
  const paintSamplesRef = useRef<number[]>([])
  const lastPublishAtRef = useRef(0)
  // Backing-store size of the canvas. In fit mode we size it to the on-screen
  // (downscaled) dimensions instead of the source resolution — the browser
  // would resample during compositing anyway, and drawing/sampling a 4K frame
  // every 60fps is what chokes mid-range machines. In original/custom zoom the
  // full canvas is used so we keep pixel-perfect detail when zoomed in.
  const displaySizeRef = useRef({ w: 0, h: 0 })
  // Stream keep-alive: last frame arrival / keyframe request timestamps.
  const lastVideoAtRef = useRef(0)
  const lastKeyAtRef = useRef(0)
  // Read latest paused/zoom values from within the run-once input closure.
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const cursorEnabledRef = useRef(cursorEnabled)
  cursorEnabledRef.current = cursorEnabled
  // Decoded remote cursor bitmap + overlay handle (K1 div).
  const cursorBitmapRef = useRef<{
    draw: HTMLCanvasElement | HTMLImageElement
    url: string | null
    w: number
    h: number
    hotx: number
    hoty: number
  } | null>(null)
  const overlayDivRef = useRef<HTMLDivElement>(null)
  // Touch-host press cursor: a small circle for Android/iOS hosts (whose own
  // cursor is a finger, not an arrow). Shown only when the host sent no real
  // bitmap; flashes blue while our press is fresh.
  const touchCircleRef = useRef<HTMLDivElement>(null)
  const pressAtRef = useRef(0)
  // Fallback arrow + last layout/trigger handles shared with the run-once cursor effect.
  const arrowRef = useRef<ReturnType<typeof makeArrow> | null>(null)
  const layoutRef = useRef<() => void>(() => {})
  const onCursorPosRef = useRef(onCursorPos)
  onCursorPosRef.current = onCursorPos
  if (!arrowRef.current) arrowRef.current = makeArrow()
  const zoomPctRef = useRef(zoom.pct)
  zoomPctRef.current = zoom.pct
  const onPinchZoomRef = useRef(onPinchZoom)
  onPinchZoomRef.current = onPinchZoom
  // Touch long-press (→ right click) and two-finger pinch tracking.
  const longPressRef = useRef<{ timer: number | null; x: number; y: number; pointerId: number } | null>(null)
  const pinchRef = useRef({ active: false, startDist: 0, basePct: 0 })
  // Double-tap detection for pointer (trackpad) mode:
  //   - double-tap → double left-click
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null)
  // Two-finger TAP → right click (trackpad mode only). Active while exactly two
  // fingers are down; cancelled as soon as real scroll/pinch movement starts.
  const twoTapRef = useRef<{ t0: number } | null>(null)
  const dragRef = useRef<{ active: boolean; pointerId: number } | null>(null)
  // Input coalescing: pointermove fires at 60–240Hz but the screen paints at
  // most once per frame. Queue the latest position and flush it on rAF so each
  // frame sends at most one move message instead of a WS-send storm.
  const inputFlushRafRef = useRef(0)
  const pendingMoveRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const pendingRelRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 })
  const pendingWheelRef = useRef(0)
  // Last move coordinates actually sent — the host ignores coords on DOWN/UP
  // and clicks at the last MOVEd position, so re-sending an unchanged move
  // before DOWN/UP only doubles traffic for no effect.
  const lastSentMoveRef = useRef('')
  // "Pointer mode" (phone trackpad): one finger drags the remote cursor
  // relatively; a tap clicks at the current remote-cursor position.
  const inputModeRef = useRef(inputMode)
  inputModeRef.current = inputMode
  const pointerTrackerRef = useRef<{ id: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  // Absolute remote-cursor position (host CursorPosition) + the local dot that
  // renders it for touch trackpad mode.
  const remoteCursorRef = useRef<{ x: number; y: number } | null>(null)
  const echoAtRef = useRef(0)
  const dotRef = useRef<HTMLDivElement>(null)
  // Position *we* drive ourselves (mouse move / trackpad drag / tap). The host
  // excludes the acting client from CursorPosition echoes for ~300ms
  // (input_service.rs run_pos), so our own motion must render from this.
  const ownPosRef = useRef<{ x: number; y: number; t: number } | null>(null)
  // Last *effective* cursor position, persisted across own-move expiry. This is
  // the single source of truth for relative-drag accumulation and tap targets —
  // the raw host echo stays stale (the acting client is excluded from echoes),
  // so without a persistent base every new gesture after ~400ms of idle would
  // snap the cursor back to the initial (≈ center) position.
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null)

  const rw = controls.state.info?.width || 1920
  const rh = controls.state.info?.height || 1080

  // Video decoder + handler registration — run once per mount.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Opaque canvas skips per-paint alpha blending; desynchronized lowers
    // compositor latency. Video is always opaque, so nothing visual changes.
    ctxRef.current = canvas.getContext('2d', { alpha: false, desynchronized: true })

    // Resize-triggered refit, debounced to the next frame: calling fit()
    // synchronously inside the decode callback janks the render loop.
    const scheduleFit = () => {
      if (fitRafRef.current) return
      fitRafRef.current = window.requestAnimationFrame(() => {
        fitRafRef.current = 0
        fitRef.current()
      })
    }

    const decoder = new VideoFrameDecoder(
      (frame) => {
        const ctx = ctxRef.current
        if (!ctx) return
        lastVideoAtRef.current = performance.now()
        if (pausedRef.current) return
        const fw = frame.displayWidth
        const fh = frame.displayHeight
        const ds = displaySizeRef.current
        let dw = ds.w || fw
        let dh = ds.h || fh
        // Render-scale cap: decode/paint a downscaled backing store while the
        // CSS size stays the same (set by fit()). Only downscales, never up.
        // 'original' passes the host resolution through (what the device has).
        const scale = renderScaleRef.current
        if (scale === 'original') {
          dw = fw
          dh = fh
        } else if (scale !== 'auto' && fh > 0) {
          const m = /^(\d+)p$/.exec(scale)
          const capH = m ? parseInt(m[1], 10) : 0
          if (capH > 0 && fh > capH) {
            const k = capH / fh
            dw = Math.max(1, Math.round(fw * k))
            dh = capH
          } else {
            dw = fw
            dh = fh
          }
        }
        if (canvas.width !== dw || canvas.height !== dh) {
          canvas.width = dw
          canvas.height = dh
          scheduleFit()
        }
        const t0 = performance.now()
        if (ctx.imageSmoothingEnabled === turboRef.current) {
          // Turbo disables smoothing (faster + crisper); normal keeps it.
          ctx.imageSmoothingEnabled = !turboRef.current
        }
        // Deterministic downscale quality instead of the engine default.
        const wantQuality: ImageSmoothingQuality = turboRef.current ? 'low' : 'medium'
        if (ctx.imageSmoothingQuality !== wantQuality) ctx.imageSmoothingQuality = wantQuality
        ctx.drawImage(frame, 0, 0, dw, dh)
        const paint = performance.now() - t0
        const samples = paintSamplesRef.current
        samples.push(paint)
        if (samples.length > 40) samples.shift()
        lastPaintMsRef.current = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10
        const now = performance.now()
        if (now - lastPublishAtRef.current > 250) {
          lastPublishAtRef.current = now
          controlsRef.current.publishVideoStats({
            decodeMs: lastDecodeMsRef.current,
            paintMs: lastPaintMsRef.current,
          })
        }
      },
      (stats) => {
        lastDecodeMsRef.current = stats.decodeTimeMs
        controlsRef.current.publishVideoStats({
          renderFps: stats.fps,
          queueDrops: stats.queueDrops,
          queueWaitMs: stats.queueWaitMs,
          keyErrors: stats.keyErrors,
          deltaErrors: stats.deltaErrors,
        })
      },
      () => controlsRef.current.requestKeyframe(),
      // Frame-level fatal: in auto mode try the next codec first (bounded
      // chain inside negotiateDecoderFallback); in manual mode or when
      // exhausted, surface the warning banner instead.
      (codec) => {
        const switched = controlsRef.current.negotiateDecoderFallback?.(codec) ?? null
        if (switched) decoderRef.current?.reset()
        else onVideoFatalRef.current?.(codec)
      },
      (codec) => {
        // The engine can't decode this codec: ask the session to
        // switch the host's encoder, then reset the decoder so the next codec's
        // packets start clean. If no codec is left, show the fatal banner.
        const switched = controlsRef.current.negotiateDecoderFallback?.(codec) ?? null
        if (switched) decoderRef.current?.reset()
        else onVideoFatalRef.current?.(codec)
      },
      (codec) => {
        // The stream itself is undecodable (keyframes rejected, zero output).
        // In auto mode the session steers the host to another encoder and the
        // page shows an informational banner; a manual pin shows the fatal
        // banner instead (manual choices are literal, no silent switches).
        const target = controlsRef.current.negotiateDecoderFallback?.(codec) ?? null
        if (target) {
          decoderRef.current?.reset()
          controlsRef.current.publishLog(`codec steering ${codec} -> ${target}`, 'codec')
          onCodecSteeredRef.current?.(codec, target)
        } else onVideoFatalRef.current?.(codec)
      },
      // Freshly configured decoder accepts only a key chunk next: ask once,
      // unthrottled, so a delta-first stream doesn't idle until the stall
      // watchdog. Bounded — one request per configure, never per packet.
      () => controlsRef.current.requestKeyframeNow(),
      // Decoder truth (not wire truth): which codec the engine actually
      // configured. Debug level — the stats badge already shows the wire fact.
      (codec) => controlsRef.current.publishLog(`decoder picked ${codec}`, 'decoder', 'debug'),
    )
    decoderRef.current = decoder
    controlsRef.current.registerVideo((packet) => {
      // While paused we don't decode at all: the picture is frozen and the
      // decode queue would only keep building up. A keyframe is requested on
      // resume. The 2s liveness pings keep the relay session alive.
      if (pausedRef.current) return
      decoder.handlePacket(packet)
    })

    return () => {
      releaseHeldKeys()
      if (fitRafRef.current) {
        window.cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = 0
      }
      ctxRef.current = null
      decoder.close()
      decoderRef.current = null
    }
  }, [])

  // Turbo toggles the decoder backlog watermark live (4 normal, 2 turbo).
  useEffect(() => {
    decoderRef.current?.setBacklogLimit(turbo ? 2 : 4)
  }, [turbo])

  // Reset the decoder whenever we switch to a display with a different
  // resolution — otherwise the stale decode session renders a mosaic.
  const sizeKey = `${rw}x${rh}`
  useEffect(() => {
    if (prevSizeKeyRef.current !== '' && prevSizeKeyRef.current !== sizeKey) {
      decoderRef.current?.reset()
      controlsRef.current.requestKeyframeNow()
    }
    prevSizeKeyRef.current = sizeKey
  }, [sizeKey])

  // Resume from pause: ask the host for a fresh keyframe so the picture snaps
  // back instantly instead of waiting for the next delta.
  useEffect(() => {
    if (!paused) {
      lastKeyAtRef.current = Date.now()
      controlsRef.current.requestKeyframe()
    } else {
      // Pausing drops key-ups: release held keys so none stick on the host.
      releaseHeldKeys()
    }
  }, [paused])

  // Keep the stream alive: once no video frame has arrived for a while, the
  // picture would otherwise freeze (static remote screen / cursor outside the
  // canvas — the host skips frames when nothing changes). Nudge it with a
  // keyframe request so the image constantly refreshes.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (pausedRef.current) return
      const now = Date.now()
      if (now - lastVideoAtRef.current < 3000) return
      if (now - lastKeyAtRef.current < 3000) return
      lastKeyAtRef.current = now
      controlsRef.current.requestKeyframe()
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

// Remote cursor — single overlay: an absolutely-positioned <div> carrying the
// decoded host cursor bitmap (or a fallback arrow until the bitmap arrives),
// placed through the same transforms as the video canvas. Position comes from
// the host CursorPosition echo, or from the pointer we drive ourselves while
// the host suppresses echoes to the acting client.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let appliedLogged = false
    let posLogged = false
    let lastPosLogAt = 0
    let lastPngUrl: string | null = null

    const layout = () => {
      const cvs = canvasRef.current
      if (!cvs) return
      const info = controlsRef.current.state.info
      const rw = info?.width
      const rh = info?.height
      if (!rw || !rh) return
      const rect = cvs.getBoundingClientRect()
      const crect = (containerRef.current ?? cvs).getBoundingClientRect()
      const ox = info?.originX ?? 0
      const oy = info?.originY ?? 0
      const sx = rect.width / rw
      const sy = rect.height / rh
      const offX = rect.left - crect.left
      const offY = rect.top - crect.top
      // Real host bitmap if we have it, otherwise a simple local arrow fallback
      // so the remote pointer is visible even while the bitmap is pending.
      // Touch hosts (Android/iOS) have no arrow cursor of their own: when they
      // sent no bitmap either, render a small circle instead of the arrow
      // mush — a dedicated div positioned below.
      const isTouchHost = /android|ios|ipad|iphone/i.test(info?.platform ?? '')
      const visual = cursorBitmapRef.current ?? (isTouchHost ? null : arrowRef.current)
      // Find the freshest known cursor position. We render our own-driven motion
      // while it is fresh (the acting client gets no CursorPosition echo from
      // the host during/after its own input), otherwise a fresh host echo, and
      // finally the persisted last-known position so idle cursors don't jump.
      const now = Date.now()
      const own = ownPosRef.current
      const echo = remoteCursorRef.current
      let eff: { x: number; y: number } | null = null
      if (own && now - own.t < 400) {
        eff = { x: own.x, y: own.y }
      } else if (echo && now - echoAtRef.current < 1500) {
        eff = { x: echo.x, y: echo.y }
      } else {
        eff = cursorPosRef.current
      }
      const pos = eff

      if (visual && pos) {
        const cx = offX + (pos.x - ox) * sx
        const cy = offY + (pos.y - oy) * sy
        const dw = visual.w * sx
        const dh = visual.h * sy
        const hx = visual.hotx * sx
        const hy = visual.hoty * sy
        const dot = dotRef.current
        if (dot) dot.style.transform = `translate(${cx}px, ${cy}px)`
        if (visual.url) {
          const d = overlayDivRef.current
          if (d) {
            d.style.display = 'block'
            d.style.backgroundImage = `url("${visual.url}")`
            d.style.backgroundSize = '100% 100%'
            d.style.backgroundRepeat = 'no-repeat'
            d.style.width = `${dw}px`
            d.style.height = `${dh}px`
            d.style.transform = `translate(${cx - hx}px, ${cy - hy}px)`
          }
        }
        onCursorPosRef.current?.(pos.x, pos.y)
      } else if (overlayDivRef.current) {
        overlayDivRef.current.style.display = 'none'
      }

      // Touch-host press circle: same position, centered 20px ring. Theme
      // primary glow for ~350ms after our own press so taps read clearly.
      const circle = touchCircleRef.current
      if (circle) {
        const showCircle = isTouchHost && !cursorBitmapRef.current && !!pos && cursorEnabledRef.current
        circle.style.display = showCircle ? 'block' : 'none'
        if (showCircle && pos) {
          const cx = offX + (pos.x - ox) * sx
          const cy = offY + (pos.y - oy) * sy
          const pressed = Date.now() - pressAtRef.current < 350
          circle.style.transform = `translate(${cx - 10}px, ${cy - 10}px)`
          circle.style.borderColor = pressed ? 'hsl(var(--primary))' : 'rgba(255,255,255,0.9)'
          circle.style.background = pressed ? 'hsl(var(--primary) / 0.30)' : 'transparent'
          circle.style.boxShadow = pressed
            ? '0 0 0 3px hsl(var(--primary) / 0.45), 0 0 10px hsl(var(--primary) / 0.8)'
            : '0 0 0 2px rgba(0,0,0,0.45)'
        }
      }

      // Only hide the local pointer when we actually render something on top
      // (i.e. a fresh position exists that the overlay can be drawn at).
      const rendering = cursorEnabledRef.current && !!pos
      cvs.style.cursor = rendering ? 'none' : ''
    }
    layoutRef.current = layout

    const decodeCursor = (c: import('@/lib/rustdesk/proto').ParsedCursor) => {
      try {
        const { hotx, hoty, width, height, colors } = c
        if (width <= 0 || height <= 0) return
        const png = colors.length > 8 && colors[0] === 0x89 && colors[1] === 0x50
        const zstd = colors.length > 4 && colors[0] === 0x28 && colors[1] === 0xb5 && colors[2] === 0x2f && colors[3] === 0xfd
        controlsRef.current.publishLog(`cursor_data in: ${colors.length} bytes, ${width}x${height}, png=${png} zstd=${zstd}`, 'cursor')
        const finish = (draw: HTMLCanvasElement | HTMLImageElement, url: string | null) => {
          if (lastPngUrl && lastPngUrl !== url) URL.revokeObjectURL(lastPngUrl)
          if (url && url.startsWith('blob:')) lastPngUrl = url
          cursorBitmapRef.current = { draw, url, w: width, h: height, hotx, hoty }
          layout()
          if (!appliedLogged) {
            appliedLogged = true
            controlsRef.current.publishLog('remote cursor applied', 'cursor')
          }
        }
        if (png) {
          const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(colors)], { type: 'image/png' }))
          const im = new Image()
          im.onload = () => finish(im, blobUrl)
          im.onerror = () => URL.revokeObjectURL(blobUrl)
          im.src = blobUrl
          return
        }
        let buf: Uint8Array = colors
        if (zstd) {
          try {
            buf = zstdDecompress(colors)
          } catch {
            return
          }
        }
        if (buf.length !== width * height * 4) {
          controlsRef.current.publishLog(`cursor_data size mismatch: ${buf.length} != ${width * height * 4}`, 'cursor', 'warn')
          return
        }
        const rgba = new Uint8ClampedArray(width * height * 4)
        for (let i = 0; i < width * height; i++) {
          // host bytes are BGRA
          rgba[i * 4] = buf[i * 4 + 2]
          rgba[i * 4 + 1] = buf[i * 4 + 1]
          rgba[i * 4 + 2] = buf[i * 4]
          rgba[i * 4 + 3] = buf[i * 4 + 3]
        }
        const off = document.createElement('canvas')
        off.width = width
        off.height = height
        const octx = off.getContext('2d')
        if (!octx) return
        octx.putImageData(new ImageData(rgba, width, height), 0, 0)
        finish(off, off.toDataURL('image/png'))
      } catch {
        // malformed cursor payload — keep overlays hidden
      }
    }

    // Always decode incoming bitmaps (even while the cursor is toggled off) so
    // the cache is warm the moment the user switches the cursor on.
    controlsRef.current.registerCursor((c) => {
      decodeCursor(c)
    })

    const onPos = (x: number, y: number) => {
      remoteCursorRef.current = { x, y }
      echoAtRef.current = Date.now()
      // Keep the persisted base in sync with an external echo (e.g. the host
      // repositioning) so relative gestures continue from the real location.
      cursorPosRef.current = { x, y }
      const now = Date.now()
      if (!posLogged) {
        posLogged = true
        controlsRef.current.publishLog(`cursor_position received: ${x}, ${y}`, 'cursor')
      } else if (now - lastPosLogAt > 5000) {
        lastPosLogAt = now
        controlsRef.current.publishLog(`cursor_position: ${x}, ${y}`, 'cursor')
      }
      layout()
    }
    controlsRef.current.registerCursorPosition(onPos)

    const onResize = () => {
      if (!cursorEnabledRef.current) return
      layout()
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // Cursor toggle affects rendering only (subscription is always active from
  // connect). Restore the plain local arrow here; layout() hides it only when
  // a remote cursor is actually being drawn.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) canvas.style.cursor = ''
    if (cursorEnabled) layoutRef.current()
  }, [cursorEnabled])

  // Audio playback — only live while the user has enabled sound (default off).
  // Audio was removed from the web client: nothing registers audio handlers,
  // so hosts (told disable_audio=Yes at login) never stream sound.

  // Canvas sizing — fit the remote video into the visible area (keeping aspect
  // ratio) or render it at original/custom scale with scrollbars as needed.
  useEffect(() => {
    const scaleFor = (cw: number, ch: number, w: number, h: number): number => {
      if (zoom.mode === 'original') return 1
      if (zoom.mode === 'custom') return zoom.pct / 100
      return Math.min(cw / w, ch / h)
    }

    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const fit = () => {
      // Only the content box is usable: clientWidth/Height include the padding,
      // so sizing against them pushes the canvas out of the block and summons
      // scrollbars even in "Auto" mode.
      const cs = getComputedStyle(container)
      const cw =
        container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
      const ch =
        container.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)
      const w = rw
      const h = rh
      if (!cw || !ch || !w || !h) return
      const scale = scaleFor(cw, ch, w, h)
      let dw = Math.round(Math.max(1, w * scale))
      let dh = Math.round(Math.max(1, h * scale))
      if (zoom.mode === 'fit') {
        // Never exceed the content box in fit mode: even a 1px overflow would
        // draw a scrollbar (including in fullscreen).
        dw = Math.min(dw, Math.floor(cw))
        dh = Math.min(dh, Math.floor(ch))
        // Downscale the backing store to the on-screen size so we don't draw
        // (and resample) the full source resolution on every frame.
        displaySizeRef.current = { w: dw, h: dh }
      } else {
        // original/custom zoom — keep the full source resolution for detail.
        displaySizeRef.current = { w: w, h: h }
      }
      canvas.style.width = `${dw}px`
      canvas.style.height = `${dh}px`
      const isScrollable = dw > cw || dh > ch
      scrollableRef.current = isScrollable
    }
    fitRef.current = fit
    fit()
    window.addEventListener('resize', fit)
    const ro = new ResizeObserver(fit)
    ro.observe(container)
    return () => {
      window.removeEventListener('resize', fit)
      ro.disconnect()
    }
  }, [rw, rh, zoom.mode, zoom.pct])

  // Input routing — native listeners, run once on mount. Pointer Events unify
  // mouse/touch/pen; two simultaneous touch pointers become a vertical scroll.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const toCoords = (clientX: number, clientY: number) => {
      const info = controlsRef.current.state.info
      const w = info?.width || 0
      const h = info?.height || 0
      if (!w || !h) return { x: 0, y: 0 }
      const rect = canvas.getBoundingClientRect()
      return {
        x: Math.round(((clientX - rect.left) * w) / rect.width) + (info?.originX ?? 0),
        y: Math.round(((clientY - rect.top) * h) / rect.height) + (info?.originY ?? 0),
      }
    }

    const sendWheel = (deltaY: number) => {
      // Browser deltaY positive = scroll down; RustDesk y positive = scroll up.
      const step = deltaY > 0 ? -1 : 1
      controlsRef.current.sendMouse(0, step, MOUSE_TYPE_WHEEL)
    }

    // Clamp host-space coordinates to the current display's virtual bounds.
    // Coordinates are absolute in the virtual desktop (the host applies
    // MouseEvent.x/y directly via mouse_move_to), and a display at a non-zero
    // origin spans [originX, originX+width]×[originY, originY+height].
    const clampToDisplay = (x: number, y: number) => {
      const info = controlsRef.current.state.info
      const w = info?.width || 0
      const h = info?.height || 0
      if (!w || !h) return { x, y }
      const ox = info?.originX ?? 0
      const oy = info?.originY ?? 0
      return {
        x: Math.max(ox, Math.min(ox + w, x)),
        y: Math.max(oy, Math.min(oy + h, y)),
      }
    }

    // Record host-space coords as OUR current remote-cursor position and re-run
    // layout immediately. Required because the host suppresses CursorPosition
    // echoes to the acting client for ~300ms (input_service.rs `run_pos`), so a
    // web client that only renders from echoes would never see its own cursor.
    const setOwn = (x: number, y: number) => {
      const clamped = clampToDisplay(x, y)
      ownPosRef.current = { x: clamped.x, y: clamped.y, t: Date.now() }
      cursorPosRef.current = clamped
      layoutRef.current()
    }
    // Freshest known cursor position: our own motion first, then the persisted
    // last-known position, and finally whatever the host echoed. The persisted
    // base is key: the host stops echoing to the acting client, so after ~400ms
    // of idle the raw echo alone would be stale (≈ its initial center position)
    // and every new gesture would fly the cursor back toward that point.
    const getRC = () => {
      const now = Date.now()
      const own = ownPosRef.current
      if (own && now - own.t < 400) return { x: own.x, y: own.y }
      if (cursorPosRef.current) return { x: cursorPosRef.current.x, y: cursorPosRef.current.y }
      return remoteCursorRef.current
    }

    // Flush queued input at most once per animation frame: one absolute move
    // (deduped), one accumulated relative move, and a bounded burst of wheel
    // steps. Wheel remainder stays queued for the next frame, so fast scrolls
    // keep their full distance without one WS message per input event.
    const MAX_WHEEL_PER_FLUSH = 8
    const flushInput = () => {
      inputFlushRafRef.current = 0
      const mv = pendingMoveRef.current
      pendingMoveRef.current = null
      if (mv) {
        const { x, y } = toCoords(mv.clientX, mv.clientY)
        sendMoveDedup(x, y)
      }
      const rel = pendingRelRef.current
      if (rel.dx !== 0 || rel.dy !== 0) {
        pendingRelRef.current = { dx: 0, dy: 0 }
        const info = controlsRef.current.state.info
        const w = info?.width || 0
        const h = info?.height || 0
        const rect = canvas.getBoundingClientRect()
        if (w > 0 && h > 0 && rect.width && rect.height) {
          const rdx = (rel.dx * w) / rect.width
          const rdy = (rel.dy * h) / rect.height
          controlsRef.current.sendMouseRelative(rdx, rdy)
          const self = getRC() ?? {
            x: (info?.originX ?? 0) + w / 2,
            y: (info?.originY ?? 0) + h / 2,
          }
          setOwn(self.x + rdx, self.y + rdy)
        }
      }
      const steps = pendingWheelRef.current
      if (steps !== 0) {
        const dir = steps > 0 ? 1 : -1
        const n = Math.min(Math.abs(steps), MAX_WHEEL_PER_FLUSH)
        for (let i = 0; i < n; i++) sendWheel(dir)
        pendingWheelRef.current = steps - dir * n
        if (pendingWheelRef.current !== 0) scheduleInputFlush()
      }
    }
    const scheduleInputFlush = () => {
      if (inputFlushRafRef.current) return
      inputFlushRafRef.current = window.requestAnimationFrame(flushInput)
    }
    // Absolute move with dedup: identical repeats (e.g. the explicit move
    // before DOWN/UP) still update the local cursor but skip the redundant
    // send — the host clicks at the last MOVEd position anyway.
    const sendMoveDedup = (x: number, y: number) => {
      const key = `${x},${y}`
      if (key !== lastSentMoveRef.current) {
        lastSentMoveRef.current = key
        controlsRef.current.sendMouse(x, y, 0)
      }
      setOwn(x, y)
    }

    // Panel focus guard lives in keymap.isPanelInputTarget (unit-tested);
    // shouldForwardToHost() applies it together with the capture zone.

    // True pause: while paused nothing goes to the host — no moves, clicks,
    // wheel, keys, or cursor. Only the ping/video_received keepalive (sent by
    // the session on its own timer) keeps the relay session alive.
    const isPaused = () => pausedRef.current

    const onPointerDown = (e: PointerEvent) => {
      if (isPaused()) return
      // Backup focus path (touch/pen may not fire pointerenter first).
      try {
        canvasRef.current?.focus({ preventScroll: true })
      } catch {
        // ignore
      }
      pressAtRef.current = Date.now()
      // Re-run layout after the press glow expires so the circle fades back
      // even without further motion.
      window.setTimeout(() => layoutRef.current(), 400)
      e.preventDefault()
      const pointers = pointersRef.current
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // pointer already released
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pointers.size >= 2) {
        // Second finger down → switch to scroll/pinch mode (release primary).
        // Cancel any pending long-press/grab of the primary finger first.
        const lp = longPressRef.current
        if (lp) {
          if (lp.timer) window.clearTimeout(lp.timer)
          longPressRef.current = null
        }
        // Watch for a quick two-finger TAP (→ right click in trackpad mode);
        // cancelled as soon as real scroll/pinch movement kicks in.
        if (inputModeRef.current === 'pointer' && e.pointerType === 'touch') {
          twoTapRef.current = { t0: Date.now() }
        }
        const pts = [...pointers.values()]
        const dy = pts[0].y - pts[1].y
        const dx = pts[0].x - pts[1].x
        pinchRef.current = {
          active: false,
          startDist: Math.hypot(dx, dy),
          basePct: zoomPctRef.current || 100,
        }
        const ys: number[] = []
        pointers.forEach((p) => ys.push(p.y))
        scrollRef.current.active = true
        scrollRef.current.lastY = Math.min(...ys)
        scrollRef.current.accumulator = 0
        controlsRef.current.sendMouse(0, 0, MOUSE_TYPE_UP)
        return
      }

      // First touch: handle pointer-mode gestures and schedule long-press.
      if (e.pointerType === 'touch') {
        const px = e.clientX
        const py = e.clientY

        if (inputModeRef.current === 'pointer') {
          pointerTrackerRef.current = { id: e.pointerId, lastX: px, lastY: py, moved: false }

          // Long-press → grab & drag (move a window/file): left button goes
          // DOWN after 600 ms of holding still, finger movement then drags,
          // lifting releases (drops) the item.
          longPressRef.current = {
            timer: window.setTimeout(() => {
              const lp = longPressRef.current
              if (!lp) return
              lp.timer = null
              const rc = getRC() ?? toCoords(lp.x, lp.y)
              sendMoveDedup(rc.x, rc.y)
              controlsRef.current.sendMouse(rc.x, rc.y, (0x01 << 3) | MOUSE_TYPE_DOWN)
              dragRef.current = { active: true, pointerId: lp.pointerId }
              if (pointerTrackerRef.current?.id === lp.pointerId) pointerTrackerRef.current.moved = true
            }, 600),
            x: px,
            y: py,
            pointerId: e.pointerId,
          }
          return
        }

        // Touch mode (direct): long-press → right click.
        longPressRef.current = {
          timer: window.setTimeout(() => {
            const lp = longPressRef.current
            if (!lp) return
            lp.timer = null
            const { x, y } = toCoords(lp.x, lp.y)
            sendMoveDedup(x, y)
            controlsRef.current.sendMouse(x, y, (0x02 << 3) | MOUSE_TYPE_DOWN)
            controlsRef.current.sendMouse(x, y, (0x02 << 3) | MOUSE_TYPE_UP)
            if (pointerTrackerRef.current?.id === lp.pointerId) pointerTrackerRef.current.moved = true
          }, 600),
          x: px,
          y: py,
          pointerId: e.pointerId,
        }
      }

      // Pointer mode: the finger controls the cursor relatively, no click yet.
      if (inputModeRef.current === 'pointer' && e.pointerType === 'touch') return

      const { x, y } = toCoords(e.clientX, e.clientY)
      const btn = BUTTON_MAP[e.button] ?? 0x01
      // The host ignores coordinates on DOWN/UP and clicks at the last MOVEd
      // position, so move explicitly first (touch taps may have no move yet).
      // Deduped: repeats of the last sent position skip the extra send.
      sendMoveDedup(x, y)
      controlsRef.current.sendMouse(x, y, (btn << 3) | MOUSE_TYPE_DOWN, getMods(e))
      setOwn(x, y)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (isPaused()) return
      const pointers = pointersRef.current
      const prev = pointers.get(e.pointerId)
      if (prev) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      // Cancel a pending long-press as soon as the finger actually moves.
      const lp = longPressRef.current
      if (lp && lp.pointerId === e.pointerId && lp.timer) {
        const ddx = e.clientX - lp.x
        const ddy = e.clientY - lp.y
        if (ddx * ddx + ddy * ddy > 144) {
          window.clearTimeout(lp.timer)
          longPressRef.current = null
        }
      }

      // Active drag (long-press grab started): move the cursor while the
      // left button stays held. Queued — flushed once per frame.
      const drag = dragRef.current
      if (drag && drag.pointerId === e.pointerId) {
        const info = controlsRef.current.state.info
        const w = info?.width || 0
        const h = info?.height || 0
        if (w > 0 && h > 0) {
          pendingMoveRef.current = { clientX: e.clientX, clientY: e.clientY }
          scheduleInputFlush()
        }
        return
      }

      if (scrollRef.current.active) {
        const pts = [...pointers.values()]
        if (pts.length >= 2) {
          // Two fingers: pinch changes the zoom, stable spread scrolls.
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
          const pc = pinchRef.current
          if (!pc.active) {
            pc.active = true
            pc.startDist = dist || pc.startDist
          } else {
            const ratio = dist / pc.startDist
            if (Math.abs(ratio - 1) > 0.05) {
              const target = Math.min(400, Math.max(25, Math.round(pc.basePct * ratio)))
              if (target !== zoomPctRef.current) {
                // Real pinch → definitely not a two-finger tap.
                twoTapRef.current = null
                onPinchZoomRef.current(target)
              }
              return
            }
          }
        }
        const ys: number[] = []
        pointers.forEach((p) => ys.push(p.y))
        if (ys.length === 0) return
        const minY = Math.min(...ys)
        const dy = minY - scrollRef.current.lastY
        scrollRef.current.lastY = minY
        scrollRef.current.accumulator += dy
        let steps = Math.trunc(scrollRef.current.accumulator / SCROLL_STEP_PX)
        if (steps !== 0) {
          // Actual scroll movement → definitely not a two-finger tap.
          twoTapRef.current = null
        }
        while (steps > 0) {
          pendingWheelRef.current += 1
          steps--
          scrollRef.current.accumulator -= SCROLL_STEP_PX
        }
        while (steps < 0) {
          pendingWheelRef.current -= 1
          steps++
          scrollRef.current.accumulator += SCROLL_STEP_PX
        }
        if (pendingWheelRef.current !== 0) scheduleInputFlush()
        return
      }

      // Pointer mode: a finger drag moves the remote cursor relatively.
      // Deltas accumulate and flush once per frame as a single message.
      if (inputModeRef.current === 'pointer' && e.pointerType === 'touch') {
        const t = pointerTrackerRef.current
        if (t && t.id === e.pointerId) {
          const dx = e.clientX - t.lastX
          const dy = e.clientY - t.lastY
          t.lastX = e.clientX
          t.lastY = e.clientY
          if (dx !== 0 || dy !== 0) {
            pendingRelRef.current.dx += dx
            pendingRelRef.current.dy += dy
            scheduleInputFlush()
          }
          if (dx * dx + dy * dy > 100) t.moved = true
        }
        return
      }

      if ((e.pointerType === 'mouse' || (e.buttons & 1) !== 0) && !(inputModeRef.current === 'pointer' && e.pointerType === 'touch')) {
        // Coalesce the OS-provided motion events and queue only the latest —
        // one send per frame instead of one per input event.
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null
        const last = evs && evs.length > 0 ? evs[evs.length - 1] : e
        pendingMoveRef.current = { clientX: last.clientX, clientY: last.clientY }
        scheduleInputFlush()
      }
    }

    const onPointerEnd = (e: PointerEvent) => {
      if (isPaused()) return
      const pointers = pointersRef.current
      const wasPresent = pointers.delete(e.pointerId)
      if (!wasPresent) return

      // Cancel any pending long-press for this finger.
      const lp = longPressRef.current
      if (lp && lp.pointerId === e.pointerId) {
        if (lp.timer) window.clearTimeout(lp.timer)
        longPressRef.current = null
      }

      if (scrollRef.current.active) {
        if (pointers.size >= 2) return
        scrollRef.current.active = false
        scrollRef.current.accumulator = 0
        pinchRef.current.active = false
        if (pointers.size === 1) {
          const ids = [...pointers.keys()]
          const p = [...pointers.values()][0]
          if (inputModeRef.current === 'pointer') {
            // A quick, unmoved two-finger tap (trackpad mode) → right click at
            // the current remote-cursor position. Real scroll/pinch cancelled
            // twoTapRef in onPointerMove.
            const twoTap = twoTapRef.current
            twoTapRef.current = null
            if (twoTap && e.pointerType === 'touch' && Date.now() - twoTap.t0 < 300) {
              const rc = getRC() ?? toCoords(p.x, p.y)
              sendMoveDedup(rc.x, rc.y)
              controlsRef.current.sendMouse(rc.x, rc.y, (0x02 << 3) | MOUSE_TYPE_DOWN)
              controlsRef.current.sendMouse(rc.x, rc.y, (0x02 << 3) | MOUSE_TYPE_UP)
              setOwn(rc.x, rc.y)
              pointerTrackerRef.current = { id: ids[0] ?? -1, lastX: p.x, lastY: p.y, moved: true }
              return
            }
            pointerTrackerRef.current = { id: ids[0] ?? -1, lastX: p.x, lastY: p.y, moved: true }
          } else {
            const { x, y } = toCoords(p.x, p.y)
            sendMoveDedup(x, y)
            controlsRef.current.sendMouse(x, y, (0x01 << 3) | MOUSE_TYPE_DOWN)
          }
        }
        return
      }

      if (e.pointerType === 'mouse') {
        const { x, y } = toCoords(e.clientX, e.clientY)
        const btn = BUTTON_MAP[e.button] ?? 0x01
        controlsRef.current.sendMouse(x, y, (btn << 3) | MOUSE_TYPE_UP, getMods(e))
      } else if (pointers.size === 0) {
        const isPointerMode = inputModeRef.current === 'pointer'
        const t = pointerTrackerRef.current

        // Long-press grab: release the held left button (drop the item).
        const drag = dragRef.current
        if (isPointerMode && drag && drag.pointerId === e.pointerId) {
          dragRef.current = null
          const rc = getRC() ?? toCoords(e.clientX, e.clientY)
          controlsRef.current.sendMouse(rc.x, rc.y, (0x01 << 3) | MOUSE_TYPE_UP)
          setOwn(rc.x, rc.y)
          return
        }

        if (isPointerMode) {
          // Pointer mode: a tap clicks at the remote-cursor position (the down
          // was never sent on pointerdown in this mode); a quick second tap in
          // the same spot becomes a double left-click.
          pointerTrackerRef.current = null
          if (t && t.id === e.pointerId && !t.moved) {
            const rc = getRC() ?? toCoords(e.clientX, e.clientY)
            const now = Date.now()
            const prevTap = lastTapRef.current
            const isDouble =
              !!prevTap &&
              now - prevTap.at < 320 &&
              Math.hypot(e.clientX - prevTap.x, e.clientY - prevTap.y) < 50
            lastTapRef.current = isDouble ? null : { at: now, x: e.clientX, y: e.clientY }
            sendMoveDedup(rc.x, rc.y)
            controlsRef.current.sendMouse(rc.x, rc.y, (0x01 << 3) | MOUSE_TYPE_DOWN, getMods(e))
            controlsRef.current.sendMouse(rc.x, rc.y, (0x01 << 3) | MOUSE_TYPE_UP, getMods(e))
            if (isDouble) {
              controlsRef.current.sendMouse(rc.x, rc.y, (0x01 << 3) | MOUSE_TYPE_DOWN, getMods(e))
              controlsRef.current.sendMouse(rc.x, rc.y, (0x01 << 3) | MOUSE_TYPE_UP, getMods(e))
            }
            setOwn(rc.x, rc.y)
          }
        } else {
          // Touch tap: release the primary button (the down was sent on pointerdown).
          const { x, y } = toCoords(e.clientX, e.clientY)
          controlsRef.current.sendMouse(x, y, (0x01 << 3) | MOUSE_TYPE_UP)
        }
      }
    }

    const onWheel = (e: WheelEvent) => {
      if (isPaused()) return
      // When zoomed beyond the container, let the browser scroll the canvas
      // natively instead of forwarding the wheel to the remote.
      if (scrollableRef.current) return
      e.preventDefault()
      const dy = Math.abs(e.deltaY)
      if (dy === 0) return
      let steps = e.deltaY
      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        steps = Math.trunc(e.deltaY / SCROLL_STEP_PX) || sign(e.deltaY)
      }
      if (steps === 0) return
      // Queue instead of sending one message per wheel tick; the rAF flush
      // sends a bounded burst per frame so fast scrolls don't spam the relay.
      pendingWheelRef.current += steps
      scheduleInputFlush()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Outside the capture zone the page behaves natively (panel shortcuts,
      // text selection, form controls) — nothing goes to the host.
      if (!shouldForwardToHost({ captured: capturedRef.current, paused: isPaused(), target: e.target as HTMLElement | null }))
        return
      e.preventDefault()
      if (isPaused()) return
      // The host OS auto-repeats a held key by itself; forwarding every
      // browser repeat (~30Hz) only floods the relay with identical events.
      if (e.repeat) return
      const mods = getModNames(e)
      const body = buildKeyEvent({ down: true, key: e.key, keyCode: e.keyCode, code: e.code, modifiers: mods, platform: controlsRef.current.state.info?.platform })
      if (typeof localStorage !== 'undefined' && localStorage.getItem('rd_debug_keys') === '1') {
        console.info('[rd-keys] down key=%o code=%o mods=%o platform=%o body=%o', e.key, e.code, getModNames(e), controlsRef.current.state.info?.platform, body)
      }
      if (body) {
        controlsRef.current.sendKeyEvent(body)
        if (e.code) {
          heldKeysRef.current.set(e.code, {
            key: e.key,
            keyCode: e.keyCode,
            code: e.code,
            modifiers: mods,
            platform: controlsRef.current.state.info?.platform,
          })
        }
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (!shouldForwardToHost({ captured: capturedRef.current, paused: isPaused(), target: e.target as HTMLElement | null }))
        return
      e.preventDefault()
      if (isPaused()) return
      const body = buildKeyEvent({ down: false, key: e.key, keyCode: e.keyCode, code: e.code, modifiers: getModNames(e), platform: controlsRef.current.state.info?.platform })
      if (typeof localStorage !== 'undefined' && localStorage.getItem('rd_debug_keys') === '1') {
        console.info('[rd-keys] up key=%o code=%o mods=%o platform=%o body=%o', e.key, e.code, getModNames(e), controlsRef.current.state.info?.platform, body)
      }
      if (body) controlsRef.current.sendKeyEvent(body)
      if (e.code) heldKeysRef.current.delete(e.code)
    }

    const onContextMenu = (e: Event) => e.preventDefault()

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerEnd)
    canvas.addEventListener('pointercancel', onPointerEnd)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)

    return () => {
      if (inputFlushRafRef.current) {
        window.cancelAnimationFrame(inputFlushRafRef.current)
        inputFlushRafRef.current = 0
      }
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerEnd)
      canvas.removeEventListener('pointercancel', onPointerEnd)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  return (
    <div ref={containerRef} className="relative flex h-full w-full overflow-auto p-2">
      <canvas
        ref={canvasRef}
        width={rw}
        height={rh}
        tabIndex={0}
        style={{ touchAction: 'none', margin: 'auto' }}
        onPointerEnter={() => {
          setCaptured(true)
          try {
            canvasRef.current?.focus({ preventScroll: true })
          } catch {
            // ignore
          }
        }}
        onPointerLeave={() => setCaptured(false)}
        className={`block rounded-xl shadow-2xl bg-black outline-none${captured && SHOW_CAPTURE_RING ? ' ring-2 ring-primary/50' : ' ring-1 ring-border'}`}
      />
      {inputMode === 'pointer' && !cursorEnabled && (
        <div
          ref={dotRef}
          className="pointer-events-none absolute top-0 left-0 z-20"
          style={{
            width: 14,
            height: 14,
            marginLeft: -7,
            marginTop: -7,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.92)',
            boxShadow: '0 0 0 2px rgba(0,120,215,0.85)',
            transform: 'translate(-100px,-100px)',
          }}
        />
      )}
      {cursorEnabled && (
        <div
          ref={overlayDivRef}
          className="pointer-events-none absolute top-0 left-0 z-30"
          style={{ transform: 'translate(-100px,-100px)', display: 'none' }}
        />
      )}
      {cursorEnabled && (
        <div
          ref={touchCircleRef}
          className="pointer-events-none absolute top-0 left-0 z-30"
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            border: '2px solid rgba(255,255,255,0.9)',
            transform: 'translate(-100px,-100px)',
            display: 'none',
          }}
        />
      )}
    </div>
  )
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0
}