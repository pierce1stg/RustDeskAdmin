import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { probeBrowserCodecs, type BrowserCodecSupport } from '@/lib/rustdesk/codecs'
import {
  Monitor,
  Maximize,
  Minimize,
  Clipboard,
  ClipboardPaste,
  Keyboard,
  MessageCircle,
  SlidersHorizontal,
  X,
  Pause,
  Play,
  MousePointer2,
  Hand,
  Move,
  Zap,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import type { RustdeskControls } from '@/lib/rustdesk/useRustdeskControl'
import type { RenderScale } from '@/components/RemoteScreen'

// Render-scale options for the decoded picture backing store (see
// RemoteScreen `renderScale`): auto keeps current behaviour, original forces
// the host resolution, the p-caps trade 1:1 detail for decode/paint speed.
export const RENDER_SCALE_OPTIONS = [
  { value: 'auto', labelKey: 'control.renderAuto' },
  { value: 'original', labelKey: 'control.renderOriginal' },
  { value: '144p', labelKey: 'control.render144' },
  { value: '240p', labelKey: 'control.render240' },
  { value: '360p', labelKey: 'control.render360' },
  { value: '480p', labelKey: 'control.render480' },
  { value: '720p', labelKey: 'control.render720' },
  { value: '1080p', labelKey: 'control.render1080' },
  { value: '1440p', labelKey: 'control.render1440' },
] as const

const CONTROL_KEY_CTRL_ALT_DEL = 100
const CONTROL_KEY_ESCAPE = 8
const CONTROL_KEY_META = 23
const CONTROL_KEY_TAB = 31
const CONTROL_KEY_ALT = 1

// ImageQuality enum (2=Low, 3=Balanced, 4=Best); 0 = network-adaptive "Auto".
export const IMAGE_QUALITY_OPTIONS = [
  { value: 0, labelKey: 'control.qualityAuto' },
  { value: 2, labelKey: 'control.qualityLow' },
  { value: 3, labelKey: 'control.qualityBalanced' },
  { value: 4, labelKey: 'control.qualityBest' },
] as const

export const FPS_OPTIONS = [15, 30, 60] as const

// Codec choices offered by the selector: auto plus software-decoded codecs.
// Hardware codecs (H.264/H.265) were removed from the product.
export const CODEC_OPTIONS = [
  { value: 'auto', labelKey: 'control.codecAuto' },
  { value: 'vp8', labelKey: 'control.codecVP8' },
  { value: 'vp9', labelKey: 'control.codecVP9' },
  { value: 'av1', labelKey: 'control.codecAV1' },
] as const
export type CodecPreference = (typeof CODEC_OPTIONS)[number]['value']

export type ZoomMode = 'fit' | 'original' | 'custom'
export const ZOOM_PERCENTS = [25, 50, 75, 90, 100, 125, 150, 200, 300, 400] as const

export function SessionToolbar({
  controls,
  paused,
  onTogglePause,
  cursorEnabled,
  onToggleCursor,
  inputMode,
  onToggleInputMode,
  showInputModeToggle,
  quality,
  onQualityChange,
  fps,
  onFpsChange,
  codec,
  onCodecChange,
  renderScale,
  onRenderScaleChange,
  turbo,
  onToggleTurbo,
  fullscreen,
  onToggleFullscreen,
  zoomMode,
  onZoomModeChange,
  zoomPct,
  onZoomPctChange,
  onOpenChat,
}: {
  controls: RustdeskControls
  paused: boolean
  onTogglePause: () => void
  cursorEnabled: boolean
  onToggleCursor: () => void
  inputMode: 'touch' | 'pointer'
  onToggleInputMode: () => void
  showInputModeToggle: boolean
  quality: number
  onQualityChange: (q: number) => void
  fps: number
  onFpsChange: (fps: number) => void
  codec: CodecPreference
  onCodecChange: (codec: CodecPreference) => void
  renderScale: RenderScale
  onRenderScaleChange: (scale: RenderScale) => void
  turbo: boolean
  onToggleTurbo: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  zoomMode: ZoomMode
  onZoomModeChange: (mode: ZoomMode) => void
  zoomPct: number
  onZoomPctChange: (pct: number) => void
  onOpenChat: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  // Browser decode support (probed once, cached module-wide): unsupported
  // codecs render disabled so manual selection can't pick a doomed stream.
  const [codecSupport, setCodecSupport] = useState<BrowserCodecSupport | null>(null)
  useEffect(() => {
    void probeBrowserCodecs().then(setCodecSupport)
  }, [])
  const clipboardRef = useRef<{ text: string; at: number } | null>(null)
  const [clipboardReady, setClipboardReady] = useState(false)
  // The panel starts collapsed; the close button always works (there is no
  // auto-collapse, so a pin toggle would be redundant).
  const [open, setOpen] = useState(false)
  const info = controls.state.info
  const displayCount = info?.displayCount ?? 0
  const currentDisplay = info?.display ?? 0

  useEffect(() => {
    controls.registerClipboard((text) => {
      clipboardRef.current = { text, at: Date.now() }
      setClipboardReady(true)
    })
  }, [controls])

  const copyFromHost = async () => {
    const entry = clipboardRef.current
    if (!entry) {
      toast({ title: t('control.clipboardEmpty'), variant: 'default' })
      return
    }
    try {
      await navigator.clipboard.writeText(entry.text)
      controls.publishLog(`ui: clipboard from host (${entry.text.length} chars)`, 'ui')
      toast({ title: t('control.clipboardCopied'), variant: 'success' })
    } catch {
      toast({ title: t('control.clipboardDenied'), variant: 'destructive' })
    }
  }

  const sendToHost = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      // A huge paste would stall the relay for everything behind it (input,
      // ping, video acks share the same socket) — refuse with a message.
      if (text.length > 512 * 1024) {
        toast({ title: t('control.clipboardTooBig'), variant: 'destructive' })
        return
      }
      controls.sendClipboardText(text)
      controls.publishLog(`ui: clipboard to host (${text.length} chars)`, 'ui')
      toast({ title: t('control.clipboardSent'), variant: 'success' })
    } catch {
      toast({ title: t('control.clipboardDenied'), variant: 'destructive' })
    }
  }

  if (!open) {
    return (
      <Button
        size="icon"
        variant="secondary"
        onClick={() => setOpen(true)}
        title={t('control.panelToggle')}
        aria-label={t('control.panelToggle')}
        className="pointer-events-auto size-10 rounded-full opacity-70 shadow-lg ring-1 ring-border transition-opacity hover:opacity-100"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </Button>
    )
  }

  return (
    // Single scrollable row (never wraps): on narrow screens the panel stays
    // one row tall and swipes horizontally instead of eating half the canvas.
    // Children never squeeze ([&>*]:shrink-0) so controls keep tap size.
    <div className="pointer-events-auto flex max-w-[calc(100vw-1rem)] items-center gap-1.5 overflow-x-auto rounded-2xl bg-muted/95 p-1.5 shadow-lg ring-1 ring-border/60 backdrop-blur [&>*]:shrink-0">
      {/* Audio was removed from the web client (unreliable across hosts);
          disable_audio is always sent as Yes so hosts never start it. */}
      <Button
        size="icon"
        variant={paused ? 'default' : 'outline'}
        onClick={onTogglePause}
        title={paused ? t('control.resume') : t('control.pause')}
        aria-label={paused ? t('control.resume') : t('control.pause')}
        aria-pressed={paused}
        className="h-9 w-9"
      >
        {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
      </Button>

      <Button
        size="icon"
        variant={cursorEnabled ? 'default' : 'outline'}
        onClick={onToggleCursor}
        title={t('control.cursorToggle')}
        aria-label={t('control.cursorToggle')}
        aria-pressed={cursorEnabled}
        className="h-9 w-9"
      >
        <MousePointer2 className="h-4 w-4" />
      </Button>

      <Button
        size="icon"
        variant={turbo ? 'default' : 'outline'}
        onClick={onToggleTurbo}
        title={t('control.turboToggle')}
        aria-label={t('control.turboToggle')}
        aria-pressed={turbo}
        className="h-9 w-9"
      >
        <Zap className="h-4 w-4" />
      </Button>

      {showInputModeToggle && (
        <Button
          size="icon"
          variant={inputMode === 'pointer' ? 'default' : 'outline'}
          onClick={onToggleInputMode}
          title={inputMode === 'pointer' ? t('control.pointerMode') : t('control.touchMode')}
          aria-label={inputMode === 'pointer' ? t('control.pointerMode') : t('control.touchMode')}
          aria-pressed={inputMode === 'pointer'}
          className="h-9 w-9"
          disabled={paused}
        >
          {inputMode === 'pointer' ? <Move className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
        </Button>
      )}

      <label className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
        <span className="sr-only">{t('control.quality')}</span>
        <select
          className="neu-field h-9 rounded-lg border border-border px-2 text-xs text-foreground outline-none disabled:opacity-50"
          value={quality}
          onChange={(e) => onQualityChange(Number(e.target.value))}
          title={`${t('control.quality')}. ${t('control.qualityAutoHint')}`}
          aria-label={t('control.quality')}
          disabled={paused}
        >
          {IMAGE_QUALITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      </label>

      <label className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
        <span className="sr-only">{t('control.codec')}</span>
        <select
          className="neu-field h-9 rounded-lg border border-border px-2 text-xs text-foreground outline-none disabled:opacity-50"
          value={codec}
          onChange={(e) => onCodecChange(e.target.value as CodecPreference)}
          title={t('control.codec')}
          aria-label={t('control.codec')}
          disabled={paused}
        >
          {CODEC_OPTIONS.map((o) => {
            const unsupported =
              o.value !== 'auto' && codecSupport !== null && codecSupport[o.value as keyof BrowserCodecSupport] === false
            return (
              <option
                key={o.value}
                value={o.value}
                disabled={unsupported}
                title={unsupported ? t('control.codecUnsupportedDesc') : undefined}
              >
                {t(o.labelKey)}
              </option>
            )
          })}
        </select>
      </label>

      <label className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
        <span className="sr-only">{t('control.renderScale')}</span>
        <select
          className="neu-field h-9 rounded-lg border border-border px-2 text-xs text-foreground outline-none disabled:opacity-50"
          value={renderScale}
          onChange={(e) => onRenderScaleChange(e.target.value as RenderScale)}
          title={t('control.renderScale')}
          aria-label={t('control.renderScale')}
          disabled={paused}
        >
          {RENDER_SCALE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      </label>

      <label className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
        <span className="sr-only">{t('control.fps')}</span>
        <input
          type="number"
          className="neu-field h-9 w-16 rounded-lg border border-border px-2 text-xs text-foreground outline-none disabled:opacity-50"
          value={fps}
          min={1}
          max={240}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v > 0) onFpsChange(Math.round(v))
          }}
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (!Number.isFinite(v) || v <= 0) e.currentTarget.value = String(fps)
          }}
          title={t('control.fps')}
          aria-label={t('control.fps')}
          disabled={paused || quality === 0}
        />
      </label>

      <div className="flex items-center gap-0.5 rounded-lg bg-background p-0.5 ring-1 ring-border/60" title={t('control.zoom')}>
        <button
          type="button"
          onClick={() => onZoomModeChange('fit')}
          disabled={paused}
          className={`raw-focus rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            zoomMode === 'fit' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
          }`}
          title={t('control.zoomFit')}
        >
          {t('control.zoomFit')}
        </button>
        <button
          type="button"
          onClick={() => onZoomModeChange('original')}
          disabled={paused}
          className={`raw-focus rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            zoomMode === 'original' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
          }`}
          title={t('control.zoomOriginal')}
        >
          1:1
        </button>
        {zoomMode === 'custom' ? (
          <select
            className="neu-field h-7 rounded-md border border-border bg-background px-1 text-[11px] text-foreground outline-none disabled:opacity-40"
            value={zoomPct}
            onChange={(e) => onZoomPctChange(Number(e.target.value))}
            title={t('control.zoomCustom')}
            disabled={paused}
            autoFocus
          >
            {ZOOM_PERCENTS.map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => onZoomModeChange('custom')}
            disabled={paused}
            className={`raw-focus rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40`}
            title={t('control.zoomCustom')}
          >
            %
          </button>
        )}
      </div>

      <Button
        size="icon"
        variant="outline"
        onClick={() => {
          controls.publishLog('ui: switch display', 'ui')
          controls.sendSwitchDisplay()
        }}
        title={t('control.switchDisplay')}
        aria-label={t('control.switchDisplay')}
        disabled={paused || (displayCount > 0 && displayCount <= 1)}
        className={displayCount > 1 ? 'h-9 w-12' : 'h-9 w-9'}
      >
        <Monitor className="h-4 w-4" />
        {displayCount > 1 && (
          <span className="ms-0.5 text-[10px] leading-none">
            {currentDisplay + 1}/{displayCount}
          </span>
        )}
      </Button>

      <Button size="icon" variant="outline" onClick={copyFromHost} title={t('control.clipboardCopy')} aria-label={t('control.clipboardCopy')} className="h-9 w-9" disabled={paused}>
        <span className="relative">
          <Clipboard className="h-4 w-4" />
          {clipboardReady && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-green-500" />}
        </span>
      </Button>

      <Button size="icon" variant="outline" onClick={sendToHost} title={t('control.clipboardPut')} aria-label={t('control.clipboardPut')} className="h-9 w-9" disabled={paused}>
        <ClipboardPaste className="h-4 w-4" />
      </Button>

      <Button size="icon" variant="outline" onClick={onOpenChat} title={t('control.chatOpen')} aria-label={t('control.chatOpen')} className="relative h-9 w-9" disabled={paused}>
        <MessageCircle className="h-4 w-4" />
        {controls.state.unreadChat > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-0.5 font-mono text-[9px] font-bold text-white">
            {controls.state.unreadChat > 99 ? '99+' : controls.state.unreadChat}
          </span>
        )}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="outline" title={t('control.hotkeys')} aria-label={t('control.hotkeys')} className="h-9 w-9" disabled={paused}>
            <Keyboard className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t('control.hotkeys')}</div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => {
            controls.publishLog('ui: hotkey ctrl+alt+del', 'ui')
            controls.sendHotkey(CONTROL_KEY_CTRL_ALT_DEL)
          }}>
            <span className="me-2 h-1.5 w-1.5 rounded-full bg-green-500" />
            Ctrl+Alt+Del
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            controls.publishLog('ui: hotkey esc', 'ui')
            controls.sendHotkey(CONTROL_KEY_ESCAPE)
          }}>
            <span className="me-2 h-1.5 w-1.5" />
            Esc
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            controls.publishLog('ui: hotkey win', 'ui')
            controls.sendHotkey(CONTROL_KEY_META)
          }}>
            <span className="me-2 h-1.5 w-1.5" />
            {t('control.keyWin')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              controls.publishLog('ui: hotkey alt+tab', 'ui')
              controls.sendKeyEvent({ down: true, controlKey: CONTROL_KEY_ALT, modifiers: [] })
              controls.sendKeyEvent({ down: true, controlKey: CONTROL_KEY_TAB, modifiers: [] })
              controls.sendKeyEvent({ down: false, controlKey: CONTROL_KEY_TAB, modifiers: [] })
              controls.sendKeyEvent({ down: false, controlKey: CONTROL_KEY_ALT, modifiers: [] })
            }}
          >
            <span className="me-2 h-1.5 w-1.5" />
            Alt+Tab
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="icon"
        variant="outline"
        onClick={onToggleFullscreen}
        title={t('control.fullscreenToggle')}
        aria-label={t('control.fullscreenToggle')}
        aria-pressed={fullscreen}
        className="h-9 w-9"
        disabled={paused}
      >
        {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
      </Button>

      <Button
        size="icon"
        variant="outline"
        onClick={() => setOpen(false)}
        title={t('control.panelCollapse')}
        aria-label={t('control.panelCollapse')}
        className="h-9 w-9"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}