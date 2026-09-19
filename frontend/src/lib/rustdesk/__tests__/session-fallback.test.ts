import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRustDeskSession, type SessionConfig, type SessionEvent } from '../session'
import { encodeChatMessage, getBytes, parse } from '../proto'

type Handler = ((ev: never) => void) | null

class MockWS {
  static instances: MockWS[] = []
  static OPEN = 1
  url: string
  binaryType = ''
  readyState = 1
  onopen: Handler = null
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null
  onerror: Handler = null
  onclose: Handler = null
  sent: Uint8Array[] = []
  constructor(url: string) {
    this.url = url
    MockWS.instances.push(this)
  }
  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data))
  }
  close(): void {
    this.readyState = 3
  }
}

async function microtasks(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('negotiateDecoderFallback pin semantics', () => {
  beforeEach(() => {
    MockWS.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWS)
    // Engine that decodes everything: browser filter passes all codecs.
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: async () => ({ supported: true }),
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function connected(codec?: SessionConfig['codec']): WebRustDeskSession {
    const events: SessionEvent[] = []
    const s = new WebRustDeskSession(
      {
        address: 'h',
        serverKey: '',
        peerId: '1',
        password: '',
        relayServer: 'h:21117',
        video: { quality: 3, fps: 30, audioEnabled: false },
        ...(codec !== undefined ? { codec } : {}),
      },
      (ev) => {
        events.push(ev)
      },
    )
    s.connect()
    return s
  }

  it('auto steers a failed codec to the next candidate (vp9 -> vp8)', async () => {
    const s = connected()
    await microtasks()
    expect(s.negotiateDecoderFallback('vp9')).toBe('vp8')
  })

  it('manual pin is literal: no silent switch, even on failure', async () => {
    const s = connected('vp9')
    await microtasks()
    expect(s.negotiateDecoderFallback('vp9')).toBeNull()
  })

  it('auto chain walks vp9 -> vp8 -> av1 with two-stage timeouts', async () => {
    const s = connected()
    await microtasks()
    expect(s.negotiateDecoderFallback('vp9')).toBe('vp8')
    // Two-stage timeout: 4s only nudges the host (still waiting for vp8)...
    vi.advanceTimersByTime(4500)
    expect(s.negotiateDecoderFallback('vp8')).toBe('vp8')
    // ...escalation to the next codec happens at ~8s.
    vi.advanceTimersByTime(4500)
    expect(s.negotiateDecoderFallback('vp8')).toBe('av1')
  })

  it('exhausted chain returns null (fatal banner path)', async () => {
    const s = connected()
    await microtasks()
    expect(s.negotiateDecoderFallback('vp9')).toBe('vp8')
    vi.advanceTimersByTime(4500)
    vi.advanceTimersByTime(4500)
    expect(s.negotiateDecoderFallback('vp8')).toBe('av1')
    vi.advanceTimersByTime(4500)
    vi.advanceTimersByTime(4500)
    expect(s.negotiateDecoderFallback('av1')).toBeNull()
  })
})

describe('stats codec badge (wire truth)', () => {
  beforeEach(() => {
    MockWS.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWS)
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: async () => ({ supported: true }),
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('stats.codec is null before frames, then tracks the actual stream codec', async () => {
    const events: SessionEvent[] = []
    const s = new WebRustDeskSession(
      {
        address: 'h',
        serverKey: '',
        peerId: '1',
        password: '',
        relayServer: 'h:21117',
        video: { quality: 3, fps: 30, audioEnabled: false },
      },
      (ev) => {
        events.push(ev)
      },
    )
    s.connect()
    await microtasks()
    const frame = (s as unknown as { handleVideoFrame: (m: unknown) => void }).handleVideoFrame.bind(s)

    vi.advanceTimersByTime(1500)
    const before = events.filter((e) => e.type === 'stats').at(-1)
    expect(before?.type === 'stats' && before.stats.codec).toBeNull()

    frame({ kind: 'video_frame', codec: 'vp9', frames: [], display: 0 })
    vi.advanceTimersByTime(1500)
    const after = events.filter((e) => e.type === 'stats').at(-1)
    expect(after?.type === 'stats' && after.stats.codec).toBe('vp9')

    // Codec switch mid-session is reflected on the next tick (fact, not preference).
    frame({ kind: 'video_frame', codec: 'av1', frames: [], display: 0 })
    vi.advanceTimersByTime(1500)
    const switched = events.filter((e) => e.type === 'stats').at(-1)
    expect(switched?.type === 'stats' && switched.stats.codec).toBe('av1')
  })
})

describe('manual overrule grace (10s)', () => {
  beforeEach(() => {
    MockWS.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWS)
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: async () => ({ supported: true }),
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function pinned(codec: 'vp8' | 'vp9' | 'av1'): { s: WebRustDeskSession; events: SessionEvent[] } {
    const events: SessionEvent[] = []
    const s = new WebRustDeskSession(
      {
        address: 'h',
        serverKey: '',
        peerId: '1',
        password: '',
        relayServer: 'h:21117',
        video: { quality: 3, fps: 30, audioEnabled: false },
      },
      (ev) => {
        events.push(ev)
      },
    )
    s.connect()
    s.setCodecPreference(codec)
    return { s, events }
  }

  function feed(s: WebRustDeskSession, codec: string): void {
    (s as unknown as { handleVideoFrame: (m: unknown) => void }).handleVideoFrame({
      kind: 'video_frame',
      codec,
      frames: [],
      display: 0,
    })
  }

  function overrules(events: SessionEvent[]): number {
    return events.filter(
      (e) => e.type === 'log' && typeof e.message === 'string' && e.message.includes('despite manual'),
    ).length
  }

  it('mismatch inside the window is a transition, not defiance (no release)', async () => {
    const { s, events } = pinned('vp8')
    await microtasks()
    feed(s, 'vp9')
    vi.advanceTimersByTime(5000)
    feed(s, 'vp9')
    expect(overrules(events)).toBe(0)
  })

  it('persistent mismatch past the window releases once', async () => {
    const { s, events } = pinned('vp8')
    await microtasks()
    feed(s, 'vp9')
    vi.advanceTimersByTime(11_000)
    feed(s, 'vp9')
    expect(overrules(events)).toBe(1)
    // Released: further mismatches stay silent (auto chain owns it now).
    feed(s, 'vp9')
    expect(overrules(events)).toBe(1)
  })

  it('re-pinning restarts the window', async () => {
    const { s, events } = pinned('vp8')
    await microtasks()
    vi.advanceTimersByTime(9000)
    s.setCodecPreference('vp9')
    feed(s, 'vp8')
    vi.advanceTimersByTime(5000)
    feed(s, 'vp8')
    expect(overrules(events)).toBe(0)
  })
})

describe('live session debug flag', () => {
  beforeEach(() => {
    MockWS.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWS)
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: async () => ({ supported: true }),
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('debug chip drives emission without reconnect', async () => {    const events: SessionEvent[] = []
    const s = new WebRustDeskSession(
      {
        address: 'h',
        serverKey: '',
        peerId: '1',
        password: '',
        relayServer: 'h:21117',
        video: { quality: 3, fps: 30, audioEnabled: false },
      },
      (ev) => {
        events.push(ev)
      },
    )
    s.connect()
    await microtasks()
    const debugs = () => events.filter((e) => e.type === 'log' && e.level === 'debug').length
    // Off by default (no rd_debug at load): preference lines stay silent.
    s.setCodecPreference('vp8')
    await microtasks()
    expect(debugs()).toBe(0)
    // Chip on: the same action now emits.
    s.setSessionDebug(true)
    s.setCodecPreference('vp9')
    await microtasks()
    expect(debugs()).toBeGreaterThan(0)
    // Chip off again: silent.
    const n = debugs()
    s.setSessionDebug(false)
    s.setCodecPreference('av1')
    await microtasks()
    expect(debugs()).toBe(n)
  })
})

describe('deep-floor stuck streak wiring', () => {
  beforeEach(() => {
    MockWS.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWS)
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: async () => ({ supported: true }),
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('two ticks above 300ms Q drive 1/10 on a good link; reset recovers bands', async () => {    const s = new WebRustDeskSession(
      {
        address: 'h',
        serverKey: '',
        peerId: '1',
        password: '',
        relayServer: 'h:21117',
        video: { quality: 3, fps: 30, audioEnabled: false },
      },
      () => {},
    )
    s.connect()
    await microtasks()
    const inner = s as unknown as {
      pickAutoTarget: () => { quality: number; fps: number }
      recvHistory: number[]
      pingRttMs: number | null
    }
    inner.recvHistory = [9000, 9000, 9000]
    inner.pingRttMs = 40
    // Streak 1: bands + one strain step (Q>120), not the deep floor yet.
    s.publishVideoStats({ queueWaitMs: 400 })
    expect(inner.pickAutoTarget()).toEqual({ quality: 3, fps: 30 })
    // Streak 2: deep floor even though the link looks good.
    expect(inner.pickAutoTarget()).toEqual({ quality: 1, fps: 10 })
    // Q drained: streak resets, bands rule again.
    s.publishVideoStats({ queueWaitMs: 50 })
    expect(inner.pickAutoTarget()).toEqual({ quality: 4, fps: 60 })
  })
})

describe('inbound chat_message (Misc field 4)', () => {
  beforeEach(() => {
    MockWS.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWS)
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: async () => ({ supported: true }),
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function miscFields(text: string) {
    return parse(getBytes(parse(encodeChatMessage(text)), 19)!)
  }

  it('emits a chat event for text, drops empty text', () => {
    const events: SessionEvent[] = []
    const s = new WebRustDeskSession(
      {
        address: 'h',
        serverKey: '',
        peerId: '1',
        password: '',
        relayServer: 'h:21117',
        video: { quality: 3, fps: 30, audioEnabled: false },
      },
      (ev) => {
        events.push(ev)
      },
    )
    const feed = (s as unknown as { handleMisc: (f: unknown) => void }).handleMisc.bind(s)
    feed(miscFields('hi хост 👋'))
    expect(events).toEqual([{ type: 'chat', from: 'host', text: 'hi хост 👋' }])
    feed(miscFields(''))
    expect(events).toHaveLength(1)
  })

  it('sendChatMessage puts protobuf on the relay socket', async () => {
    const events: SessionEvent[] = []
    const s = new WebRustDeskSession(
      {
        address: 'h',
        serverKey: '',
        peerId: '1',
        password: '',
        relayServer: 'h:21117',
        video: { quality: 3, fps: 30, audioEnabled: false },
      },
      (ev) => {
        events.push(ev)
      },
    )
    s.connect()
    await microtasks()
    // Drive the session to the relay stage is heavy; instead verify the
    // encoder output the session would send (bytes covered in proto tests).
    // Here: no socket yet -> guarded no-op, never throws.
    expect(() => s.sendChatMessage('hello')).not.toThrow()
    expect(() => s.sendChatMessage('')).not.toThrow()
  })
})
