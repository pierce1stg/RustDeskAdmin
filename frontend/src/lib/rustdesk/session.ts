import nacl from './vendor/tweetnacl/nacl-fast'
import * as pb from './proto'
import {
  boxKeyPair,
  hashRustdeskPassword,
  makeSessionNonce,
  randomBytes,
  sealSymmetricKey,
} from './crypto'
import { probeBrowserCodecs, getCachedSupport, provenForPixels } from './codecs'
import { describeKeyEvent } from './keymap'

export interface SessionConfig {
  address: string // domain, e.g. "app.example.com"
  serverKey: string // base64 server public key (licence_key)
  peerId: string
  password: string
  // When true, field 2 (password) is omitted from LoginRequest entirely
  // instead of sending an empty hash — some host builds react differently.
  omitPassword?: boolean
  relayServer: string // "address:21117"
  wssIdPort?: number // hbbs websocket TLS port (default 21118)
  wssRelayPort?: number // hbbr websocket TLS port (default 21119)
  video?: pb.SessionVideoOptions // initial quality/fps/audio selection
  auto?: boolean // network-adaptive quality (see setAutoMode)
  showRemoteCursor?: boolean // ask the host to stream its cursor (default true)
  codec?: 'auto' | pb.CodecName // manual codec preference, honoured from login
  clientName?: string // LoginRequest.my_name shown on the host (default 'Web Browser')
}

export interface VideoPacket {
  codec: string
  key: boolean
  data: Uint8Array
  display: number
  pts: number
}

export interface RemotePeerInfo {
  username: string | null
  hostname: string | null
  platform: string | null
  width: number
  height: number
  display: number // current display index (0-based)
  displayCount: number // total number of peer displays/monitors
  originX: number // current display origin in the virtual desktop (absolute coords base)
  originY: number
  version?: string | null // host RustDesk version, when reported
  allDisplays?: pb.DisplayInfo[] // full monitor topology, when reported
}

export interface SessionStats {
  downKbps: number // bytes received (wire) per second, kbit/s
  upKbps: number // bytes sent (wire) per second, kbit/s
  fps: number // rendered video frames per second (decoder), wire fallback
  pingMs: number | null // RTT to the host through the relay (test_delay mirror)
  decodeMs: number | null // average WebCodecs decode time (from the decoder)
  paintMs: number | null // average canvas drawImage time (from the screen)
  queueDrops: number // cumulative decoder-backlog delta drops (catch-up)
  queueWaitMs: number | null // average reassembly/backlog wait per unit
  keyErrors: number // cumulative corrupt keyframes (reassembly/description)
  deltaErrors: number // cumulative corrupt deltas (usually network loss)
  codec: string | null // actual streaming codec of the last video frame (fact, not preference)
}

// Journal levels (info/warn/error always recorded by default, debug opt-in)
// and categories (filter chips in the session log panel).
export type LogLevel = 'info' | 'warn' | 'error' | 'debug'
export type LogCategory =
  | 'connection'
  | 'codec'
  | 'video'
  | 'decoder'
  | 'input'
  | 'clipboard'
  | 'cursor'
  | 'system'
  | 'ui' // user actions in the session toolbar (audit trail)

export type SessionEvent =
  | { type: 'status'; status: 'connecting' | 'connected' | 'disconnected'; message?: string }
  | { type: 'error'; message: string }
  | { type: 'two-fa'; message: string }
  // The host has a LoginRequest but hasn't answered for a while — most likely
  // a human approval dialog ("Accept sessions via click") is open there.
  | { type: 'approval-pending' }
  // Journal entry. Level/category travel with the event so the UI can drop
  // disabled classes BEFORE recording (never stored, never rendered).
  | { type: 'log'; level: LogLevel; category: LogCategory; message: string }
  | { type: 'peer-info'; info: RemotePeerInfo }
  | { type: 'video'; packet: VideoPacket }
  | { type: 'audio'; data: Uint8Array }
  | { type: 'clipboard'; text: string }
  | { type: 'chat'; from: 'host'; text: string }
  | { type: 'cursor'; cursor: pb.ParsedCursor }
  | { type: 'cursor_position'; x: number; y: number }
  | { type: 'stats'; stats: SessionStats }

export class WebRustDeskSession {
  private config: SessionConfig
  private onEvent: (ev: SessionEvent) => void
  private videoHandler: ((packet: VideoPacket) => void) | null = null

  private idWs: WebSocket | null = null
  private relayWs: WebSocket | null = null
  private idDone = false
  private closed = false

  private uuid = ''
  private symmetricKey: Uint8Array | null = null
  private relaySessionStarted = false
  private sendSeq = 0
  private recvSeq = 0
  // First-flight reassembly: the opening relay message sometimes arrives
  // split across frames or glued to the next one.
  private firstFrameBuf: Uint8Array | null = null
  private firstFrameTimer: ReturnType<typeof setTimeout> | null = null
  // Safety net while waiting for relay_response after a successful punch:
  // without it a silent hbbs leaves "connecting" forever (connectTimer only
  // covers the whole 20s).
  private relayWaitTimer: ReturnType<typeof setTimeout> | null = null

  // True while the host waits for our TOTP code ("2FA Required"). The session
  // must stay alive; a failed code is reported as another login error and we
  // keep waiting instead of bailing out.
  private awaiting2FA = false

  // Last absolute remote-pointer position reported by the host (CursorPosition
  // = Message field 13). Anchors the touch "pointer mode" indicator and clicks.
  private remoteCursorPos: { x: number; y: number } | null = null

  // id -> cursor bitmap cache. The host sends the full CursorData once per id
  // and then only `cursor_id` references; we substitute from here.
  private cursorCache = new Map<number, pb.ParsedCursor>()

  private recvBytes = 0
  private sentBytes = 0
  private frameCount = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null

  // Debug mode: verbose session journal (opt-in via localStorage rd_debug=1 or
  // ?debug=1 in the URL). Logs handshake traffic, message kinds (once each),
  // peer info, and sent key events so connection/input problems are visible.
  private readonly debugDefault = debugEnabled()
  // Live debug flag: the journal's "debug" chip flips it on the running
  // session (the chip alone used to be a no-op without ?debug=1 at load).
  private debug = this.debugDefault
  private dbgKinds = new Set<string>()
  private dbgKeyCount = 0
  private dbgFrameLogged = false

  // Host encode capabilities (PeerInfo.encoding) and the per-session decoder
  // codec fallback: when the WebCodecs engine rejects the negotiated codec
  // we re-advertise
  // supported_decoding mid-session so the host switches its encoder (VP8/VP9).
  // Fallbacks run in AUTO mode only: a manually chosen codec is the user's
  // explicit will — instead of silently switching away we report failure and
  // let the UI warn with a "back to Auto" action.
  private manualCodec: pb.CodecName | null = null
  // When the current manual pin was set (ms epoch): the host needs seconds
  // to apply a new prefer, so a mismatch right after the pin is a
  // transition, not defiance. Overrule releases only after the grace below.
  private manualPinnedAt = 0
  // A manual pin is literal: the user (or the panel default) asked for THIS
  // codec, so fallbacks never silently switch away from it — the caller
  // shows the fatal banner with a "back to Auto" action instead. Fallbacks
  // and steering run in AUTO mode only.
  private manualOverruled = false
  private peerEncoding: NonNullable<pb.ParsedPeerInfo['encoding']> | null = null
  // Actual codec of the most recent video frame (wire truth for the stats
  // badge). Reset per connection; null until the first frame arrives.
  private lastVideoCodec: string | null = null
  // G2 size-cap exclusions already written to the journal (one line per
  // codec×resolution per connection — the filter itself runs repeatedly).
  private loggedSizeCaps = new Set<string>()
  private codecFailed = new Set<string>()
  private fallbackPending: {
    failed: string
    target: string
    timer: ReturnType<typeof setTimeout>
    nudged: boolean
  } | null = null
  // Probe result used for the login supported_decoding; resolved once at
  // connect() so handleHash() can respect browser codec limits from the start.
  private loginDecodingPromise: Promise<pb.SupportedDecodingOptions | undefined> = Promise.resolve(undefined)
  // Latest resolved probe value (including the immediate manual-preference
  // one). handleHash() sends LoginRequest without waiting for the probe —
  // the tap below upgrades the host if the probe lands after the login.
  private probeResult: pb.SupportedDecodingOptions | undefined = undefined
  private loginSent = false
  // Approval watchdog: after LoginRequest goes out, silence most likely means
  // a human "Accept / Dismiss" dialog on the host. Nudge the UI once so it
  // shows "waiting for host" instead of a dead spinner.
  private approvalTimer: ReturnType<typeof setTimeout> | null = null
  private approvalNotified = false
  // One-shot re-announce of stream options if the host stays silent right
  // after login (second concurrent stream case).
  private loginOptionTimer: ReturnType<typeof setTimeout> | null = null
  private loginOptionEarlyTimer: ReturnType<typeof setTimeout> | null = null
  // Overall connect watchdog: a hanging handshake must surface as an error
  // (and feed the page reconnect) instead of a forever "connecting" state.
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  // Stream preferences (quality/fps/audio). Merged from SessionConfig.video on
  // construction; later driven by the panel selects and the low-latency toggle.
  private videoOptions: pb.SessionVideoOptions = { quality: 3, fps: 30, audioEnabled: false }
  private lastSent = { quality: 0, fps: 0, audioEnabled: true } // sent option identity
  private keyframeRateLimitMs = 2000

  // Network-adaptive quality (conservative): picks a target from measured
  // throughput/ping plus decoder health, switching only after the new target
  // is observed three ticks in a row. Skips evaluation with no fresh frames
  // (static picture / pause must not read as a bad network) and cools down
  // after manual changes so it never fights the user.
  private autoMode = false
  private autoTimer: ReturnType<typeof setInterval> | null = null
  private autoTarget = { quality: 3, fps: 30 }
  private autoDiffTicks = 0
  private autoCooldownUntil = 0
  // Consecutive auto ticks with queueWaitMs > 300ms (reset below it, on
  // auto (re)enable and on manual stream changes). Feeds the deep floor.
  private autoStuckTicks = 0
  private lastAutoKbps = 0
  private lastTickHadFrames = false
  private lastAutoQueueDrops = 0
  private recvHistory: number[] = []

  // Ping (RTT) via mirrored TestDelay from the host, smoothed with EWMA.
  private pingRttMs: number | null = null
  private pingSentAt = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null

  // Decode/paint/queue data published by the components between stats ticks.
  private externalStats: {
    decodeMs: number | null
    paintMs: number | null
    renderFps: number | null
    queueDrops: number
    queueWaitMs: number | null
    keyErrors: number
    deltaErrors: number
  } = {
    decodeMs: null,
    paintMs: null,
    renderFps: null,
    queueDrops: 0,
    queueWaitMs: null,
    keyErrors: 0,
    deltaErrors: 0,
  }

  // Display layout of the controlled peer, tracked so mouse coordinates can be
  // translated into the absolute virtual-desktop space and the switch-display
  // button can send an explicit (in-range) target index.
  private displays: pb.DisplayInfo[] = []
  private currentDisplay = 0
  private baseInfo = { username: null, hostname: null, platform: null } as {
    username: string | null
    hostname: string | null
    platform: string | null
  }
  private baseVersion: string | null = null

  // Display switch state. The display we watch is chosen by the client (on the
  // switch button); the host keeps our connection subscribed to every monitor's
  // video service and streams all of them at once (multi-UI sessions never
  // unsubscribe the old monitor), so video frames whose `display` does not match
  // our choice are dropped instead of being followed. `Misc.switch_display`
  // broadcasts from other monitors' services are also ignored as state.
  private switchPendingTarget: number | null = null
  private switchPendingTimer: ReturnType<typeof setTimeout> | null = null
  private gotTargetFrames = false
  private previousDisplay = 0
  private lastKeyframeRequestAt = 0

  // Connected flag + video-stall watchdog. lastVideoAt tracks the wall-clock
  // time of the most recent video frame (any codec/display). When frames stop
  // for ≥4 s while connected, a one-shot refresh_video + cursor re-subscribe
  // nudges the host back without requiring a full reconnect.
  private connected = false
  private lastVideoAt = 0
  private videoStallNotified = false

  constructor(config: SessionConfig, onEvent: (ev: SessionEvent) => void) {
    this.config = config
    this.onEvent = onEvent
    if (config.video) this.videoOptions = { quality: 3, fps: 30, audioEnabled: false, ...config.video }
  }

  setVideoHandler(fn: (packet: VideoPacket) => void): void {
    this.videoHandler = fn
  }

  connect(): void {
    this.emit({ type: 'status', status: 'connecting' })
    this.startStats()
    this.resetCodecState()
    this.autoStuckTicks = 0
    this.baseInfo = { username: null, hostname: null, platform: null }
    this.baseVersion = null
    this.manualCodec =
      this.config.codec && this.config.codec !== 'auto' ? (this.config.codec as pb.CodecName) : null
    this.manualPinnedAt = Date.now()
    // One-line codec diagnostics for the session journal (helps "codec X
    // unsupported" reports: probe truth vs runtime failure).
    void probeBrowserCodecs((m) => this.log(m, 'codec')).then((s) => {
      if (this.closed) return
      const ok = (Object.keys(s) as Array<keyof typeof s>).filter((k) => s[k])
      this.log(`browser codecs: ${ok.join(',') || 'none'}`, 'codec')
    })
    this.loginSent = false
    this.probeResult = undefined
    this.loginDecodingPromise = this.probeLoginDecoding()
    // If the probe lands after LoginRequest went out, upgrade the host right
    // away instead of waiting for a runtime fallback mid-stream.
    void this.loginDecodingPromise.then((res) => {
      this.probeResult = res ?? undefined
      if (res && this.loginSent && !this.connected && !this.closed) {
        this.sendRelayMessage(pb.encodeSupportedDecoding(res))
      }
    })
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (this.closed || this.connected) return
      // A sent-but-unanswered login most likely means the host side never
      // acted on its approval dialog — say so instead of a bare timeout.
      if (this.loginSent) this.fail('the host did not respond — it may be waiting on its approval dialog')
      else this.fail('connect timed out')
    }, 20000)
    this.dbg(`connect peer=${this.config.peerId} server=${this.config.address}:${this.config.wssIdPort ?? 21118} encrypted=${this.config.serverKey ? 'yes' : 'no'}`, 'connection')
    const url = `wss://${this.config.address}:${this.config.wssIdPort ?? 21118}/ws/id`
    this.log(`hbbs: ${url}`, 'connection')
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      this.fail(`cannot open ${url}: ${String(e)}`)
      return
    }
    this.idWs = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      this.log('hbbs connected, punch_hole_request', 'connection')
      ws.send(pb.encodePunchHoleRequest({
        peerId: this.config.peerId,
        licenceKey: this.config.serverKey,
      }))
    }
    ws.onmessage = (ev) => {
      try {
        this.handleIdMessage(new Uint8Array(ev.data as ArrayBuffer))
      } catch (e) {
        this.fail(`hbbs decode error: ${String(e)}`)
      }
    }
    ws.onerror = () => {
      this.dbg('hbbs ws error', 'connection')
      this.fail('hbbs WebSocket error')
    }
    ws.onclose = () => {
      if (!this.idDone && !this.closed) {
        this.dbg(`hbbs ws closed readyState=${ws.readyState}`, 'connection')
        this.fail('hbbs closed connection')
      }
    }
  }

  private handleIdMessage(data: Uint8Array): void {
    const resp = pb.parseRendezvous(data)

    if (resp.type === 'relay_response') {
      if (resp.refuseReason) {
        this.fail(`relay refused: ${resp.refuseReason}`)
        return
      }
      if (!resp.relayServer || !resp.uuid) {
        this.fail('relay_response missing relay/uuid')
        return
      }
      // Server-issued uuid (official flow) — never self-generated.
      this.uuid = resp.uuid
      if (!resp.version) this.warn('relay_response without version (old host)', 'connection')
      this.log(`relay_response: relay=${resp.relayServer} uuid=${this.uuid}`, 'connection')
      this.finishRendezvous()
      return
    }

    // punch_hole_response carries errors only; success just means "wait for
    // the relay_response that follows" (official flow — no RequestRelay to
    // hbbs, no self-made uuid, no sleep hacks).
    if (resp.failure !== 0 || !resp.relayServer) {
      const detail = resp.failureText && resp.failureText !== 'EMPTY' ? `: ${resp.failureText}` : ''
      this.fail(`peer unavailable${detail}`)
      return
    }

    this.log(`peer found on relay ${resp.relayServer}, waiting for relay_response`, 'connection')
    if (this.relayWaitTimer) clearTimeout(this.relayWaitTimer)
    this.relayWaitTimer = setTimeout(() => {
      this.relayWaitTimer = null
      if (!this.idDone && !this.closed) this.fail('no relay response from hbbs')
    }, 10000)
  }

  private finishRendezvous(): void {
    if (this.idDone) return
    this.idDone = true
    if (this.relayWaitTimer) {
      clearTimeout(this.relayWaitTimer)
      this.relayWaitTimer = null
    }
    this.closeId()
    this.openRelay()
  }

  private closeId(): void {
    if (!this.idWs) return
    this.idWs.onclose = null
    this.idWs.onerror = null
    try {
      this.idWs.close()
    } catch {
      // ignore
    }
    this.idWs = null
  }

  private openRelay(): void {
    this.dbg(`open relay url=${this.config.address}:${this.config.wssRelayPort ?? 21119}`, 'connection')
    const url = `wss://${this.config.address}:${this.config.wssRelayPort ?? 21119}/ws/relay`
    this.log(`hbbr: ${url}`, 'connection')
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      this.fail(`cannot open ${url}: ${String(e)}`)
      return
    }
    this.relayWs = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      this.log('hbbr connected, request_relay', 'connection')
      // Single RequestRelay on the relay socket with the server-issued uuid
      // (official flow). No peerId/relayServer extras.
      ws.send(pb.encodeRequestRelay({
        uuid: this.uuid,
        licenceKey: this.config.serverKey,
      }))
    }
    ws.onmessage = (ev) => {
      this.recvBytes += (ev.data as ArrayBuffer).byteLength
      try {
        this.handleRelayMessage(new Uint8Array(ev.data as ArrayBuffer))
      } catch (e) {
        this.errorLog(`relay decode error: ${String(e)} raw=${toHex(ev.data as ArrayBuffer)}`, 'connection')
      }
    }
    ws.onerror = () => {
      this.dbg('relay ws error', 'connection')
      this.fail('relay WebSocket error')
    }
    ws.onclose = () => {
      this.dbg(`relay ws closed readyState=${ws.readyState}`, 'connection')
      if (!this.closed) this.emit({ type: 'status', status: 'disconnected' })
    }
  }

  getCursorPos(): { x: number; y: number } | null {
    return this.remoteCursorPos
  }

  private handleRelayMessage(raw: Uint8Array): void {
    // First flight may arrive split across frames or glued together —
    // accumulate until a complete envelope parses instead of dying on a
    // partial/coalesced first message.
    if (!this.relaySessionStarted) {
      this.firstFrameBuf = concatBytes(this.firstFrameBuf, raw)
      const buf = this.firstFrameBuf
      // 1. strict whole-buffer parse (normal case)
      try {
        const first = pb.parseMessage(buf)
        this.firstFrameBuf = null
        this.clearFirstFrameTimer()
        this.relaySessionStarted = true
        this.dispatchFirstMessage(first)
        return
      } catch {
        // fall through to tolerant paths below
      }
      // 2. signed_id envelope scan (tolerates trailing garbage after it)
      const env = extractSignedIdEnvelope(buf)
      if (env) {
        this.firstFrameBuf = null
        this.clearFirstFrameTimer()
        this.relaySessionStarted = true
        this.log('signed_id via envelope scan (tolerant)', 'connection')
        this.handleSignedId(env.payload)
        const rest = buf.slice(env.consumed)
        if (rest.length > 0) {
          this.log(`trailing ${rest.length}b after signed_id, feeding as next message`, 'connection')
          this.handleRelayMessage(rest)
        }
        return
      }
      // 3. incomplete? wait briefly for the rest instead of failing at once.
      if (buf.length > 1024 * 1024) {
        this.firstFrameBuf = null
        this.clearFirstFrameTimer()
        this.fail('unparseable first relay message')
        return
      }
      if (!this.firstFrameTimer) {
        // TCP splits/coalescing resolve in milliseconds — fail fast instead
        // of stalling every connect by 2s on a genuinely broken first flight.
        this.firstFrameTimer = setTimeout(() => {
          this.firstFrameTimer = null
          if (!this.relaySessionStarted && !this.closed) {
            this.firstFrameBuf = null
            this.fail('incomplete first relay message')
          }
        }, 400)
      }
      return
    }

    let bytes = raw
    if (this.symmetricKey) {
      const nonce = makeSessionNonce(++this.recvSeq)
      const opened = nacl.secretbox.open(raw, nonce, this.symmetricKey)
      if (!opened) {
        this.errorLog(`decrypt failed (seq=${this.recvSeq})`, 'connection')
        return
      }
      bytes = opened
    }

    const msg = pb.parseMessage(bytes)
    this.dbgOnce('recv', msg, 'connection')
    switch (msg.kind) {
      case 'hash':
        void this.handleHash(msg.salt, msg.challenge)
        return
      case 'login_response':
        this.handleLoginResponse(msg)
        return
      case 'peer_info':
      this.dbg(
        `peer_info: user=${msg.peerInfo?.username ?? '?'} host=${msg.peerInfo?.hostname ?? '?'} ` +
          `platform=${msg.peerInfo?.platform ?? '?'} version=${msg.peerInfo?.version ?? '?'} ` +
          `displays=${msg.peerInfo?.displays.length ?? 0}` +
          (msg.peerInfo?.encoding
            ? ` encoding=${Object.entries(msg.peerInfo.encoding)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(',')}`
            : ''),
        'connection',
      )
        this.emitPeerInfo(msg.peerInfo, false)
        return
      case 'video_frame':
        this.handleVideoFrame(msg)
        return
      case 'audio_frame':
        // Audio was removed from the web client (disable_audio is always Yes,
        // so hosts should not stream). Drop stragglers silently.
        return
      case 'test_delay':
        if (msg.fromClient) {
          // Our ping mirror came back — measure RTT locally against pingSentAt.
          // The wire `time` field is ignored: small JS timeouts truncate it to
          // a 32-bit value, which would skew the figure to ~Date.now().
          const rtt = Date.now() - this.pingSentAt
          this.pingSentAt = 0
          // Clamp: a backgrounded tab or a long network hiccup can delay the
          // echo by minutes; such a sample would poison the EWMA for a long
          // time. Anything above 5s is not a usable RTT figure.
          if (rtt >= 0 && rtt <= 5000) {
            this.pingRttMs =
              this.pingRttMs === null ? rtt : Math.round(this.pingRttMs * 0.7 + rtt * 0.3)
          }
        } else {
          // The host's own probe (from_client=false). Reply so the host can
          // measure its round trip and run its QoS adaptation.
          this.sendRelayMessage(pb.encodeTestDelayEcho(msg.time))
        }
        return
      case 'clipboard':
        this.handleClipboard(msg.clipboard)
        return
      case 'cursor_data':
        if (msg.cursor) {
          if (msg.cursor.id > 0) this.cursorCache.set(msg.cursor.id, msg.cursor)
          this.emit({ type: 'cursor', cursor: msg.cursor })
        } else {
          this.warn(`cursor_data arrived but unparsed (${bytes.length} bytes)`, 'cursor')
        }
        return
      case 'cursor_position':
        if (msg.position) {
          this.remoteCursorPos = { x: msg.position.x, y: msg.position.y }
          this.emit({ type: 'cursor_position', x: msg.position.x, y: msg.position.y })
        }
        return
      // The host re-sends the cursor by id reference only; replay our cached
      // bitmap so repeated cursor shapes keep rendering without new payloads.
      case 'cursor_id':
        {
          const cached = this.cursorCache.get(msg.id)
          if (cached) this.emit({ type: 'cursor', cursor: cached })
          else this.log(`cursor_id unknown: ${msg.id}`, 'cursor')
        }
        return
      case 'misc':
        this.handleMisc(msg.fields)
        return
      default:
        if (msg.kind === 'unknown') {
          const info = msg.fields.map((f) => `${f.field}:${f.wireType}`).join(' ')
          // Clipboard-file (cliprdr, field 20) chatter the web client doesn't
          // implement — skip silently instead of spamming the journal.
          if (info !== '20:2') this.log(`relay msg (unhandled fields=${info})`, 'connection')
        }
        return
    }
  }

  private handleSignedId(idBytes: Uint8Array): void {
    const found = extractIdPk(idBytes)
    if (!found) {
      // Unparseable SignedId (seen as systematic ~96B truncated envelopes):
      // fall back exactly like the official client — empty PublicKey, then a
      // plain Hash login when the host answers. Full bytes logged once for
      // post-mortem instead of dying here.
      this.errorLog(`SignedId unparseable (${idBytes.length}b), full=${hexFull(idBytes)} — plain fallback`, 'connection')
      this.sendRelayRaw(pb.encodeEmptyPublicKey())
      return
    }
    if (found.offset !== 64) this.log(`SignedId IdPk at offset ${found.offset} (non-standard layout)`, 'connection')
    const peerPk = found.idPk.pk
    if (!peerPk || peerPk.length !== 32) {
      this.fail('bad peer public key')
      return
    }

    const symKey = randomBytes(nacl.secretbox.keyLength)
    const ephemeral = boxKeyPair()
    const sealed = sealSymmetricKey(symKey, peerPk, ephemeral.secretKey)
    this.sendRelayRaw(pb.encodePublicKey(ephemeral.publicKey, sealed))

    this.symmetricKey = symKey
    this.sendSeq = 0
    this.recvSeq = 0
    this.log('encrypted session established', 'connection')
  }

  private async handleHash(salt: Uint8Array, challenge: Uint8Array): Promise<void> {
    const password = this.config.omitPassword ? null : await hashRustdeskPassword(this.config.password, salt, challenge)
    const sessionId = Math.floor(Math.random() * 0xffffffff)
    // Non-blocking: send with whatever the probe resolved so far (manual
    // preference resolves in a microtask, so it is always present). A late
    // probe upgrades the host via the tap in connect().
    const supportedDecoding = this.probeResult
    this.loginSent = true
    this.sendRelayMessage(
      pb.encodeLoginRequest(this.config.peerId, password, sessionId, this.videoOptions, supportedDecoding, this.config.clientName),
    )
    this.log('LoginRequest sent', 'connection')
    // If the host doesn't answer promptly it is probably waiting on its
    // human (click-accept mode) — tell the UI to show the waiting state.
    // Cleared by any login response, error, or disconnect.
    if (this.approvalTimer) clearTimeout(this.approvalTimer)
    this.approvalNotified = false
    this.approvalTimer = setTimeout(() => {
      this.approvalTimer = null
      if (!this.connected && !this.closed && !this.awaiting2FA && !this.approvalNotified) {
        this.approvalNotified = true
        this.emit({ type: 'approval-pending' })
      }
    }, 3000)
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer)
      this.firstFrameTimer = null
    }
  }

  private clearApprovalTimer(): void {
    if (this.approvalTimer) {
      clearTimeout(this.approvalTimer)
      this.approvalTimer = null
    }
    this.approvalNotified = false
  }

  // Dispatch an already-parsed opening message (shared by the strict and
  // tolerant first-flight paths below).
  private dispatchFirstMessage(first: pb.ParsedMessage): void {
    if (first.kind === 'signed_id') {
      this.handleSignedId(first.id)
      return
    }
    if (first.kind === 'hash') {
      this.log('plain session (Hash first, no encryption)', 'connection')
      void this.handleHash(first.salt, first.challenge)
      return
    }
    this.fail('unexpected first relay message')
  }

  private handleLoginResponse(msg: pb.ParsedMessage & { kind: 'login_response' }): void {
    this.clearApprovalTimer()
    if (msg.error) {
      // Two-factor step: the host keeps the connection and waits for our
      // Auth2FA message. "Wrong 2FA Code" arrives the same way, so the user can
      // retry without reconnecting.
      if (msg.error === '2FA Required' || msg.error === 'Wrong 2FA Code') {
        this.awaiting2FA = true
        this.emit({ type: 'two-fa', message: msg.error })
        return
      }
      // Click-accept mode: the host opened its Accept/Dismiss dialog and tells
      // clients >= 1.2.0 to wait ("No Password Access" is not a rejection).
      // Stay on the line for the real verdict instead of failing.
      if (msg.error === 'No Password Access') {
        this.log('host asks to wait for approval (click-accept mode)', 'connection')
        this.emit({ type: 'approval-pending' })
        return
      }
      this.fail(msg.error)
      return
    }
    this.awaiting2FA = false
    this.dbg(`login_response OK peerInfo=${!!msg.peerInfo}`, 'connection')
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (msg.peerInfo) this.emitPeerInfo(msg.peerInfo, true)
    this.emit({ type: 'status', status: 'connected' })
    this.connected = true
    this.sendRelayMessage(pb.encodeMiscBool(12)) // video_received
    // Always request the remote cursor from the host (bitmap + position). The
    // UI toggle only controls rendering, so turning it on mid-session shows the
    // cursor immediately (data has been flowing since connect).
    this.setShowRemoteCursor(true)
    if (this.config.auto) this.setAutoMode(true)
    // Explicit OptionMessage right after login: LoginRequest already carried
    // the options, but hosts start a second concurrent encoder stream only on
    // an explicit option update (observed: web picture stays black while a
    // native session runs without it). Follow with the refresh that starts it.
    this.lastSent = { quality: 0, fps: 0, audioEnabled: true }
    this.sendVideoOption()
    // Belt and suspenders, two stages: a fast re-announce (~0.7s) covers a
    // missed burst / second concurrent stream quickly, the 6s one remains the
    // last resort. The stall watchdog covers later gaps.
    if (this.loginOptionTimer) clearTimeout(this.loginOptionTimer)
    if (this.loginOptionEarlyTimer) clearTimeout(this.loginOptionEarlyTimer)
    this.loginOptionEarlyTimer = setTimeout(() => {
      this.loginOptionEarlyTimer = null
      if (this.connected && !this.closed && this.lastVideoAt === 0) {
        this.warn('no frames 0.7s after login, re-sending options', 'video')
        this.lastSent = { quality: 0, fps: 0, audioEnabled: true }
        this.sendVideoOption()
      }
    }, 700)
    this.loginOptionTimer = setTimeout(() => {
      this.loginOptionTimer = null
      if (this.connected && !this.closed && this.lastVideoAt === 0) {
        this.warn('no frames 6s after login, re-sending options', 'video')
        this.lastSent = { quality: 0, fps: 0, audioEnabled: true }
        this.sendVideoOption()
      }
    }, 6000)
    this.log('login OK, video stream requested', 'connection')
  }

  // Submit the TOTP code from the user's authenticator app to a host that is
  // waiting for 2FA. Symmetric-keyed and sent on the same kept-alive session.
  submit2FACode(code: string): void {
    const trimmed = code.trim()
    if (!trimmed || !this.awaiting2FA) return
    this.log(`sending 2FA code`, 'connection')
    this.sendRelayMessage(pb.encodeAuth2FA(trimmed))
  }

  private emitPeerInfo(info: pb.ParsedPeerInfo, connected: boolean): void {
    this.displays = info.displays
    // The host always reports current_display=0 even after a switch, so never
    // treat it as authoritative: keep our chosen display, clamped to range.
    this.currentDisplay = clampDisplayIndex(this.currentDisplay, info.displays.length)
    // The host re-sends PeerInfo later as a display-topology update (fields
    // 1..3 empty). Never let it wipe identity data: only overwrite a field when
    // the incoming info actually carries it.
    this.baseInfo = {
      username: info.username ?? this.baseInfo.username,
      hostname: info.hostname ?? this.baseInfo.hostname,
      platform: info.platform ?? this.baseInfo.platform,
    }
    if (info.version) this.baseVersion = info.version
    if (info.encoding) this.peerEncoding = info.encoding
    const display = this.currentDisplayInfo()
    this.emit({
      type: 'peer-info',
      info: this.buildPeerInfo(display),
    })
    if (connected) {
      this.log(
        `peer: ${info.username ?? '?'}@${info.hostname ?? '?'} (${info.platform ?? '?'}) ` +
          `${display ? `${display.width}x${display.height}` : ''}` +
          (this.displays.length > 1 ? `, displays=${this.displays.length}` : ''),
        'connection',
      )
    }
  }

  private currentDisplayInfo(): pb.DisplayInfo | undefined {
    return this.displays[Math.max(0, Math.min(this.currentDisplay, this.displays.length - 1))]
  }

  private buildPeerInfo(display: pb.DisplayInfo | undefined): RemotePeerInfo {
    return {
      ...this.baseInfo,
      width: display?.width ?? 0,
      height: display?.height ?? 0,
      display: this.currentDisplay,
      displayCount: this.displays.length,
      originX: display?.x ?? 0,
      originY: display?.y ?? 0,
      version: this.baseVersion,
      allDisplays: [...this.displays],
    }
  }

  private handleClipboard(clipboard: pb.ParsedClipboard): void {
    // Only text (format=0) is usable from the panel; other formats are ignored.
    if (clipboard.format !== 0) return
    if (clipboard.content.length === 0) return
    try {
      const text = new TextDecoder('utf-8').decode(clipboard.content)
      this.log(`clipboard from host: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`, 'clipboard')
      this.emit({ type: 'clipboard', text })
    } catch {
      // not valid utf-8 — ignore
    }
  }

  private handleVideoFrame(msg: pb.ParsedMessage & { kind: 'video_frame' }): void {
    if (!msg.codec) return
    this.lastVideoCodec = msg.codec

    if (!this.dbgFrameLogged) {
      this.dbgFrameLogged = true
      // Poison guard: an overruled frame must not become "last-good" — auto
      // would then prefer a codec the host never actually served for this pin.
      if (!this.manualCodec || msg.codec === this.manualCodec) rememberLastGoodCodec(msg.codec)
      this.dbg(
        `first video_frame codec=${msg.codec} display=${msg.display} frames=${msg.frames.length} ` +
          `disp=${this.currentDisplay} total=${this.frameCount}`,
        'decoder',
      )
    }

    // The host overruled our manual codec (streams X while we asked Y): drop
    // the manual pin so the fallback chain engages instead of dying silent.
    // Logged in the journal, not just rd_debug — this decides the session.
    // Grace first: a mismatch right after the pin is the host still
    // applying, not defiance (fired falsely on every fast manual switch).
    if (
      this.manualCodec &&
      msg.codec !== this.manualCodec &&
      !this.manualOverruled
    ) {
      if (Date.now() - this.manualPinnedAt < OVERRULE_GRACE_MS) {
        this.dbg(`codec ${msg.codec} during grace after pin ${this.manualCodec} (host applying)`, 'codec')
      } else {
        this.manualOverruled = true
        this.warn(
          `host streams ${msg.codec} despite manual ${this.manualCodec} — releasing to auto fallback`,
          'codec',
        )
        this.manualCodec = null
      }
    }

    this.lastVideoAt = Date.now()

    // A codec fallback is pending: until the host applies our supported_decoding
    // switch it keeps streaming the failed codec. Any other codec on the wire is
    // progress — accept it (the decoder picks it up on the next packet).
    const fb = this.fallbackPending
    if (fb && msg.codec !== fb.failed) {
      this.clearFallbackPending()
      rememberLastGoodCodec(msg.codec)
      this.dbg(`codec switch applied: ${fb.failed} -> ${msg.codec}`, 'decoder')
    }

    // Track progress of a pending switch: success once frames of the requested
    // display arrive; otherwise the timeout in finalizePendingSwitch reverts.
    if (this.switchPendingTarget !== null && msg.display === this.switchPendingTarget) {
      this.gotTargetFrames = true
    }

    for (const f of msg.frames) {
      // The host streams every monitor we are subscribed to (it never
      // unsubscribes the previous one). Drop frames of other displays so the
      // canvas and decoder stay on the display the user actually chose.
      if (msg.display !== this.currentDisplay) continue
      const packet: VideoPacket = {
        codec: msg.codec,
        key: f.key,
        data: f.data,
        display: msg.display,
        pts: f.pts,
      }
      this.frameCount++
      this.videoHandler?.(packet)
    }
  }

  private handleMisc(fields: pb.RawField[]): void {
    for (const f of fields) {
      if (f.field === 4) {
        // ChatMessage { text = 1 } from the human at the host. Empty text
        // carries nothing — drop it instead of bubbling a blank message.
        const text = pb.getStr(pb.parse(f.value as Uint8Array), 1)
        if (text) this.emit({ type: 'chat', from: 'host', text })
      } else if (f.field === 8) {
        // audio_format announced — audio is disabled client-side, ignore.
        continue
      } else if (f.field === 9) {
        const reason = pb.getStr(fields, 9)
        if (reason) this.fail(`host closed: ${reason}`)
      } else if (f.field === 5) {
        // SwitchDisplay { display=1, x=2, y=3, width=4, height=5 }.
        // The host sends this both as a confirmation echo of OUR switch request
        // and as a broadcast whenever any monitor's video service restarts —
        // the broadcast uses that service's own index, not the display we are
        // watching, so it must not drive the current display.
        const sd = pb.parse(f.value as Uint8Array)
        const display = pb.getInt(sd, 1)
        const x = pb.getInt(sd, 2)
        const y = pb.getInt(sd, 3)
        const width = pb.getInt(sd, 4)
        const height = pb.getInt(sd, 5)

        // Always refresh the display layout (origin/size) used for mouse mapping.
        if (display !== null && display >= 0 && display < this.displays.length) {
          const cur = this.displays[display]
          this.displays[display] = {
            x: x !== null ? pb.zigzagDecode(x) : cur?.x ?? 0,
            y: y !== null ? pb.zigzagDecode(y) : cur?.y ?? 0,
            width: width ?? cur?.width ?? 0,
            height: height ?? cur?.height ?? 0,
            name: cur?.name ?? null,
          }
        }

        if (display !== null && display >= 0) {
          const idx = clampDisplayIndex(display, this.displays.length)
          if (this.switchPendingTarget !== null && idx === this.switchPendingTarget) {
            // Confirmation echo of our own switch request.
            this.log(`display switched to #${idx}`, 'video')
            this.clearPendingSwitch()
            this.emit({ type: 'peer-info', info: this.buildPeerInfo(this.currentDisplayInfo()) })
          } else {
            // Broadcast from another monitor's service — ignore as state.
            this.log(`display broadcast #${idx} (ignored, watching #${this.currentDisplay})`, 'video')
            this.emit({ type: 'peer-info', info: this.buildPeerInfo(this.currentDisplayInfo()) })
          }
        }
      }
    }
  }

  // ---------- input ----------

  sendMouse(x: number, y: number, mask: number, modifiers: number[] = []): void {
    this.sendRelayMessage(pb.encodeMouseEvent({ mask, x, y, modifiers }))
  }

  // Trackpad-style relative pointer move (event_type 5). The host clamps and
  // applies it as a delta to the current OS cursor position.
  sendMouseRelative(dx: number, dy: number): void {
    this.sendRelayMessage(pb.encodeMouseRelative(Math.round(dx), Math.round(dy)))
  }

  // Tell the host whether to stream its remote cursor. Yes(2) subscribes the
  // CURSOR + POSITION services even if keyboard permission is disabled.
  setShowRemoteCursor(enabled: boolean): void {
    this.sendRelayMessage(pb.encodeOptionShowRemoteCursor(enabled))
  }

  sendKeyEvent(body: pb.KeyEventBody): void {
    this.dbgKeyEvent(body)
    this.sendRelayMessage(pb.encodeKeyEvent(body))
  }

  sendHotkey(controlKey: number, modifiers: number[] = []): void {
    // Down+up pair, same debug numbering as typed keys so the journal shows
    // the combination, not just the toolbar click (see the ui: hotkey line).
    for (const down of [true, false]) {
      const body: pb.KeyEventBody = { down, controlKey, modifiers }
      this.dbgKeyEvent(body)
      this.sendRelayMessage(pb.encodeKeyEvent(body))
    }
  }

  // One debug line per key event, capped like before (first 30, then every
  // 25th): human-readable combo + symbol instead of the raw JSON dump.
  private dbgKeyEvent(body: pb.KeyEventBody): void {
    if (!this.debug) return
    this.dbgKeyCount++
    const n = this.dbgKeyCount
      if (n === 1 || n <= 30 || n % 25 === 0) {
        this.dbg(`send key #${n} ${describeKeyEvent(body, this.baseInfo.platform)}`, 'input')
      }
  }

  sendSwitchDisplay(): void {
    const count = this.displays.length
    if (count <= 1) return
    const next = (this.currentDisplay + 1) % count
    this.previousDisplay = this.currentDisplay
    this.currentDisplay = next
    this.switchPendingTarget = next
    this.gotTargetFrames = false
    if (this.switchPendingTimer) clearTimeout(this.switchPendingTimer)
    this.switchPendingTimer = setTimeout(() => this.finalizePendingSwitch(), 4000)
    this.sendRelayMessage(pb.encodeSwitchDisplay(next))
    this.emit({ type: 'peer-info', info: this.buildPeerInfo(this.currentDisplayInfo()) })
    this.log(`switch display requested -> #${next}`, 'video')
  }

  requestKeyframe(): void {
    const now = Date.now()
    if (now - this.lastKeyframeRequestAt < this.keyframeRateLimitMs) return
    this.lastKeyframeRequestAt = now
    this.sendRelayMessage(pb.encodeMiscBool(10)) // refresh_video
  }

  // Unthrottled keyframe request for rare, user-visible events (monitor switch,
  // manual codec change) where a dropped refresh would stall the whole frame.
  requestKeyframeNow(): void {
    this.lastKeyframeRequestAt = Date.now()
    this.sendRelayMessage(pb.encodeMiscBool(10)) // refresh_video
  }

  // ---------- decoder codec fallback ----------

  // Called by the decoder when the engine proved it cannot decode `fromCodec`.
  // Re-advertises supported_decoding with the next best codec so the host
  // switches encoders. AUTO mode only: a manual pin is literal, so this
  // returns null and the caller surfaces the fatal banner instead. Returns
  // the switch target, or null once every candidate is exhausted.
  negotiateDecoderFallback(fromCodec: string): string | null {
    if (this.closed) return null
    if (this.manualCodec) {
      // Manual choice — no silent switch; the caller warns instead.
      this.dbg(`manual codec ${this.manualCodec} failed, no auto fallback`, 'decoder')
      return null
    }
    // Already mid-switch — ignore duplicate escalations from stale packets.
    if (this.fallbackPending) return this.fallbackPending.target
    this.codecFailed.add(fromCodec)
    const target = this.codecNextTarget()
    if (!target) {
      this.dbg(`codec fallback exhausted (failed: ${[...this.codecFailed].join(',')})`, 'codec')
      return null
    }
    const abilities: NonNullable<pb.SupportedDecodingOptions['abilities']> = {}
    for (const c of this.codecCandidates()) abilities[c as pb.CodecName] = !this.codecFailed.has(c)
    abilities[target as pb.CodecName] = true
    this.dbg(
      `codec fallback ${fromCodec} -> ${target} ` +
        `(candidates=${this.codecCandidates().filter((c) => !this.codecFailed.has(c)).join(',')})`,
      'codec',
    )
    this.warn(`codec fallback ${fromCodec} -> ${target}`, 'codec')
    this.sendRelayMessage(
      pb.encodeSupportedDecoding({
        prefer: pb.PREFER_CODEC[target as pb.CodecName],
        abilities,
      }),
    )
    // The encoder switch produces a keyframe for the new codec only when asked.
    this.sendRelayMessage(pb.encodeMiscBool(10)) // refresh_video
    const timer = setTimeout(() => this.codecFallbackTimeout(), 4000)
    this.fallbackPending = { failed: fromCodec, target, timer, nudged: false }
    return target
  }

  private probeLoginDecoding(): Promise<pb.SupportedDecodingOptions | undefined> {
    try {
      // A manual panel choice wins immediately: advertise every codec as
      // supported and let `prefer` drive the host's encoder selection.
      if (this.config.codec && this.config.codec !== 'auto') {
        this.dbg(`codec preference at login: ${this.config.codec}`, 'codec')
        return Promise.resolve({
          prefer: pb.PREFER_CODEC[this.config.codec],
          abilities: { vp9: true, h264: false, h265: false, vp8: true, av1: true },
        })
      }
      // Proven-first auto: start from what demonstrably produced video in
      // this browser, else VP9 — every host encodes it in software and every
      // engine decodes it. Hardware codecs never enter auto by gamble, so
      // auto can neither storm nor surprise; the runtime fallback still
      // covers a stale last-good.
      const lastGood = readLastGoodCodec()
      const prefer = (lastGood ?? 'vp9') as pb.CodecName
      this.dbg(`codec preference at login: auto -> ${prefer}${lastGood ? ' (last-good)' : ' (universal default)'}`, 'codec')
      // Mask advertised abilities with the cached browser probe (when warm):
      // never invite the host to encode what this engine cannot decode.
      // Hardware codecs are never offered.
      const cached = getCachedSupport()
      return Promise.resolve({
        prefer: pb.PREFER_CODEC[prefer],
        abilities: {
          vp9: cached ? cached.vp9 : true,
          h264: false,
          h265: false,
          vp8: cached ? cached.vp8 : true,
          av1: cached ? cached.av1 : true,
        },
      })
    } catch {
      // Inconclusive probe — keep the default; runtime fallback covers it.
      return Promise.resolve(undefined)
    }
  }

  private resetCodecState(): void {
    this.codecFailed.clear()
    this.lastVideoCodec = null
    this.loggedSizeCaps.clear()
    this.clearFallbackPending()
  }

  // Preferred codecs in reliability order; filtered by what the host reports it
  // can encode once PeerInfo arrives. VP9 has no SupportedEncoding flag (it is
  // the universal fallback), so it always stays in the list.
  // Codecs both sides speak (host encoding ∩ warmed browser probe).
  // Used by presets; callers may intersect once more, harmlessly.
  getHostCodecs(): pb.CodecName[] {
    return this.codecCandidates() as pb.CodecName[]
  }

  private codecCandidates(): string[] {
    const order = ['vp9', 'vp8', 'av1']
    const enc = this.peerEncoding
    // Unsupported-in-browser codecs never enter the AUTO chain: the host must
    // not be invited to switch to something we cannot decode. While the page
    // probe is still cold, behave as before (host-only filter).
    // VP9 has no SupportedEncoding flag (it is the universal fallback), so it
    // always stays in the list.
    const browser = getCachedSupport()
    // G2 size cap: never invite the host to encode a stream larger than this
    // engine demonstrably decoded (unknown caps never exclude — the runtime
    // fallback stays the safety net).
    const disp = this.currentDisplayInfo()
    const hostPixels = disp ? disp.width * disp.height : null
    return order.filter((c) => {
      if (browser && !browser[c as keyof typeof browser]) return false
      if (hostPixels != null && !provenForPixels(c as pb.CodecName, hostPixels)) {
        // Journal, not just debug: this decides which codecs auto may use.
        const key = `${c}@${disp?.width}x${disp?.height}`
        if (!this.loggedSizeCaps.has(key)) {
          this.loggedSizeCaps.add(key)
          this.warn(`codec ${c} excluded: ${disp?.width}x${disp?.height} above proven decode cap`, 'codec')
        }
        return false
      }
      if (!enc) return true
      if (c === 'vp8') return enc.vp8
      if (c === 'av1') return enc.av1
      return true
    })
  }

  private codecNextTarget(): string | null {
    for (const c of this.codecCandidates()) {
      if (!this.codecFailed.has(c)) return c
    }
    return null
  }

  // Two-stage fallback timeout: hosts can take ~5s to switch encoders
  // mid-session, so the first 4s expiry only nudges (refresh_video) and
  // re-arms — escalation to the next codec happens at ~8s. Without the nudge
  // stage, slow hosts were declared dead before they even started switching.
  private codecFallbackTimeout(): void {
    const p = this.fallbackPending
    if (!p) return
    if (!p.nudged) {
      p.nudged = true
      this.dbg(`codec fallback still waiting for ${p.target}, nudging host`, 'codec')
      this.sendRelayMessage(pb.encodeMiscBool(10)) // refresh_video
      p.timer = setTimeout(() => this.codecFallbackTimeout(), 4000)
      return
    }
    this.fallbackPending = null
    this.codecFailed.add(p.target)
    this.dbg(`codec fallback timeout (${p.target} never arrived)`, 'codec')
    // Escalate: mark the timed-out target failed and switch to the next one.
    this.negotiateDecoderFallback(p.target)
  }

  private clearFallbackPending(): void {
    if (this.fallbackPending) {
      clearTimeout(this.fallbackPending.timer)
      this.fallbackPending = null
    }
  }

  // ---------- manual codec preference (panel) ----------

  // Re-advertise supported_decoding mid-session so the host's Encoder::update
  // switches its encoder.  'auto' = proven-first prefer (see
  // probeLoginDecoding); a named codec = prefer=<codec>, used literally.
  // The decoder reinitialises on the next frame's codec change automatically
  // (handlePacket → initDecoder).
  setCodecPreference(codec: 'auto' | pb.CodecName): void {
    if (this.closed) return
    this.manualCodec = codec === 'auto' ? null : codec
    this.manualPinnedAt = Date.now()
    this.manualOverruled = false
    // Declare software codecs supported; hardware codecs are never offered.
    const ALL: NonNullable<pb.SupportedDecodingOptions['abilities']> = {
      vp9: true, h264: false, h265: false, vp8: true, av1: true,
    }
    const opts: pb.SupportedDecodingOptions = {
      prefer: pb.PREFER_CODEC[codec],
      abilities: ALL,
    }
    this.resetCodecState()
    this.sendRelayMessage(pb.encodeSupportedDecoding(opts))
    this.sendRelayMessage(pb.encodeMiscBool(10)) // refresh_video
    this.dbg(`codec preference: ${codec} (prefer=${opts.prefer})`, 'codec')
  }

  // ---------- stream options / audio / auto / low-latency ----------

  // Apply manual quality/fps preferences. Disables auto mode.
  // (Audio was removed from the web client — audioEnabled is pinned off.)
  setStreamOptions(options: Partial<pb.SessionVideoOptions>): void {
    this.videoOptions = { ...this.videoOptions, ...options, audioEnabled: false }
    this.setAutoMode(false)
    this.sendVideoOption()
  }

  
  // Publish decode/paint/queue timing from the components; merged into the
  // next stats tick so the connection panel can show where time goes.
  publishVideoStats(stats: {
    decodeMs?: number | null
    paintMs?: number | null
    renderFps?: number | null
    queueDrops?: number
    queueWaitMs?: number | null
    keyErrors?: number
    deltaErrors?: number
  }): void {
    if (stats.decodeMs !== undefined) this.externalStats.decodeMs = stats.decodeMs
    if (stats.paintMs !== undefined) this.externalStats.paintMs = stats.paintMs
    if (stats.renderFps !== undefined) this.externalStats.renderFps = stats.renderFps
    if (stats.queueDrops !== undefined) this.externalStats.queueDrops = stats.queueDrops
    if (stats.queueWaitMs !== undefined) this.externalStats.queueWaitMs = stats.queueWaitMs
    if (stats.keyErrors !== undefined) this.externalStats.keyErrors = stats.keyErrors
    if (stats.deltaErrors !== undefined) this.externalStats.deltaErrors = stats.deltaErrors
  }

  // Network-adaptive quality: pick a target from measured throughput/ping,
  // switch only after the new target is observed three times to avoid
  // thrashing. Conservative by design (see fields above).
  setAutoMode(enabled: boolean): void {
    if (this.autoMode === enabled) return
    this.autoMode = enabled
    if (this.autoTimer) {
      clearInterval(this.autoTimer)
      this.autoTimer = null
    }
    if (!enabled) {
      this.sendVideoOption()
      return
    }
    this.autoTarget = { quality: this.videoOptions.quality ?? 3, fps: this.videoOptions.fps ?? 30 }
    this.autoDiffTicks = 0
    this.autoStuckTicks = 0
    this.lastAutoQueueDrops = this.externalStats.queueDrops
    // Cooldown so enabling auto (e.g. right after a manual choice) doesn't
    // yank the quality on stale measurements.
    this.autoCooldownUntil = Date.now() + 8000
    this.autoTimer = setInterval(() => {
      if (!this.autoMode) return
      if (Date.now() < this.autoCooldownUntil) return
      if (!this.lastTickHadFrames) {
        this.autoDiffTicks = 0
        return
      }
      const next = this.pickAutoTarget()
      const same = next.quality === this.autoTarget.quality && next.fps === this.autoTarget.fps
      if (same) {
        this.autoDiffTicks = 0
        return
      }
      // Asymmetric hysteresis: downshifts react fast (3s), upshifts need a
      // sustained signal (6s) plus a post-switch cooldown — flapping between
      // bands costs a host encoder rebuild every time.
      const need = autoDiffNeed(this.autoTarget, next)
      this.autoDiffTicks++
      if (this.autoDiffTicks >= need) {
        this.autoDiffTicks = 0
        this.autoCooldownUntil = Date.now() + 6000
        this.log(
          `auto: ${this.autoTarget.quality}/${this.autoTarget.fps}fps -> ${next.quality}/${next.fps}fps ` +
            `(kbps=${Math.round(this.lastAutoKbps)}, ping=${this.pingRttMs ?? '?'}, ` +
            `decode=${this.externalStats.decodeMs ?? '?'}/paint=${this.externalStats.paintMs ?? '?'})`,
          'video',
        )
        this.autoTarget = next
        this.lastSent = { quality: 0, fps: 0, audioEnabled: this.videoOptions.audioEnabled ?? false }
        this.sendVideoOption()
      }
    }, 1000)
  }

  private pickAutoTarget(): { quality: number; fps: number } {
    const kbps = this.recvHistory.length
      ? this.recvHistory.reduce((a, b) => a + b, 0) / this.recvHistory.length
      : 0
    this.lastAutoKbps = kbps
    const queueDropsGrew = this.externalStats.queueDrops > this.lastAutoQueueDrops
    this.lastAutoQueueDrops = this.externalStats.queueDrops
    // Stuck-queue streak for the deep floor: two ticks above 300ms.
    if ((this.externalStats.queueWaitMs ?? 0) > 300) this.autoStuckTicks++
    else this.autoStuckTicks = 0
    return selectAutoTarget({
      kbps,
      pingMs: this.pingRttMs,
      decodeMs: this.externalStats.decodeMs,
      paintMs: this.externalStats.paintMs,
      queueWaitMs: this.externalStats.queueWaitMs,
      queueDropsGrew,
      current: this.autoTarget,
      stuckTicks: this.autoStuckTicks,
    })
  }

  private effectiveQuality(): number {
    return this.autoMode ? this.autoTarget.quality : (this.videoOptions.quality ?? 3)
  }

  private effectiveFps(): number {
    return this.autoMode ? this.autoTarget.fps : (this.videoOptions.fps ?? 30)
  }

  // Send the current effective option; request a re-encode only when the
  // video-affecting values (quality/fps/custom) actually changed. Audio is
  // always reported disabled (removed from the web client).
  private sendVideoOption(): void {
    const quality = this.effectiveQuality()
    const fps = this.effectiveFps()
    const audioEnabled = false
    const changed =
      quality !== this.lastSent.quality || fps !== this.lastSent.fps
    this.lastSent = { quality, fps, audioEnabled }
    this.sendRelayMessage(pb.encodeOptionUpdate({ quality, fps, audioEnabled }))
    if (changed) {
      this.sendRelayMessage(pb.encodeMiscBool(10)) // refresh_video
    }
  }

  sendClipboardText(text: string): void {
    this.sendRelayMessage(pb.encodeClipboardText(text))
  }

  // Text chat to the human at the host (Misc.chat_message). Length/empty
  // validation lives in the UI; the wire takes anything.
  sendChatMessage(text: string): void {
    if (!text) return
    this.sendRelayMessage(pb.encodeChatMessage(text))
  }

  private clearPendingSwitch(): void {
    this.switchPendingTarget = null
    if (this.switchPendingTimer) {
      clearTimeout(this.switchPendingTimer)
      this.switchPendingTimer = null
    }
  }

  private finalizePendingSwitch(): void {
    const target = this.switchPendingTarget
    this.clearPendingSwitch()
    if (target === null) return
    if (!this.gotTargetFrames && this.currentDisplay === target) {
      // No frames for the requested display arrived — the host did not switch
      // (e.g. invalid index). Revert so we keep showing live video.
      this.currentDisplay = clampDisplayIndex(this.previousDisplay, this.displays.length)
      this.warn(`switch to #${target} failed, reverted to #${this.currentDisplay}`, 'video')
      this.emit({ type: 'peer-info', info: this.buildPeerInfo(this.currentDisplayInfo()) })
    }
  }

  // ---------- transport ----------

  private sendRelayMessage(payload: Uint8Array): void {
    if (this.symmetricKey) {
      const nonce = makeSessionNonce(++this.sendSeq)
      this.sendRelayRaw(nacl.secretbox(payload, nonce, this.symmetricKey))
      return
    }
    this.sendRelayRaw(payload)
  }

  private sendRelayRaw(bytes: Uint8Array): void {
    this.sentBytes += bytes.length
    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      this.relayWs.send(bytes)
    }
  }

  private startStats(): void {
    if (this.statsTimer) return
    // Ping the host every 2s to keep an RTT figure in the stats panel.
    // Only one probe in flight; drop it if it never came back.
    // Periodically re-send Misc.video_received (field 12) so the host tracks
    // this connection's frame consumption and doesn't consider the client idle.
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        this.sendRelayMessage(pb.encodeMiscBool(12))
      }
      if (this.pingSentAt !== 0) {
        if (Date.now() - this.pingSentAt > 10000) this.pingSentAt = 0
        return
      }
      this.pingSentAt = Date.now()
      this.sendRelayMessage(pb.encodeTestDelayFromClient(0))
    }, 2000)
    this.statsTimer = setInterval(() => {
      // Video-stall watchdog: while connected, a stream that delivers no video
      // frame for 4s (long monitor switch, codec re-negotiation, edge cases)
      // gets a one-shot unthrottled refresh + cursor re-subscribe. Fires once
      // per stall; resets as soon as frames flow again.
      if (this.connected && this.lastVideoAt !== 0 && Date.now() - this.lastVideoAt >= 4000) {
        if (!this.videoStallNotified) {
          this.videoStallNotified = true
          const stalledFor = ((Date.now() - this.lastVideoAt) / 1000).toFixed(1)
          this.dbg(`video stall: no frames for ${stalledFor}s -> refresh_video + cursor re-subscribe`, 'video')
          this.requestKeyframeNow()
          this.setShowRemoteCursor(true)
          this.emit({ type: 'log', level: 'warn', category: 'video', message: `video stalled (${stalledFor}s) — sent refresh` })
        }
      } else {
        this.videoStallNotified = false
      }
      const downKbps = Math.round((this.recvBytes * 8) / 1000)
      this.recvHistory.push(downKbps)
      if (this.recvHistory.length > 3) this.recvHistory.shift()
      // Frame presence for the auto-quality gate: a tick with no frames is
      // "no data" (static/pause), never a reason to downshift.
      this.lastTickHadFrames = this.frameCount > 0
      this.emit({
        type: 'stats',
        stats: {
          downKbps,
          upKbps: Math.round((this.sentBytes * 8) / 1000),
          // Rendered fps from the decoder when available — wire frame count
          // only as fallback (drops/backlog make them diverge).
          fps: this.externalStats.renderFps ?? Math.round(this.frameCount),
          pingMs: this.pingRttMs,
          decodeMs: this.externalStats.decodeMs,
          paintMs: this.externalStats.paintMs,
          queueDrops: this.externalStats.queueDrops,
          queueWaitMs: this.externalStats.queueWaitMs,
          keyErrors: this.externalStats.keyErrors,
          deltaErrors: this.externalStats.deltaErrors,
          codec: this.lastVideoCodec,
        },
      })
      this.recvBytes = 0
      this.sentBytes = 0
      this.frameCount = 0
    }, 1000)
  }

  private stopStats(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.autoTimer) {
      clearInterval(this.autoTimer)
      this.autoTimer = null
    }
    this.autoMode = false
  }

  disconnect(): void {
    if (this.closed) return
    this.closed = true
    this.connected = false
    this.firstFrameBuf = null
    this.clearFirstFrameTimer()
    this.lastVideoAt = 0
    this.videoStallNotified = false
    this.loginSent = false
    this.clearApprovalTimer()
    if (this.loginOptionTimer) {
      clearTimeout(this.loginOptionTimer)
      this.loginOptionTimer = null
    }
    if (this.loginOptionEarlyTimer) {
      clearTimeout(this.loginOptionEarlyTimer)
      this.loginOptionEarlyTimer = null
    }
    if (this.relayWaitTimer) {
      clearTimeout(this.relayWaitTimer)
      this.relayWaitTimer = null
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.clearPendingSwitch()
    this.stopStats()
    this.closeId()
    if (this.relayWs) {
      this.relayWs.onclose = null
      this.relayWs.onerror = null
      try {
        this.relayWs.close()
      } catch {
        // ignore
      }
      this.relayWs = null
    }
    this.emit({ type: 'status', status: 'disconnected' })
  }

  private fail(message: string): void {
    this.emit({ type: 'error', message })
    this.disconnect()
  }

  private log(message: string, category: LogCategory = 'system'): void {
    this.emit({ type: 'log', level: 'info', category, message })
  }

  private warn(message: string, category: LogCategory = 'system'): void {
    this.emit({ type: 'log', level: 'warn', category, message })
  }

  private errorLog(message: string, category: LogCategory = 'system'): void {
    this.emit({ type: 'log', level: 'error', category, message })
  }

  // Verbose session journal, opt-in.
  private dbg(message: string, category: LogCategory = 'system'): void {
    if (!this.debug) return
    this.emit({ type: 'log', level: 'debug', category, message })
    try {
      console.debug(`[rd-dbg] ${message}`)
    } catch {
      // ignore
    }
  }

  // Log each message kind once per session so the journal shows the handshake
  // and stream state without flooding on video/audio/traffic spam.
  private dbgOnce(prefix: string, msg: pb.ParsedMessage, category: LogCategory = 'connection'): void {
    if (!this.debug || this.dbgKinds.has(msg.kind)) return
    this.dbgKinds.add(msg.kind)
    const fields = 'fields' in msg && msg.fields ? msg.fields.map((f) => `${f.field}:${f.wireType}`).join(',') : ''
    this.dbg(`${prefix} ${msg.kind}${fields ? ` [${fields}]` : ''}`, category)
  }

  // Diagnostic path for the UI (e.g. cursor render results in RemoteScreen).
  logInfo(message: string, category: LogCategory = 'system', level: LogLevel = 'info'): void {
    if (level === 'warn') this.warn(message, category)
    else if (level === 'error') this.errorLog(message, category)
    else if (level === 'debug') this.dbg(message, category)
    else this.log(message, category)
  }

  // Called by the journal's debug chip: effective immediately on the running
  // session, no reconnect needed.
  setSessionDebug(v: boolean): void {
    this.debug = v
  }

  private emit(ev: SessionEvent): void {
    this.onEvent(ev)
  }
}

function clampDisplayIndex(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(index, count - 1))
}

// Manual scan for a top-level signed_id envelope (Message field 3,
// length-delimited) when strict parsing chokes — observed with trailing
// garbage after the envelope. Returns the envelope payload plus the total
// bytes consumed (tag + length + payload) so callers can feed the remainder
// as the next message.
// Exported for unit tests.
export function extractSignedIdEnvelope(buf: Uint8Array): { payload: Uint8Array; consumed: number } | null {
  try {
    if (buf.length < 2 || buf[0] !== 0x1a) return null
    let len = 0
    let shift = 0
    let p = 1
    for (let i = 0; i < 5; i++) {
      if (p >= buf.length) return null
      const b = buf[p++]
      len += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    if (len <= 0 || p + len > buf.length) return null
    return { payload: buf.slice(p, p + len), consumed: p + len }
  } catch {
    return null
  }
}

// Exported for unit tests.
export function concatBytes(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (!a || a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// Locate the IdPk record inside SignedId.id. The standard layout prefixes a
// 64-byte ed25519 signature, but live hosts prepend extra bytes (verified
// sample: IdPk at offset 66, not 64). Slide the parse window and accept the
// first slice that is EXACTLY {id, pk[, dtls]} — id non-empty alphanumeric,
// pk 32 bytes, no stray fields, consuming the slice to its end. One-time cost
// per session, bounded by message size (~hundreds of bytes).
// Exported for unit tests.
export function extractIdPk(idBytes: Uint8Array): { idPk: pb.IdPk; offset: number } | null {
  const ED25519_SIG_LEN = 64
  const tryOffset = (off: number): pb.IdPk | null => {
    try {
      const slice = off === 0 ? idBytes : idBytes.slice(off)
      const fields = pb.parse(slice)
      let id: Uint8Array | null = null
      let pk: Uint8Array | null = null
      for (const f of fields) {
        if (f.field === 1 && f.wireType === 2) {
          if (id) return null // duplicate — wrong window
          id = f.value as Uint8Array
        } else if (f.field === 2 && f.wireType === 2) {
          if (pk) return null
          pk = f.value as Uint8Array
        } else if (f.field === 3 && f.wireType === 2) {
          continue // dtls_fingerprint — allowed
        } else {
          return null // stray field — wrong window
        }
      }
      if (!id || id.length === 0 || !pk || pk.length !== 32) return null
      const idStr = new TextDecoder().decode(id)
      if (!/^[0-9A-Za-z]+$/.test(idStr)) return null
      return { id: idStr, pk }
    } catch {
      return null
    }
  }
  if (idBytes.length > ED25519_SIG_LEN) {
    const at64 = tryOffset(ED25519_SIG_LEN)
    if (at64) return { idPk: at64, offset: ED25519_SIG_LEN }
  }
  for (let off = 0; off < idBytes.length; off++) {
    if (off === ED25519_SIG_LEN) continue
    const idPk = tryOffset(off)
    if (idPk) return { idPk, offset: off }
  }
  return null
}

// Last codec that demonstrably produced video in this browser (first frame of
// a session or a successful fallback). Lets the next connect start proven
// instead of gambling; the runtime fallback still covers staleness.
const LAST_GOOD_CODEC_KEY = 'rd-last-codec'

// Overrule grace: the host needs seconds to apply a new prefer, so a codec
// mismatch within this window after a manual pin is a transition, not
// defiance. Tunable in one place if a host proves slower.
const OVERRULE_GRACE_MS = 10_000

// Hysteresis thresholds in ticks: downshifts react fast (3s), upshifts need
// a sustained signal (6s). The very first decision after enabling auto
// (quality 0 = unset) is always fast — direction from "unset" is meaningless,
// and a bad link shouldn't wait out the upshift path.
export function autoDiffNeed(
  current: { quality: number; fps: number },
  next: { quality: number; fps: number },
): number {
  if (current.quality === 0) return 3
  return next.quality * 1000 + next.fps > current.quality * 1000 + current.fps ? 6 : 3
}

export interface AutoTargetInput {
  kbps: number
  pingMs: number | null
  decodeMs: number | null
  paintMs: number | null
  queueWaitMs: number | null
  queueDropsGrew: boolean
  current: { quality: number; fps: number }
  // Consecutive auto ticks with queueWaitMs > 300ms: the bottom rung (2/15)
  // isn't draining the queue, so go one deeper instead of holding the floor.
  stuckTicks: number
}

// Pure auto-quality target selection (unit-tested): throughput/ping bands,
// unknown ping holds the level (never gambles an upshift), decoder-side
// overload steps one level down, persistent queue stall goes to deep floor.
export function selectAutoTarget(input: AutoTargetInput): { quality: number; fps: number } {
  const { kbps, pingMs, decodeMs, paintMs, queueWaitMs, queueDropsGrew, current, stuckTicks } = input
  // Deep floor (1/10): the queue hasn't drained for a while — sending less
  // is the only lever left. Recovery flows through the normal bands once
  // stuckTicks resets (Q back under 300ms).
  if (stuckTicks >= 2) return { quality: 1, fps: 10 }
  let next: { quality: number; fps: number }
  const ping = pingMs ?? 0
  if (kbps < 1200 || ping > 220) next = { quality: 2, fps: 15 }
  else if (kbps < 3200 || ping > 110) next = { quality: 3, fps: 30 }
  else next = { quality: 4, fps: 60 }
  if (pingMs == null && next.quality * 1000 + next.fps > current.quality * 1000 + current.fps) {
    next = { ...current }
  }
  const decodeStrained =
    (decodeMs ?? 0) > 40 || (paintMs ?? 0) > 25 || (queueWaitMs ?? 0) > 120 || queueDropsGrew
  if (decodeStrained) {
    if (next.quality === 4) next = { quality: 3, fps: 30 }
    else if (next.quality === 3) next = { quality: 2, fps: 15 }
  }
  return next
}
function readLastGoodCodec(): pb.CodecName | null {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_GOOD_CODEC_KEY) : null
    if (v === 'vp8' || v === 'vp9' || v === 'av1') return v
  } catch {
    // ignore (private mode)
  }
  return null
}

function rememberLastGoodCodec(codec: string): void {
  try {
    if (
      typeof localStorage !== 'undefined' &&
      (codec === 'vp8' || codec === 'vp9' || codec === 'av1')
    ) {
      localStorage.setItem(LAST_GOOD_CODEC_KEY, codec)
    }
  } catch {
    // ignore (private mode)
  }
}

function debugEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('rd_debug') === '1') return true
    if (typeof window !== 'undefined' && /[?&]debug=1\b/.test(window.location.search)) return true
  } catch {
    // ignore (private mode / SSR)
  }
  return false
}

function toHex(data: ArrayBuffer, maxBytes = 64): string {
  const bytes = new Uint8Array(data)
  const n = Math.min(bytes.length, maxBytes)
  let s = ''
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0')
  return bytes.length > n ? `${s}…(+${bytes.length - n}b)` : s
}

// Full hex dump for small handshake buffers (no truncation) — post-mortem
// evidence for unparseable peer messages.
function hexFull(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.length; i++) s += data[i].toString(16).padStart(2, '0')
  return s
}