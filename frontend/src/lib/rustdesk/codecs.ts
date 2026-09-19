import type { CodecName } from './proto'

export type BrowserCodecSupport = Record<CodecName, boolean>

// Max proven decode area per codec (width*height pixels), or null when
// unknown (ladder disabled or caps/probe gave no size info). Consumers treat
// null as "no cap" — never as a reason to exclude a codec.
export type ProvenPixels = Record<CodecName, number | null>

const PROBE_TIMEOUT_MS = 1500

// G2 kill-switch: flipping it off rolls the size ladder back. Behavior then
// degrades to G1 exactly (caps gate + single 1080p probe, pixels unknown).
// Production never touches it; flipping invalidates the one-per-load probe.
let ladderEnabled = true
export function setProbeLadderEnabled(v: boolean): void {
  ladderEnabled = v
  cached = null
  cachedSync = null
  cachedPixels = null
  cachedLines = []
}

type ProbeSize = { w: number; h: number; label: string }

// Ascending ladder: each rung must pass for the next to be attempted, so the
// result is always a contiguous "decodes up to N" claim, never a hole.
const PROBE_LADDER: ProbeSize[] = [
  { w: 1280, h: 720, label: '720p' },
  { w: 1920, h: 1080, label: '1080p' },
  { w: 3840, h: 2160, label: '4K' },
]
const LEGACY_PROBE: ProbeSize = { w: 1920, h: 1080, label: '1080p' }

// Multiple strings per codec: engines accept different profiles/levels.
// Hardware codecs (H.264/H.265) were removed from the product: only
// software-decoded codecs are offered, probed and negotiated.
const PROBE_STRINGS: Record<CodecName, string[]> = {
  vp9: ['vp09.00.10.08'],
  h264: [],
  h265: [],
  vp8: ['vp8'],
  av1: ['av01.0.04M.08', 'av01.0.05M.08'],
}

// G1: WebRTC engine capability gate. A codec whose MIME is absent from
// RTCRtpReceiver.getCapabilities('video') is rejected without a probe
// (no 1.5s timeout burn, no false hope). Returns null when the API is
// missing or uninformative — callers then probe exactly as before.
const ENGINE_MIME: Record<CodecName, string | null> = {
  vp9: 'video/vp9',
  h264: null, // never offered: product rule, caps are irrelevant
  h265: null, // never offered: product rule, caps are irrelevant
  vp8: 'video/vp8',
  av1: 'video/av1',
}

function readEngineMimes(): Set<string> | null {
  try {
    const receiver = (globalThis as unknown as { RTCRtpReceiver?: unknown }).RTCRtpReceiver as
      | { getCapabilities?: unknown }
      | undefined
    if (!receiver || typeof receiver.getCapabilities !== 'function') return null
    const caps = (receiver.getCapabilities as (kind: string) => unknown)('video') as {
      codecs?: Array<{ mimeType?: unknown }>
    } | null
    const list = caps?.codecs
    if (!Array.isArray(list) || list.length === 0) return null
    return new Set(list.map((c) => String(c?.mimeType ?? '').toLowerCase()))
  } catch {
    return null
  }
}

async function probeOne(codecString: string, size: ProbeSize): Promise<boolean> {
  try {
    if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
      return false
    }
    const res = await Promise.race([
      VideoDecoder.isConfigSupported({
        codec: codecString,
        codedWidth: size.w,
        codedHeight: size.h,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)),
    ])
    return !!res && res.supported === true
  } catch {
    return false
  }
}

async function probeAnyAt(strings: string[], size: ProbeSize): Promise<boolean> {
  const results = await Promise.all(strings.map((s) => probeOne(s, size)))
  return results.some(Boolean)
}

type ProbeVerdict = { ok: boolean; pixels: number | null; note: string }

async function probeCodec(codec: CodecName, mimes: Set<string> | null): Promise<ProbeVerdict> {
  const strings = PROBE_STRINGS[codec]
  // Hardware codecs are never probed and never reach the journal: empty
  // string lists mean "not offered", silently.
  if (strings.length === 0) return { ok: false, pixels: 0, note: '' }
  const mime = ENGINE_MIME[codec]
  if (mime && mimes && !mimes.has(mime)) {
    return { ok: false, pixels: 0, note: `probe: ${codec} absent in caps, skipped` }
  }
  if (!ladderEnabled) {
    const ok = await probeAnyAt(strings, LEGACY_PROBE)
    return { ok, pixels: null, note: `probe: ${codec} ${ok ? 'ok' : 'failed'} at 1080p (ladder off)` }
  }
  // G2 ladder: contiguous pass from 720p upward; first failing rung stops us.
  let max: ProbeSize | null = null
  for (const rung of PROBE_LADDER) {
    if (!(await probeAnyAt(strings, rung))) break
    max = rung
  }
  if (!max) return { ok: false, pixels: 0, note: `probe: ${codec} failed at 720p` }
  return { ok: true, pixels: max.w * max.h, note: `probe: ${codec} capped at ${max.label}` }
}

let cached: Promise<BrowserCodecSupport> | null = null
let cachedSync: BrowserCodecSupport | null = null
let cachedPixels: ProvenPixels | null = null
// Frozen journal lines of the one-per-load probe, replayed to late loggers.
let cachedLines: string[] = []

// Probe once per page load (parallel, bounded): the single source of truth
// for what THIS browser/engine can actually decode. No hardcoded browser
// tables — they rot; the runtime answer doesn't.
export function probeBrowserCodecs(log?: (msg: string) => void): Promise<BrowserCodecSupport> {
  if (cached) {
    // Warm cache (pre-warmed by the page before connect): replay the frozen
    // lines so this caller still sees how the verdict was reached.
    if (log) for (const line of cachedLines) log(line)
    return cached
  }
  cached = (async () => {
    const lines: string[] = []
    const record = (m: string) => {
      lines.push(m)
      log?.(m)
    }
    const mimes = readEngineMimes()
    if (mimes) record(`probe: caps gate on (${mimes.size} video mimes)`)
    else record('probe: no caps info, probing blind')
    const order: CodecName[] = ['vp9', 'h264', 'h265', 'vp8', 'av1']
    const verdicts = await Promise.all(order.map((c) => probeCodec(c, mimes)))
    const support = {} as BrowserCodecSupport
    const pixels = {} as ProvenPixels
    for (let i = 0; i < order.length; i++) {
      support[order[i]] = verdicts[i].ok
      pixels[order[i]] = verdicts[i].pixels
      // Only the interesting lines reach the journal: skips and caps.
      // Hardware codecs stay out of the journal entirely — they are never
      // probed, never offered, and their absence needs no announcement.
      if (order[i] === 'h264' || order[i] === 'h265') continue
      if (!verdicts[i].ok || verdicts[i].pixels !== null) record(verdicts[i].note)
    }
    cachedSync = support
    cachedPixels = pixels
    cachedLines = lines
    return support
  })()
  return cached
}

// Synchronous snapshot for hot paths (auto fallback chain). Null while the
// first probe is still in flight — callers then fall back to the old
// host-only behavior instead of blocking.
export function getCachedSupport(): BrowserCodecSupport | null {
  return cachedSync
}

// Synchronous snapshot of the G2 size caps. Null while the first probe is
// still in flight; per-codec null means "unknown, do not cap".
export function getMaxProvenPixels(): ProvenPixels | null {
  return cachedPixels
}

// True when the codec may be used for a stream of the given area (w*h).
// Unknown caps never exclude — the runtime fallback stays the safety net.
export function provenForPixels(codec: CodecName, pixels: number | null | undefined): boolean {
  if (pixels == null) return true
  const cap = cachedPixels?.[codec]
  if (cap == null) return true
  return pixels <= cap
}

// Cheapest decode cost first (universal software-decode order).
export const TURBO_CODEC_ORDER: Array<'vp8' | 'vp9' | 'av1'> = ['vp8', 'vp9', 'av1']

// Cheapest codec both sides speak, or null (caller keeps current/auto).
export function pickTurboCodec(browser: BrowserCodecSupport, host: CodecName[]): 'vp8' | 'vp9' | 'av1' | null {
  for (const c of TURBO_CODEC_ORDER) {
    if (browser[c] && host.includes(c)) return c
  }
  return null
}
