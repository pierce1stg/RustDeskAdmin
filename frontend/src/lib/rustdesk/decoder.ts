import type { VideoPacket } from './session'

// Software-decoded codecs only. Hardware codecs (H.264/H.265) were removed
// from the product: engines that cannot use a codec report it via
// isUnsupportedConfigurationError and the session falls back.
const CODEC_STRINGS: Record<string, string> = {
  vp9: 'vp09.00.10.08',
  vp8: 'vp8',
  av1: 'av01.0.04M.08',
}

// Some engines bless a config in isConfigSupported() that configure() then
// rejects asynchronously with this message. It means the *codec itself*
// cannot be used in this engine — retrying the same config loops forever, so
// it is classified as a permanent per-codec failure that triggers a codec
// fallback.
export function isUnsupportedConfigurationError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /unsupported configuration/i.test(msg)
}

// Encoded access units can be split across several frames/messages that share
// the same pts; reassembling them before decode avoids feeding partial NAL units
// to the decoder (which corrupts large frames, typically under heavy motion).
const MAX_PENDING_BYTES = 16 * 1024 * 1024

export interface DecoderStats {
  fps: number
  frameIntervalMs: number
  decodeTimeMs: number
  lastFrameAt: number
  // Backpressure telemetry: decoder queue depth at last decode(), cumulative
  // dropped deltas, and queue wait included in decodeTimeMs.
  queueSize: number
  queueDrops: number
  queueWaitMs: number
  // Corrupt-chunk telemetry, split by key/delta.
  keyErrors: number
  deltaErrors: number
}

export type FrameCallback = (frame: VideoFrame) => void
export type StatsCallback = (stats: DecoderStats) => void

// Runtime decode-error reinitializations allowed per codec before the stream is
// declared unusable. Unsupported configurations abort immediately instead, so
// this only stops pathological loops (a decoder that keeps erroring) without
// leaving the session in a silent black picture.
const MAX_INIT_FAILURES = 2

// Backpressure watermark: when more than this many chunks are already queued
// in the decoder, drop incoming deltas (until the next keyframe) so the
// picture catches up instead of compounding delay.
const DECODE_QUEUE_WATERMARK = 4

// Upper bound for the timestamp bookkeeping maps: a decoder that drops output
// silently must not grow them without limit.
const MAX_TRACKED_CHUNKS = 500

// Minimum gap between decoder rebuilds: a storm of failing keyframes must not
// turn into a reconfigure storm (each rebuild drops in-flight packets and
// begs the host for yet another keyframe).
const MIN_REINIT_INTERVAL_MS = 2000

// Consecutive synchronously-rejected keyframes with zero decoded output before
// escalating to codec steering (the async error callback never fires for
// these, so without this budget the loop would be invisible to fallbacks).
const STEER_KEY_BUDGET = 5

// Consecutive async decode errors with output flowing before a bounded
// keyframe resync is requested (heals a poisoned GOP; the session
// rate-limits the actual request).
const GOP_RESYNC_BURST = 10

export class VideoFrameDecoder {
  private decoder: VideoDecoder | null = null
  private currentCodec = ''
  private onFrame: FrameCallback
  private onStats?: StatsCallback
  private onReinit?: () => void
  private onFatal?: (codec: string) => void
  private onCodecUnsupported?: (codec: string) => void
  // The stream itself is undecodable (keyframes rejected, zero output) — the
  // session should steer the host to another encoder (auto mode only; a
  // manual pin shows the fatal banner instead).
  private onStreamUndecodable?: (codec: string) => void
  // Fired once per successful configure(): the decoder now accepts only a
  // key chunk, so the UI asks the host for one keyframe (unthrottled, once).
  // Bounded by design — one request per configure, never per packet — so it
  // cannot become the old request cannon.
  private onNeedFirstKey?: () => void
  // Fired once per successful configure() with the live codec: the journal's
  // "decoder picked X" fact (decoder truth, not wire truth).
  private onConfigured?: (codec: string) => void
  private frameCount = 0

  // Codecs the engine proved it cannot decode this session (async
  // "Unsupported configuration"). Tracked so a reset/fallback never re-probes a
  // doomed codec; the session escalates to the next candidate instead.
  private failedCodecs = new Set<string>()

  // WebCodecs requires the first chunk after configure() to be a key frame;
  // feeding a delta there throws "A key frame is required after configure() or
  // flush()", which used to throw the stream into a reinit/error loop (black
  // picture). While set, delta access units are dropped until a key
  // frame arrives.
  private awaitingFirstKey = false

  // Configuration probing is async, so a generation counter invalidates probes
  // started before a reset/close and `pendingInitCodec` collapses concurrent
  // init requests for the same codec. `initFailures` caps error-loop retries;
  // `fatalCodec` permanently drops the stream once a codec is unusable.
  private initGen = 0
  private pendingInitCodec = ''
  private initFailures = 0
  private fatalCodec = ''

  private lastFrameReceivedAt = 0
  private recentIntervals: number[] = []
  private decodeStartTimes = new Map<number, number>()
  private decodeEnqueueTimes = new Map<number, number>()
  // Pure decode time (decode() call -> output), split from the arrival ->
  // output span above so auto-quality stops mistaking network backlog for a
  // slow decoder.
  private decodeBeginTimes = new Map<number, number>()
  private recentDecodeTimes: number[] = []
  private recentQueueWaits: number[] = []
  private queueDrops = 0
  private lastQueueSize = 0
  // Backlog watermark, tunable at runtime (turbo mode tightens it).
  private backlogLimit = DECODE_QUEUE_WATERMARK
  private lastFrameAt = 0
  private fpsWindowStart = 0
  private fpsFrameCount = 0
  // Key/delta split of decode failures — tells corrupt keyframes (reassembly
  // trouble) apart from lost deltas (network).
  private keyErrors = 0
  private deltaErrors = 0
  private lastFedKey = false
  private lastFedDetail = ''
  private lastDecodeErrorLogAt = 0
  private decodeErrorLogCount = 0
  // Stream-undecodable escalation (codec steering): synchronously rejected
  // keyframes with zero decoded output. Reset on every successful configure
  // and on the first decoded frame; fires once per configure.
  private syncKeyFails = 0
  private decodedSinceConfigure = 0
  private steerFired = false
  // Consecutive ASYNC decode errors while output flows: a poisoned GOP
  // (dropped reference) heals with one bounded keyframe request.
  private asyncErrBurst = 0
  private lastInitAt = 0

  // A coded-size change (e.g. after a display switch to a different resolution)
  // or a decoder error means the decoder state is stale — rebuild it so the next
  // keyframe starts clean instead of producing a mosaic.
  private needsReinit = false
  private lastCodedWidth = 0
  private lastCodedHeight = 0
  private lastDisplayWidth = 0
  private lastDisplayHeight = 0

  // Access-unit reassembly buffer, keyed by pts.
  private pendingPts = -1
  private pendingKey = false
  private pendingCodec = ''
  private pendingParts: Uint8Array[] = []
  private pendingSize = 0
  // Wall-clock arrival of the first part of the pending unit — the difference
  // to the decode() call time is the reassembly wait ( honest queue metric).
  private pendingArrivedAt = 0

  constructor(
    onFrame: FrameCallback,
    onStats?: StatsCallback,
    onReinit?: () => void,
    onFatal?: (codec: string) => void,
    onCodecUnsupported?: (codec: string) => void,
    onStreamUndecodable?: (codec: string) => void,
    onNeedFirstKey?: () => void,
    onConfigured?: (codec: string) => void,
  ) {
    this.onFrame = onFrame
    this.onStats = onStats
    this.onReinit = onReinit
    this.onFatal = onFatal
    this.onCodecUnsupported = onCodecUnsupported
    this.onStreamUndecodable = onStreamUndecodable
    this.onNeedFirstKey = onNeedFirstKey
    this.onConfigured = onConfigured
  }

  // Runtime-tunable backlog watermark (turbo mode tightens catch-up).
  setBacklogLimit(n: number): void {
    if (Number.isFinite(n)) this.backlogLimit = Math.max(1, Math.min(16, Math.round(n)))
  }

  reset(): void {    this.flushPending(true)
    this.needsReinit = false
    this.lastCodedWidth = 0
    this.lastCodedHeight = 0
    this.lastDisplayWidth = 0
    this.lastDisplayHeight = 0
    this.awaitingFirstKey = false
    this.initFailures = 0
    this.fatalCodec = ''
    this.decodeEnqueueTimes.clear()
    this.decodeBeginTimes.clear()
    this.recentQueueWaits = []
    this.queueDrops = 0
    this.lastQueueSize = 0
    this.keyErrors = 0
    this.deltaErrors = 0
    this.syncKeyFails = 0
    this.decodedSinceConfigure = 0
    this.steerFired = false
    this.asyncErrBurst = 0
    this.lastDecodeErrorLogAt = 0
    this.decodeErrorLogCount = 0
    if (this.currentCodec) void this.initDecoder(this.currentCodec)
  }

  handlePacket(packet: VideoPacket): void {
    if (packet.data.length < 2 || !!this.fatalCodec) return
    const now = performance.now()

    if (this.lastFrameReceivedAt > 0) {
      const interval = now - this.lastFrameReceivedAt
      this.recentIntervals.push(interval)
      if (this.recentIntervals.length > 60) this.recentIntervals.shift()
    }
    this.lastFrameReceivedAt = now

    if (packet.codec !== this.currentCodec) void this.initDecoder(packet.codec)
    if (this.needsReinit) {
      // Rebuild backoff: a failing stream must not turn into a reconfigure
      // storm (every rebuild drops packets and begs for another keyframe).
      // Keep the flag and let the next packet retry after the interval.
      if (performance.now() - this.lastInitAt < MIN_REINIT_INTERVAL_MS) return
      this.needsReinit = false
      this.flushPending(true)
      void this.initDecoder(this.currentCodec || packet.codec)
    }
    // While a config probe is in flight (or the codec is unusable) there is no
    // ready decoder — feeding it would throw "decode on a closed codec".
    if (!this.decoder || this.decoder.state !== 'configured') return

    if (packet.pts > 0 && this.pendingPts === packet.pts) {
      // Next part of an access unit split across calls.
      this.pendingParts.push(packet.data)
      this.pendingSize += packet.data.length
      this.pendingKey = packet.key || this.pendingKey
      if (this.pendingSize >= MAX_PENDING_BYTES) this.flushPending()
      return
    }

    // Start (and flush the previous) access unit.
    this.flushPending()
    this.pendingPts = packet.pts
    this.pendingKey = packet.key
    this.pendingCodec = packet.codec
    this.pendingParts = [packet.data]
    this.pendingSize = packet.data.length
    this.pendingArrivedAt = now
    // pts===0 carries no grouping info — feed right away like before.
    if (packet.pts === 0) this.flushPending()
  }


  private flushPending(drop = false): void {
    const parts = this.pendingParts
    const key = this.pendingKey
    const codec = this.pendingCodec || this.currentCodec
    const total = this.pendingSize
    const arrivedAt = this.pendingArrivedAt
    this.pendingParts = []
    this.pendingKey = false
    this.pendingCodec = ''
    this.pendingSize = 0
    this.pendingPts = -1
    this.pendingArrivedAt = 0
    if (drop || parts.length === 0) return

    const buf = new Uint8Array(total)
    let off = 0
    for (const part of parts) {
      buf.set(part, off)
      off += part.length
    }

    if (!this.decoder || this.decoder.state !== 'configured') return


    // After a fresh configure() the decoder only accepts a key chunk. Drop
    // deltas silently until the first keyframe arrives — no per-packet
    // keyframe begging here (it used to fire onReinit on EVERY dropped delta,
    // a request cannon on top of every rebuild; the post-configure nudge in
    // initDecoder plus the session keep-alive nudges are enough).
    if (this.awaitingFirstKey) {
      if (!key) return
      this.awaitingFirstKey = false
    }

    // Backpressure: the decoder is falling behind. Drop deltas until the next
    // keyframe so the picture catches up instead of compounding delay. Keys
    // always go through (they resync the stream).
    let queueSize = 0
    try {
      queueSize = this.decoder.decodeQueueSize
    } catch {
      queueSize = 0
    }
    this.lastQueueSize = queueSize
    if (!key && queueSize > this.backlogLimit) {
      this.queueDrops++
      return
    }

    const chunkTs = this.frameCount++ * (1_000_000 / 30)
    const nowTs = performance.now()
    this.decodeStartTimes.set(chunkTs, nowTs)
    // Reassembly/backlog wait for this unit (arrival → decode() call).
    this.decodeEnqueueTimes.set(chunkTs, arrivedAt > 0 ? Math.max(0, nowTs - arrivedAt) : 0)
    // Remember the unit kind for the async error callback below.
    this.lastFedKey = key
    const feed = buf
    this.lastFedDetail = `${codec} ${total}b q=${queueSize}`
    // A decoder that silently drops output must not grow the bookkeeping maps
    // without limit — shed the oldest entries. Map iteration order is
    // insertion order and chunk timestamps are monotonic, so plain FIFO
    // eviction (no O(n log n) sort on the overloaded path).
    while (this.decodeStartTimes.size > MAX_TRACKED_CHUNKS) {
      const oldest = this.decodeStartTimes.keys().next()
      if (oldest.done) break
      this.decodeStartTimes.delete(oldest.value)
      this.decodeEnqueueTimes.delete(oldest.value)
      this.decodeBeginTimes.delete(oldest.value)
    }

    try {
      this.decodeBeginTimes.set(chunkTs, performance.now())
      this.decoder.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: chunkTs,
          data: feed,
        }),
      )
    } catch (e) {
      this.reportDecodeError(e, this.lastFedKey)
      this.decodeStartTimes.delete(chunkTs)
      this.decodeEnqueueTimes.delete(chunkTs)
      this.decodeBeginTimes.delete(chunkTs)
      // A synchronously rejected keyframe with zero decoded output means the
      // stream itself is undecodable — the async error callback never fires
      // for these, so escalate to codec steering here (bounded, once).
      if (key && this.decodedSinceConfigure === 0 && !this.steerFired) {
        this.syncKeyFails++
        if (this.syncKeyFails >= STEER_KEY_BUDGET) {
          this.fireSteer(codec, `${STEER_KEY_BUDGET} rejected keyframes`)
        }
      }
    }
  }

  private fireSteer(codec: string, reason: string): void {
    if (this.steerFired) return
    this.steerFired = true
    this.syncKeyFails = 0
    console.warn(`[decoder] ${codec} stream undecodable (${reason}, 0 frames out), steering to another codec`)
    this.onStreamUndecodable?.(codec)
  }

  // Decode-failure accounting with console dedup: identical errors are counted
  // and logged at most once per 5s so a bad keyframe doesn't flood the console
  // (the pre-existing spam the user saw). Key-vs-delta split is exposed via
  // stats for the connection panel and the session journal.
  private reportDecodeError(e: unknown, key: boolean): void {
    if (key) this.keyErrors++
    else this.deltaErrors++
    this.decodeErrorLogCount++
    const now = performance.now()
    if (now - this.lastDecodeErrorLogAt > 5000) {
      this.lastDecodeErrorLogAt = now
      const kind = key ? 'keyframe' : 'delta'
      console.error(
        `[decoder] decode error (${kind}, x${this.decodeErrorLogCount} total, ` +
          `${this.keyErrors} key / ${this.deltaErrors} delta, fed ${this.lastFedDetail})`,
        e,
      )
      this.decodeErrorLogCount = 0
    }
  }

  // chunks above the watermark on several consecutive units) and this access
  // unit is a delta, drop it (and every frame until a keyframe arrives) so the
  // picture catches up instead of compounding delay.
  // decodeQueueSize is only valid while the decoder is configured; reading it
  // on a closed/errored codec throws and would spam the console during reinit.
  private initDecoder(codec: string): Promise<void> {
    if (this.initFailures >= MAX_INIT_FAILURES || !!this.fatalCodec) return Promise.resolve()
    if (this.pendingInitCodec === codec) return Promise.resolve()
    // The engine already proved this codec undecodable — never re-probe it
    // (reset(), fallbacks and stale packets all end up here).
    if (this.failedCodecs.has(codec)) return Promise.resolve()
    this.lastInitAt = performance.now()

    const codecString = CODEC_STRINGS[codec]
    if (!codecString) {
      console.warn('[decoder] unsupported codec:', codec)
      return Promise.resolve()
    }

    // Taking over the decode session: close whatever is live so no stale
    // decoder can surface errors after we moved on.
    this.safeClose()
    this.currentCodec = ''
    this.frameCount = 0
    this.decodeStartTimes.clear()
    this.decodeEnqueueTimes.clear()
    this.decodeBeginTimes.clear()
    this.needsReinit = false

    const gen = ++this.initGen
    this.pendingInitCodec = codec

    return this.pickConfig(gen, codecString).then((cfg) => {
      if (gen !== this.initGen || !!this.fatalCodec) return
      this.pendingInitCodec = ''

      if (!cfg) {
        // Deterministic failure — no config the engine will accept. Retrying
        // with the same options would just loop forever on such engines.
        this.focusError(codec, codecString)
        return
      }

      if (this.initAttemptError(gen)) return

      let decoder: VideoDecoder
      try {
        decoder = new VideoDecoder({
          output: (frame) => {
            const now = performance.now()
            // A decoded frame is proof this configuration actually works, so a
            // single transient error no longer counts against the retry cap —
            // and the stream is provably decodable, so steering stands down.
            this.initFailures = 0
            this.syncKeyFails = 0
            this.asyncErrBurst = 0
            this.decodedSinceConfigure++
            // Pure decode time (decode() call -> output). Arrival -> output
            // stays available as queue wait below; the two must not mix or
            // auto-quality blames the decoder for network backlog.
            const beginTime = this.decodeBeginTimes.get(frame.timestamp)
            if (beginTime !== undefined) {
              this.recentDecodeTimes.push(now - beginTime)
              if (this.recentDecodeTimes.length > 60) this.recentDecodeTimes.shift()
              this.decodeBeginTimes.delete(frame.timestamp)
            }
            this.decodeStartTimes.delete(frame.timestamp)
            // Queue wait = reassembly/backlog time for this unit (arrival →
            // decode() call), stored at queue time.
            const enqueueWait = this.decodeEnqueueTimes.get(frame.timestamp)
            if (enqueueWait !== undefined) {
              this.recentQueueWaits.push(enqueueWait)
              if (this.recentQueueWaits.length > 60) this.recentQueueWaits.shift()
              this.decodeEnqueueTimes.delete(frame.timestamp)
            }
            this.lastFrameAt = now
            this.fpsFrameCount++
            const elapsed = (now - this.fpsWindowStart) / 1000
            if (elapsed >= 1.0 && this.fpsWindowStart > 0) {
              this.onStats?.({
                fps: Math.round((this.fpsFrameCount / elapsed) * 10) / 10,
                frameIntervalMs:
                  this.recentIntervals.length > 0
                    ? this.recentIntervals.reduce((a, b) => a + b, 0) / this.recentIntervals.length
                    : 0,
                decodeTimeMs:
                  this.recentDecodeTimes.length > 0
                    ? Math.round(
                        (this.recentDecodeTimes.reduce((a, b) => a + b, 0) /
                          this.recentDecodeTimes.length) *
                          10,
                      ) / 10
                    : 0,
                lastFrameAt: this.lastFrameAt,
                queueSize: this.lastQueueSize,
                queueDrops: this.queueDrops,
                queueWaitMs:
                  this.recentQueueWaits.length > 0
                    ? Math.round(
                        (this.recentQueueWaits.reduce((a, b) => a + b, 0) /
                          this.recentQueueWaits.length) *
                          10,
                      ) / 10
                    : 0,
                keyErrors: this.keyErrors,
                deltaErrors: this.deltaErrors,
              })
              this.fpsFrameCount = 0
              this.fpsWindowStart = now
            }

            // Rebuild only when the VISIBLE size changes. Coded-size padding
            // (e.g. 1920 ↔ 1984 from x264 alignment) wobbles on its own and
            // the decoder absorbs it — rebuilding on it caused reinit loops
            // with a black gap and a lost keyframe on every flap.
            if (
              this.lastDisplayWidth !== 0 &&
              (frame.displayWidth !== this.lastDisplayWidth || frame.displayHeight !== this.lastDisplayHeight)
            ) {
              console.warn(
                `[decoder] display size ${this.lastDisplayWidth}x${this.lastDisplayHeight} -> ${frame.displayWidth}x${frame.displayHeight}, reiniting`,
              )
              this.needsReinit = true
              this.onReinit?.()
            }
            this.lastCodedWidth = frame.codedWidth
            this.lastCodedHeight = frame.codedHeight
            this.lastDisplayWidth = frame.displayWidth
            this.lastDisplayHeight = frame.displayHeight

            this.onFrame(frame)
            frame.close()
          },
          error: (e) => {
            this.reportDecodeError(e, this.lastFedKey)
            // A burst of async failures while output flows means a poisoned
            // GOP (dropped reference): one bounded keyframe request resyncs
            // (the session rate-limits it). Zero-output streams escalate via
            // the strategy cycle instead.
            if (this.decodedSinceConfigure > 0) {
              this.asyncErrBurst++
              if (this.asyncErrBurst >= GOP_RESYNC_BURST) {
                this.asyncErrBurst = 0
                console.warn('[decoder] async error burst with output flowing, requesting keyframe resync')
                this.onReinit?.()
              }
            }
            if (this.fatalCodec || gen !== this.initGen) return
            if (isUnsupportedConfigurationError(e)) {
              // Configure() was accepted but the engine can't actually use this
              // codec/config. Permanent for this codec — tell
              // the session to switch encoder instead of loop-reinitialising.
              this.failedCodecs.add(codec)
              this.safeClose()
              this.currentCodec = ''
              console.warn(`[decoder] ${codec} unusable in this engine, falling back`)
              this.onCodecUnsupported?.(codec)
              return
            }
            this.initFailures += 1
            if (this.initFailures >= MAX_INIT_FAILURES) {
              this.focusError(codec, codecString)
              return
            }
            this.needsReinit = true
            this.onReinit?.()
          },
        })
        decoder.configure(cfg)
      } catch (e) {
        console.error('[decoder] configure failed', e)
        if (isUnsupportedConfigurationError(e)) {
          // Synchronous twin of the async case above (other engines).
          this.failedCodecs.add(codec)
          this.safeClose()
          this.currentCodec = ''
          console.warn(`[decoder] ${codec} unusable in this engine, falling back`)
          this.onCodecUnsupported?.(codec)
          return
        }
        // Sync throw on configure (engine without isConfigSupported or a
        // rejected option): try once more on the next packet — but never loop.
        this.initFailures += 1
        if (this.initFailures >= MAX_INIT_FAILURES) {
          this.focusError(codec, codecString)
          return
        }
        return
      }

      if (this.initFailures >= MAX_INIT_FAILURES || this.fatalCodec) {
        try {
          if (decoder.state !== 'closed') decoder.close()
        } catch {
          // ignore
        }
        return
      }

      this.decoder = decoder
      this.currentCodec = codec
      // Fresh setup: no output yet, steering counters rearmed for this config.
      this.decodedSinceConfigure = 0
      this.syncKeyFails = 0
      this.asyncErrBurst = 0
      this.steerFired = false
      // configure() was just issued: the decoder will only accept a key chunk
      // next, so gate deltas until the first key frame arrives. Ask once
      // (unthrottled) for that keyframe — bounded, one per configure.
      this.awaitingFirstKey = true
      this.onConfigured?.(codec)
      this.onNeedFirstKey?.()
      this.fpsWindowStart = performance.now()
      this.fpsFrameCount = 0
    }).catch((e) => {
      console.error('[decoder] init failed', e)
      this.pendingInitCodec = ''
      this.initFailures += 1
      if (this.initFailures >= MAX_INIT_FAILURES) this.focusError(codec, codecString)
    })
  }

  private initAttemptError(gen: number): boolean {
    return gen !== this.initGen
  }

  private focusError(codec: string, codecString: string): void {
    this.initFailures = MAX_INIT_FAILURES
    this.fatalCodec = codecString
    console.error('[decoder] video decode unsupported:', codec, codecString)
    this.onFatal?.(codec)
  }

  // Probes whether the engine can decode `codecString` and returns the most
  // compatible config, preferring the low-latency option. Candidates are
  // probed concurrently and picked in preference order, so a slow media-stack
  // spin-up doesn't serialize into seconds of black screen.
  private async pickConfig(gen: number, codecString: string): Promise<VideoDecoderConfig | null> {
    if (typeof VideoDecoder === 'undefined') return null
    const candidates: VideoDecoderConfig[] = [
      { codec: codecString, optimizeForLatency: true },
      { codec: codecString },
      { codec: codecString, hardwareAcceleration: 'prefer-software' },
    ]
    if (typeof VideoDecoder.isConfigSupported !== 'function') return candidates[0]
    const results = await Promise.all(
      candidates.map((cfg) =>
        VideoDecoder.isConfigSupported(cfg)
          .then((res) => (res.supported ? cfg : null))
          .catch(() => null),
      ),
    )
    for (const cfg of results) {
      if (gen !== this.initGen) return null
      if (cfg) return cfg
    }
    return null
  }

  // A codec that errored out may have been auto-closed by the engine — calling
// .close() on it throws InvalidStateError and used to crash the render loop.
private safeClose(): void {
    const d = this.decoder
    this.decoder = null
    if (!d) return
    try {
      if (d.state !== 'closed') d.close()
    } catch {
      // already closed — ignore
    }
  }

  close(): void {
    this.initGen++
    this.pendingInitCodec = ''
    this.flushPending(true)
    this.safeClose()
    this.currentCodec = ''
    this.awaitingFirstKey = false
    this.frameCount = 0
    this.decodeStartTimes.clear()
    this.decodeEnqueueTimes.clear()
    this.decodeBeginTimes.clear()
    this.recentQueueWaits = []
    this.queueDrops = 0
    this.lastQueueSize = 0
    this.keyErrors = 0
    this.deltaErrors = 0
    this.syncKeyFails = 0
    this.decodedSinceConfigure = 0
    this.steerFired = false
    this.asyncErrBurst = 0
    this.needsReinit = false
    this.lastCodedWidth = 0
    this.lastCodedHeight = 0
    this.lastDisplayWidth = 0
    this.lastDisplayHeight = 0
  }
}