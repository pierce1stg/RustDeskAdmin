import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoFrameDecoder, isUnsupportedConfigurationError } from '../decoder'
import type { VideoPacket } from '../session'

// --- Minimal WebCodecs stubs (happy-dom has none). The stub records
// configure() calls and chunks, and can throw synchronously from decode()
// or fail asynchronously via the error callback on demand.
const configured: VideoDecoderConfig[] = []
const decoded: Uint8Array[] = []
let decodeBehavior: 'ok' | 'throw' | 'asyncError' = 'ok'
let failConfigureSync = false
let stubQueueSize = 0
let capturedOutput: ((frame: unknown) => void) | null = null
let capturedError: ((e: unknown) => void) | null = null

class StubVideoDecoder {
  state = 'unconfigured'
  constructor(init: { output: (frame: unknown) => void; error: (e: unknown) => void }) {
    capturedOutput = init.output
    capturedError = init.error
  }
  static async isConfigSupported(): Promise<{ supported: boolean }> {
    return { supported: true }
  }
  get decodeQueueSize(): number {
    return stubQueueSize
  }
  configure(cfg: VideoDecoderConfig): void {
    if (failConfigureSync) throw new Error('Unsupported configuration')
    configured.push(cfg)
    this.state = 'configured'
  }
  decode(chunk: unknown): void {
    const data = (chunk as { data: Uint8Array }).data
    if (decodeBehavior === 'throw') {
      throw new Error("A key frame is required after configure() or flush()")
    }
    if (decodeBehavior === 'asyncError') {
      const cb = capturedError
      queueMicrotask(() => cb?.(new Error('Decoding error')))
    }
    decoded.push(data)
  }
  close(): void {
    this.state = 'closed'
  }
}

class StubChunk {
  type: string
  timestamp: number
  data: Uint8Array
  constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
    this.type = init.type
    this.timestamp = init.timestamp
    this.data = init.data
  }
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const noop = (): void => undefined
let now = 1_000_000
let nowSpy: ReturnType<typeof vi.spyOn> | null = null

function pkt(pts: number, codec = 'vp9', key = true, data: number[] = [1, 2, 3]): VideoPacket {
  return { codec, key, data: new Uint8Array(data), display: 0, pts }
}

function fakeFrame(): unknown {
  return {
    timestamp: 0,
    displayWidth: 640,
    displayHeight: 480,
    codedWidth: 640,
    codedHeight: 480,
    close() {},
  }
}

describe('isUnsupportedConfigurationError', () => {
  it('matches only that message', () => {
    expect(isUnsupportedConfigurationError(new Error('Unsupported configuration'))).toBe(true)
    expect(isUnsupportedConfigurationError(new Error('Decoding error'))).toBe(false)
    expect(isUnsupportedConfigurationError('boom')).toBe(false)
  })
})

describe('VideoFrameDecoder', () => {
  beforeEach(() => {
    configured.length = 0
    decoded.length = 0
    capturedOutput = null
    capturedError = null
    decodeBehavior = 'ok'
    failConfigureSync = false
    stubQueueSize = 0
    now = 1_000_000
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    ;(globalThis as Record<string, unknown>).VideoDecoder = StubVideoDecoder
    ;(globalThis as Record<string, unknown>).EncodedVideoChunk = StubChunk
  })

  afterEach(() => {
    nowSpy?.mockRestore()
    delete (globalThis as Record<string, unknown>).VideoDecoder
    delete (globalThis as Record<string, unknown>).EncodedVideoChunk
  })

  // handlePacket buffers the unit and feeds it on the NEXT packet, and
  // configure() resolves asynchronously — so serialize packets with a tick.
  async function feed(d: VideoFrameDecoder, p: VideoPacket): Promise<void> {
    now += 2500 // step past the reinit backoff
    d.handlePacket(p)
    await tick()
  }

  it('reassembles same-pts parts into one chunk', async () => {
    const d = new VideoFrameDecoder(noop)
    await feed(d, pkt(1)) // starts init, dropped (no decoder yet)
    expect(configured.length).toBe(1)
    await feed(d, { ...pkt(9), data: new Uint8Array([10, 11]) })
    await feed(d, { ...pkt(9), data: new Uint8Array([12, 13]) })
    await feed(d, pkt(10))
    expect(decoded.length).toBe(1)
    expect([...decoded[0]]).toEqual([10, 11, 12, 13])
    d.close()
  })

  it('drops deltas until the first keyframe, then feeds keys', async () => {
    const reinits: number[] = []
    const d = new VideoFrameDecoder(noop, undefined, () => reinits.push(1))
    await feed(d, { ...pkt(1), key: false }) // dropped: probe in flight
    await feed(d, { ...pkt(2), key: false })
    await feed(d, { ...pkt(3), key: false }) // dropped: awaiting first key
    await feed(d, pkt(4)) // buffered key
    await feed(d, pkt(5)) // flushes the key -> fed
    expect(decoded.length).toBe(1)
    // Dropped deltas never beg for keyframes (no request cannon); liveness
    // comes from the session stall detector and keep-alive nudges.
    expect(reinits.length).toBe(0)
    d.close()
  })

  it('engine-unsupported codec falls back once and never re-probes', async () => {
    failConfigureSync = true
    const unsupported: string[] = []
    const d = new VideoFrameDecoder(noop, undefined, noop, undefined, (c) => unsupported.push(c))
    await feed(d, pkt(1))
    await feed(d, pkt(2))
    await feed(d, pkt(3))
    expect(unsupported).toEqual(['vp9'])
    expect(configured.length).toBe(0) // configure threw every time
    d.close()
  })

  it('two async errors declare the codec fatal; further packets stop', async () => {
    const fatals: string[] = []
    const d = new VideoFrameDecoder(noop, undefined, noop, (c) => fatals.push(c))
    await feed(d, pkt(1))
    await feed(d, pkt(2))
    capturedError?.(new Error('Decoding error'))
    capturedError?.(new Error('Decoding error'))
    expect(fatals).toEqual(['vp9'])
    const n = configured.length
    await feed(d, pkt(3))
    await feed(d, pkt(4))
    expect(configured.length).toBe(n) // fatal: no more probes
    d.close()
  })

  it('backlog drops deltas but always lets keys through', async () => {
    const d = new VideoFrameDecoder(noop)
    d.setBacklogLimit(1)
    await feed(d, pkt(1))
    stubQueueSize = 2
    await feed(d, { ...pkt(2), key: false })
    await feed(d, { ...pkt(3), key: false })
    await feed(d, pkt(4))
    await feed(d, pkt(5))
    expect(decoded.length).toBe(1) // only the key survived
    stubQueueSize = 0
    d.close()
  })

  it('async error burst with output flowing requests one resync, no steering', async () => {
    const reinits: number[] = []
    const fired: string[] = []
    const d = new VideoFrameDecoder(noop, undefined, () => reinits.push(1), undefined, undefined, (c) =>
      fired.push(c),
    )
    await feed(d, pkt(1))
    await feed(d, pkt(2))
    capturedOutput?.(fakeFrame()) // output flows from here
    const base = reinits.length
    decodeBehavior = 'asyncError'
    for (let pts = 3; pts <= 16; pts++) {
      now += 2500
      d.handlePacket({ ...pkt(pts), key: false })
      await tick()
    }
    expect(reinits.length).toBeGreaterThan(base)
    expect(fired).toEqual([])
    d.close()
  })

  it('sync-thrown keyframes with zero output steer exactly once', async () => {
    decodeBehavior = 'throw'
    const fired: string[] = []
    const d = new VideoFrameDecoder(noop, undefined, noop, undefined, undefined, (c) => fired.push(c))
    for (let pts = 1; pts <= 12; pts++) await feed(d, pkt(pts))
    expect(fired).toEqual(['vp9'])
    for (let pts = 13; pts <= 18; pts++) await feed(d, pkt(pts))
    expect(fired).toEqual(['vp9'])
    d.close()
  })

  it('decode time excludes queue wait; first-key need fires once per configure', async () => {
    const needFirst: number[] = []
    const stats: Array<{ decodeTimeMs: number; queueWaitMs: number }> = []
    const d = new VideoFrameDecoder(
      noop,
      (st) => stats.push({ decodeTimeMs: st.decodeTimeMs, queueWaitMs: st.queueWaitMs }),
      noop,
      undefined,
      undefined,
      noop,
      () => needFirst.push(1),
    )
    await feed(d, pkt(1)) // starts init, dropped
    expect(needFirst.length).toBe(1)
    await feed(d, pkt(2)) // buffered at T0
    now += 1100 // backlog wait accrues before the flush
    await feed(d, pkt(3)) // flushes unit 2, decode() called now
    now += 5 // pure decode takes 5ms
    capturedOutput?.(fakeFrame()) // chunkTs 0 matches the first fed chunk
    expect(needFirst.length).toBe(1) // no re-configure, no second beg
    expect(stats.length).toBeGreaterThan(0)
    const last = stats[stats.length - 1]
    expect(last.decodeTimeMs).toBeLessThanOrEqual(30) // pure: ~5ms, not ~1100ms
    expect(last.queueWaitMs).toBeGreaterThanOrEqual(1000) // arrival wait intact
    d.close()
  })
})
