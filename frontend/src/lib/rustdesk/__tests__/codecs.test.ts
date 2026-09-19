import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickTurboCodec, probeBrowserCodecs, TURBO_CODEC_ORDER } from '../codecs'
import type { CodecName } from '../proto'

describe('TURBO_CODEC_ORDER', () => {
  it('software codecs only, cheapest first: vp8 before vp9 before av1', () => {
    expect([...TURBO_CODEC_ORDER]).toEqual(['vp8', 'vp9', 'av1'])
  })
})

describe('pickTurboCodec', () => {
  const all: Record<CodecName, boolean> = { vp9: true, h264: true, h265: true, vp8: true, av1: true }
  const none: Record<CodecName, boolean> = { vp9: false, h264: false, h265: false, vp8: false, av1: false }

  it.each([
    [['vp8', 'vp9'] as CodecName[], 'vp8'],
    [['vp9'] as CodecName[], 'vp9'],
    [['av1'] as CodecName[], 'av1'],
  ])('host %j -> %s', (host, expected) => {
    expect(pickTurboCodec(all, host)).toBe(expected)
  })

  it('skips browser-unsupported even if host has it', () => {
    expect(pickTurboCodec({ ...all, vp8: false }, ['vp8', 'vp9'])).toBe('vp9')
  })

  it('returns null on empty intersection', () => {
    expect(pickTurboCodec(none, ['vp8'])).toBeNull()
    expect(pickTurboCodec(all, [])).toBeNull()
  })
})

describe('probeBrowserCodecs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('maps engine answers to support flags (hardware codecs always false)', async () => {
    const table: Record<string, boolean> = {
      'vp09.00.10.08': true,
      vp8: true,
      'av01.0.04M.08': false,
      'av01.0.05M.08': true,
    }
    vi.stubGlobal(
      'VideoDecoder',
      class {
        static async isConfigSupported(cfg: { codec: string }) {
          return { supported: !!table[cfg.codec] }
        }
      },
    )
    // fresh module state per test file run; result is cached module-wide
    const support = await probeBrowserCodecs()
    expect(support).toMatchObject({ vp9: true, h264: false, h265: false, vp8: true, av1: true })
  })

  it('false when VideoDecoder is missing (Firefox Android case)', async () => {
    vi.resetModules()
    vi.stubGlobal('VideoDecoder', undefined)
    const fresh = await import('../codecs')
    expect(await fresh.probeBrowserCodecs()).toEqual({
      vp9: false,
      h264: false,
      h265: false,
      vp8: false,
      av1: false,
    })
  })
})

describe('G1 caps gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function freshModule() {
    vi.resetModules()
    return import('../codecs')
  }

  it('skips probe for mimes absent from getCapabilities (no probe burn)', async () => {
    const probed: string[] = []
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported(cfg: { codec: string }) {
        probed.push(cfg.codec)
        return { supported: true }
      }
    })
    vi.stubGlobal('RTCRtpReceiver', class {
      static getCapabilities() {
        return { codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/VP9' }] }
      }
    })
    const fresh = await freshModule()
    const support = await fresh.probeBrowserCodecs()
    // av1 would probe true — the gate must reject it before any probe runs
    expect(support).toMatchObject({ vp9: true, vp8: true, av1: false })
    expect(probed.some((c) => c.startsWith('av01'))).toBe(false)
    expect(await fresh.getMaxProvenPixels()).toMatchObject({ av1: 0 })
  })

  it('probes blind when getCapabilities is missing (old behavior)', async () => {
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported() {
        return { supported: true }
      }
    })
    const fresh = await freshModule()
    const support = await fresh.probeBrowserCodecs()
    expect(support).toMatchObject({ vp9: true, vp8: true, av1: true, h264: false, h265: false })
  })

  it('emits journal lines for gate and caps', async () => {
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported() {
        return { supported: true }
      }
    })
    vi.stubGlobal('RTCRtpReceiver', class {
      static getCapabilities() {
        return { codecs: [{ mimeType: 'video/VP8' }] }
      }
    })
    const fresh = await freshModule()
    const lines: string[] = []
    await fresh.probeBrowserCodecs((m: string) => lines.push(m))
    expect(lines.some((l) => l.includes('caps gate on'))).toBe(true)
    expect(lines.some((l) => l.includes('av1 absent in caps'))).toBe(true)
  })

  it('replays frozen journal lines to a late logger on the warm cache', async () => {
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported() {
        return { supported: true }
      }
    })
    vi.stubGlobal('RTCRtpReceiver', class {
      static getCapabilities() {
        return { codecs: [{ mimeType: 'video/VP8' }] }
      }
    })
    const fresh = await freshModule()
    const first: string[] = []
    await fresh.probeBrowserCodecs((m: string) => first.push(m))
    expect(first.length).toBeGreaterThan(0)
    // Second caller (e.g. the session after page pre-warm) gets the same lines.
    const late: string[] = []
    const support = await fresh.probeBrowserCodecs((m: string) => late.push(m))
    expect(support.vp8).toBe(true)
    expect(late).toEqual(first)
  })
})

describe('G2 size ladder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function freshModule() {
    vi.resetModules()
    return import('../codecs')
  }

  // Engine decodes up to 1080p, chokes on 4K.
  function stubLadder() {
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported(cfg: { codec: string; codedWidth: number }) {
        if (cfg.codedWidth > 1920) return { supported: false }
        return { supported: true }
      }
    })
  }

  it('caps each codec at the highest passing rung', async () => {
    stubLadder()
    const fresh = await freshModule()
    const support = await fresh.probeBrowserCodecs()
    expect(support).toMatchObject({ vp9: true, vp8: true, av1: true })
    expect(await fresh.getMaxProvenPixels()).toMatchObject({
      vp9: 1920 * 1080,
      vp8: 1920 * 1080,
      av1: 1920 * 1080,
    })
  })

  it('720p failure means unsupported (no hole-skipping)', async () => {
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported(cfg: { codec: string; codedWidth: number }) {
        // vp9 string fails at 720p but would pass higher — must not count
        if (cfg.codec.startsWith('vp09') && cfg.codedWidth === 1280) return { supported: false }
        return { supported: true }
      }
    })
    const fresh = await freshModule()
    const support = await fresh.probeBrowserCodecs()
    expect(support.vp9).toBe(false)
    expect(await fresh.getMaxProvenPixels()).toMatchObject({ vp9: 0 })
  })

  it('provenForPixels: unknown never excludes, caps exclude above', async () => {
    stubLadder()
    const fresh = await freshModule()
    await fresh.probeBrowserCodecs()
    expect(fresh.provenForPixels('vp9', 1920 * 1080)).toBe(true)
    expect(fresh.provenForPixels('vp9', 3840 * 2160)).toBe(false)
    expect(fresh.provenForPixels('vp9', null)).toBe(true)
    expect(fresh.provenForPixels('vp9', undefined)).toBe(true)
    // h264 is never offered: pixels 0, but unknown-codec path stays open
    expect(fresh.provenForPixels('vp9', 100)).toBe(true)
  })

  it('ladder off: legacy single probe, pixels unknown (exact G1)', async () => {
    const probed: Array<{ codec: string; w: number }> = []
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported(cfg: { codec: string; codedWidth: number }) {
        probed.push({ codec: cfg.codec, w: cfg.codedWidth })
        return { supported: true }
      }
    })
    const fresh = await freshModule()
    fresh.setProbeLadderEnabled(false)
    const support = await fresh.probeBrowserCodecs()
    expect(support).toMatchObject({ vp9: true, vp8: true, av1: true })
    expect(await fresh.getMaxProvenPixels()).toEqual({
      vp9: null,
      h264: 0,
      h265: 0,
      vp8: null,
      av1: null,
    })
    // single 1080p rung only — no ladder sizes probed
    const widths = new Set(probed.map((p) => p.w))
    expect(widths).toEqual(new Set([1920]))
  })
})

