// Minimal hand-rolled protobuf wire codec for the RustDesk protocol subset used
// by the in-panel web client. Field numbers match rendezvous.proto / message.proto
// from rustdesk-server (verified against hbbs/hbbr 1.1.16 and real peers).

export interface RawField {
  field: number
  wireType: number
  // wireType 0 -> number (varint), wireType 2 -> Uint8Array
  value: number | Uint8Array
}

// ---------- varint helpers ----------

function appendVarint(out: number[], value: number): void {
  // No >>>/<< truncation: values like TestDelay.time (epoch ms ~2^41) must survive.
  let v = value
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

function readVarint(buf: Uint8Array, p: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  for (let i = 0; i < 10; i++) {
    if (p >= buf.length) throw new Error('varint past end of buffer')
    const b = buf[p++]
    result += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) return { value: result, next: p }
    shift += 7
  }
  throw new Error('varint too long')
}

// sint32 protobuf fields are zigzag-encoded; MouseEvent.x/y, DisplayInfo.x/y
// and SwitchDisplay.x/y all use sint32 in rustdesk's message.proto.
export function zigzagEncode(value: number): number {
  return value >= 0 ? value * 2 : value * -2 - 1
}

export function zigzagDecode(value: number): number {
  return (value >>> 1) ^ -(value & 1)
}

// ---------- writer ----------

export class PBWriter {
  private bytes: number[] = []

  uint(field: number, value: number): this {
    appendVarint(this.bytes, (field << 3) | 0)
    appendVarint(this.bytes, value)
    return this
  }

  bool(field: number, value: boolean): this {
    return this.uint(field, value ? 1 : 0)
  }

  str(field: number, value: string): this {
    return this.lenDelim(field, new TextEncoder().encode(value))
  }

  bytesField(field: number, value: Uint8Array): this {
    return this.lenDelim(field, value)
  }

  msg(field: number, inner: Uint8Array): this {
    return this.lenDelim(field, inner)
  }

  private lenDelim(field: number, payload: Uint8Array): this {
    appendVarint(this.bytes, (field << 3) | 2)
    appendVarint(this.bytes, payload.length)
    for (let i = 0; i < payload.length; i++) this.bytes.push(payload[i])
    return this
  }

  finish(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

// ---------- reader ----------

export function parse(buf: Uint8Array): RawField[] {
  const fields: RawField[] = []
  let p = 0
  while (p < buf.length) {
    const key = readVarint(buf, p)
    p = key.next
    const field = key.value >>> 3
    const wireType = key.value & 7
    if (wireType === 0) {
      const val = readVarint(buf, p)
      p = val.next
      fields.push({ field, wireType, value: val.value })
    } else if (wireType === 2) {
      const len = readVarint(buf, p)
      p = len.next
      if (p + len.value > buf.length) throw new Error('length-delimited field past end')
      fields.push({ field, wireType, value: buf.slice(p, p + len.value) })
      p += len.value
    } else if (wireType === 1) {
      // fixed64: skip (kept as marker, never read by accessors)
      if (p + 8 > buf.length) throw new Error('fixed64 past end')
      fields.push({ field, wireType, value: 0 })
      p += 8
    } else if (wireType === 5) {
      // fixed32: skip
      if (p + 4 > buf.length) throw new Error('fixed32 past end')
      fields.push({ field, wireType, value: 0 })
      p += 4
    } else if (wireType === 3) {
      // start-group: skip everything up to the matching end-group
      let depth = 1
      while (depth > 0) {
        if (p >= buf.length) throw new Error('start-group without end-group')
        const inner = readVarint(buf, p)
        p = inner.next
        const wt = inner.value & 7
        if (wt === 0) {
          const v = readVarint(buf, p)
          p = v.next
        } else if (wt === 2) {
          const l = readVarint(buf, p)
          p = l.next
          p += l.value
        } else if (wt === 1) {
          p += 8
        } else if (wt === 5) {
          p += 4
        } else if (wt === 4) {
          depth--
        } else if (wt === 3) {
          depth++
        }
      }
    } else if (wireType === 4) {
      // stray end-group: ignore
    } else {
      throw new Error(`unsupported wire type ${wireType}`)
    }
  }
  return fields
}

export function getBytes(fields: RawField[], field: number): Uint8Array | null {
  for (const f of fields) {
    if (f.field === field && f.wireType === 2) return f.value as Uint8Array
  }
  return null
}

export function getInt(fields: RawField[], field: number): number | null {
  for (const f of fields) {
    if (f.field === field && f.wireType === 0) return f.value as number
  }
  return null
}

export function getStr(fields: RawField[], field: number): string | null {
  const b = getBytes(fields, field)
  if (!b) return null
  try {
    return new TextDecoder('utf-8').decode(b)
  } catch {
    return null
  }
}

// ---------- rendezvous (hbbs / hbbr) ----------

export interface PunchHoleRequestOpts {
  peerId: string
  licenceKey: string
  forceRelay?: boolean
}

export function encodePunchHoleRequest(opts: PunchHoleRequestOpts): Uint8Array {
  const w = new PBWriter()
    .str(1, opts.peerId)
    .uint(2, 2) // NatType SYMMETRIC (official web client value; force_relay decides)
    .str(3, opts.licenceKey)
    .uint(4, 0) // ConnType DEFAULT_CONN
    .bool(8, opts.forceRelay ?? true)
  return new PBWriter().msg(8, w.finish()).finish() // RendezvousMessage.punch_hole_request = 8
}

export interface RequestRelayOpts {
  peerId?: string
  uuid: string
  relayServer?: string
  licenceKey: string
  secure?: boolean
  connType?: number
}

export function encodeRequestRelay(opts: RequestRelayOpts): Uint8Array {
  // The official web client sends licence_key + uuid only; extra fields are
  // tolerated by the host but omitted here to match the reference flow.
  const w = new PBWriter().str(2, opts.uuid).str(6, opts.licenceKey)
  if (opts.peerId !== undefined) w.str(1, opts.peerId)
  if (opts.relayServer !== undefined) w.str(4, opts.relayServer)
  if (opts.secure !== undefined) w.bool(5, opts.secure)
  if (opts.connType !== undefined) w.uint(7, opts.connType)
  return new PBWriter().msg(18, w.finish()).finish() // RendezvousMessage.request_relay = 18
}

export type RendezvousResponse =
  | { type: 'punch_hole_response'; failure: number; relayServer: string | null; failureText: string }
  | {
      type: 'relay_response'
      uuid: string | null
      relayServer: string | null
      refuseReason: string | null
      version: string | null
    }

export function parseRendezvous(buf: Uint8Array): RendezvousResponse {
  const top = parse(buf)
  const phRaw = getBytes(top, 11)
  if (phRaw) {
    const ph = parse(phRaw)
    const failure = getInt(ph, 3) ?? 0
    return {
      type: 'punch_hole_response',
      failure,
      relayServer: getStr(ph, 4),
      failureText:
        failure === 2 ? 'OFFLINE' :
        failure === 3 ? 'LICENSE_MISMATCH' :
        failure === 4 ? 'LICENSE_OVERUSE' :
        failure === 0 ? 'ID_NOT_EXIST' : `CODE_${failure}`,
    }
  }
  const rrRaw = getBytes(top, 19)
  if (rrRaw) {
    const rr = parse(rrRaw)
    return {
      type: 'relay_response',
      uuid: getStr(rr, 2),
      relayServer: getStr(rr, 3),
      refuseReason: getStr(rr, 6),
      version: getStr(rr, 7),
    }
  }
  return { type: 'punch_hole_response', failure: 0, relayServer: null, failureText: 'EMPTY' }
}

// ---------- session messages ----------

export const CODEC_FIELD_TO_NAME: Record<number, string> = {
  6: 'vp9',
  10: 'h264',
  11: 'h265',
  12: 'vp8',
  13: 'av1',
}

export interface EncodedVideoFrame {
  data: Uint8Array
  key: boolean
  pts: number
}

export interface ParsedVideoFrame {
  codec: string | null
  frames: EncodedVideoFrame[]
  display: number
}

export function parseVideoFrame(raw: Uint8Array): ParsedVideoFrame {
  const vf = parse(raw)
  for (const f of vf) {
    if (f.wireType !== 2) continue
    const codec = CODEC_FIELD_TO_NAME[f.field]
    if (!codec || (f.value as Uint8Array).length === 0) continue
    const framesRaw = parse(f.value as Uint8Array)
    const frames: EncodedVideoFrame[] = []
    for (const fr of framesRaw) {
      if (fr.field !== 1 || fr.wireType !== 2) continue
      const fd = parse(fr.value as Uint8Array)
      const data = getBytes(fd, 1)
      if (!data) continue
      frames.push({
        data,
        key: (getInt(fd, 2) ?? 0) === 1,
        pts: getInt(fd, 3) ?? 0,
      })
    }
    return { codec, frames, display: getInt(vf, 14) ?? 0 }
  }
  return { codec: null, frames: [], display: getInt(vf, 14) ?? 0 }
}

export interface IdPk {
  id: string | null
  pk: Uint8Array | null
}

export function parseIdPk(raw: Uint8Array): IdPk {
  const fields = parse(raw)
  return { id: getStr(fields, 1), pk: getBytes(fields, 2) }
}

export interface DisplayInfo {
  x: number
  y: number
  width: number
  height: number
  name: string | null
}

export interface ParsedPeerInfo {
  username: string | null
  hostname: string | null
  platform: string | null
  displays: DisplayInfo[]
  currentDisplay: number
  version: string | null
  // What the host *encodes* (PeerInfo.encoding = SupportedEncoding). VP9 has no
  // flag (it is the universal fallback codec), the others are explicit bools.
  encoding: { h264: boolean; h265: boolean; vp8: boolean; av1: boolean } | null
}

export function parsePeerInfo(raw: Uint8Array): ParsedPeerInfo {
  const fields = parse(raw)
  const displays: DisplayInfo[] = []
  for (const f of fields) {
    if (f.field === 4 && f.wireType === 2) {
      const d = parse(f.value as Uint8Array)
      displays.push({
        x: zigzagDecode(getInt(d, 1) ?? 0),
        y: zigzagDecode(getInt(d, 2) ?? 0),
        width: getInt(d, 3) ?? 0,
        height: getInt(d, 4) ?? 0,
        name: getStr(d, 5),
      })
    }
  }
  const encRaw = getBytes(fields, 10)
  let encoding: ParsedPeerInfo['encoding'] = null
  if (encRaw) {
    const e = parse(encRaw)
    encoding = {
      h264: (getInt(e, 1) ?? 0) === 1,
      h265: (getInt(e, 2) ?? 0) === 1,
      vp8: (getInt(e, 3) ?? 0) === 1,
      av1: (getInt(e, 4) ?? 0) === 1,
    }
  }
  return {
    username: getStr(fields, 1),
    hostname: getStr(fields, 2),
    platform: getStr(fields, 3),
    displays,
    currentDisplay: toInt32(getInt(fields, 5) ?? 0),
    version: getStr(fields, 7),
    encoding,
  }
}

// normalize a varint read as unsigned into a signed int32 (e.g. display indexes
// that wrap around after the last monitor).
function toInt32(n: number): number {
  return n >= 0x80000000 ? n - 0x100000000 : n
}

export function parseClipboard(raw: Uint8Array): ParsedClipboard {
  const fields = parse(raw)
  return {
    format: getInt(fields, 5) ?? 0,
    content: getBytes(fields, 2) ?? new Uint8Array(0),
  }
}

export function encodePublicKey(asymmetricValue: Uint8Array, symmetricValue: Uint8Array): Uint8Array {
  const w = new PBWriter().bytesField(1, asymmetricValue).bytesField(2, symmetricValue)
  return new PBWriter().msg(4, w.finish()).finish() // Message.public_key = 4
}

// Non-secure fallback like the official web client: an empty PublicKey tells
// the host to proceed without end-to-end encryption (a plain Hash login
// follows). Used when SignedId cannot be parsed — better a plain session
// than no session.
export function encodeEmptyPublicKey(): Uint8Array {
  return new PBWriter().msg(4, new Uint8Array(0)).finish() // Message.public_key = 4 (empty)
}

export function encodeHash(salt: string, challenge: string): Uint8Array {
  const w = new PBWriter().str(1, salt).str(2, challenge)
  return new PBWriter().msg(9, w.finish()).finish() // Message.hash = 9
}

// Video preferences shared by login and mid-session option updates.
// `quality` is the ImageQuality enum (0 = NotSet, 2 = Low, 3 = Balanced, 4 = Best).
export interface SessionVideoOptions {
  quality?: number
  fps?: number
  audioEnabled?: boolean // default false = disable remote audio on the host
}

// SupportedDecoding.prefer: PreferCodec enum values (message.proto).
export const PREFER_CODEC: Record<'auto' | 'vp9' | 'h264' | 'h265' | 'vp8' | 'av1', number> = {
  auto: 0,
  vp9: 1,
  h264: 2,
  h265: 3,
  vp8: 4,
  av1: 5,
}

export type CodecName = 'vp9' | 'h264' | 'h265' | 'vp8' | 'av1'

export interface SupportedDecodingOptions {
  prefer?: number // PREFER_CODEC value
  abilities?: Partial<Record<CodecName, boolean>>
}

// SupportedDecoding { ability_vp9=1, ability_h264=2, ability_h265=3,
//   prefer=4, ability_vp8=5, ability_av1=6 } — the bare message bytes, embedded
// into OptionMessage.supported_decoding (field 10).
export function buildSupportedDecoding(opts: SupportedDecodingOptions = {}): Uint8Array {
  const sd = new PBWriter()
  const ab = opts.abilities ?? {}
  if (ab.vp9 !== undefined) sd.uint(1, ab.vp9 ? 1 : 0)
  if (ab.h264 !== undefined) sd.uint(2, ab.h264 ? 1 : 0)
  if (ab.h265 !== undefined) sd.uint(3, ab.h265 ? 1 : 0)
  if (opts.prefer !== undefined) sd.uint(4, opts.prefer)
  if (ab.vp8 !== undefined) sd.uint(5, ab.vp8 ? 1 : 0)
  if (ab.av1 !== undefined) sd.uint(6, ab.av1 ? 1 : 0)
  return sd.finish()
}

// Mid-session codec re-negotiation: a supported_decoding-only OptionMessage →
// Misc.option = 7 → Message.misc = 19. The host's update_options() calls
// Encoder::update on it, switching the encoder to the new preferred codec.
export function encodeSupportedDecoding(opts: SupportedDecodingOptions = {}): Uint8Array {
  const opt = new PBWriter().msg(10, buildSupportedDecoding(opts))
  return new PBWriter().msg(19, new PBWriter().msg(7, opt.finish()).finish()).finish()
}

export function encodeLoginRequest(
  peerId: string,
  password: Uint8Array | null,
  sessionId: number,
  video: SessionVideoOptions = {},
  supportedDecoding?: SupportedDecodingOptions,
  clientName = 'Web Browser',
): Uint8Array {
  // Default: VP9, the universal software-decodable codec (official web
  // clients standardize on VP8/VP9 for the same reason: no codec description
  // needed, works in every browser). Hardware codecs are never advertised:
  // the decoder cannot decode them, so inviting the host to send H.264/H.265
  // would black-screen until the runtime fallback steers away.
  const sd = supportedDecoding
    ?? { prefer: PREFER_CODEC.vp9, abilities: { vp9: true, h264: false, h265: false, vp8: true, av1: true } }
  // OptionMessage { image_quality, disable_audio (Yes by default so the host does
  // not stream audio until the user enables it), supported_decoding(10), custom_fps }
  const opt = new PBWriter().msg(10, buildSupportedDecoding(sd))
  const quality = video.quality ?? 3
  if (quality > 0) opt.uint(1, quality)
  opt.uint(7, video.audioEnabled ? 1 : 2) // disable_audio: No=1, Yes=2
  opt.uint(11, video.fps ?? 30)
  const lr = new PBWriter()
    .str(1, peerId)
  // A null password omits field 2 entirely (click-accept variant); an empty
  // hash sends a present-but-empty field. The host treats both as "no
  // secret", but some builds react differently — hence two variants.
  if (password !== null) lr.bytesField(2, password)
  // my_id identifies the client family (the host shows it in parentheses);
  // my_name is the display name, configurable in the admin panel.
  lr.str(4, 'web-client')
    .str(5, clientName || 'Web Browser')
    .msg(6, opt.finish())
    .bool(9, false) // video_ack_required
    .uint(10, sessionId)
    .str(11, '1.3.8')
  return new PBWriter().msg(7, lr.finish()).finish() // Message.login_request = 7
}

export function encodeMiscBool(fieldNum: number, value = true): Uint8Array {
  const misc = new PBWriter().bool(fieldNum, value)
  return new PBWriter().msg(19, misc.finish()).finish() // Message.misc = 19
}

// Text chat with the human at the host: Misc.chat_message = 4 ->
// ChatMessage.text = 1 -> Message.misc = 19. The desktop host pops its chat
// panel on receipt; inbound arrives the same way (see handleMisc field 4).
export const CHAT_MAX_CHARS = 2000
export function encodeChatMessage(text: string): Uint8Array {
  const chat = new PBWriter().str(1, text)
  const misc = new PBWriter().msg(4, chat.finish())
  return new PBWriter().msg(19, misc.finish()).finish() // Message.misc = 19
}

// Second step of two-factor (TOTP) login: Auth2FA { code = 1, hwid = 2 } ->
// Message.auth_2fa = 27. Sent on the same (kept-alive) session after the host
// replied "2FA Required" / "Wrong 2FA Code". Empty hwid keeps the host from
// trusting this (anonymous web) device.
export function encodeAuth2FA(code: string, hwid: Uint8Array = new Uint8Array(0)): Uint8Array {
  const tfa = new PBWriter().str(1, code).bytesField(2, hwid)
  return new PBWriter().msg(27, tfa.finish()).finish()
}

export function encodeOptionUpdate(options: SessionVideoOptions = {}): Uint8Array {
  // OptionMessage { image_quality=quality (omitted when 0/NotSet),
  //                 disable_audio, custom_fps } -> Misc.option = 7.
  const opt = new PBWriter()
  if (options.quality !== undefined && options.quality > 0) opt.uint(1, options.quality)
  if (options.audioEnabled !== undefined) opt.uint(7, options.audioEnabled ? 1 : 2)
  if (options.fps !== undefined) opt.uint(11, options.fps)
  const misc = new PBWriter().msg(7, opt.finish())
  return new PBWriter().msg(19, misc.finish()).finish()
}

// Switch to an explicit display: Misc.switch_display = 5 -> SwitchDisplay { display = index }.
// The real host (src/server/connection.rs) rejects out-of-range indexes, so the
// client must send a concrete target instead of the legacy -1 "next" marker.
export function encodeSwitchDisplay(index: number): Uint8Array {
  const sd = new PBWriter().uint(1, index) // display (int32)
  const misc = new PBWriter().msg(5, sd.finish())
  return new PBWriter().msg(19, misc.finish()).finish()
}

// Request the host to stream its own cursor: OptionMessage.show_remote_cursor =
// 3 (BoolOption: NotSet=0, No=1, Yes=2) inside Misc.option = 7 ->
// Message.misc = 19. Only when set to Yes does the host subscribe the CURSOR
// (cursor_data) and POSITION services — independent of keyboard permission.
export function encodeOptionShowRemoteCursor(enabled: boolean): Uint8Array {
  const opt = new PBWriter().uint(3, enabled ? 2 : 1) // Yes / No
  const misc = new PBWriter().msg(7, opt.finish())
  return new PBWriter().msg(19, misc.finish()).finish()
}

// Message.clipboard = 16 -> Clipboard { format = Text(0), content = utf8 bytes }.
export function encodeClipboardText(text: string): Uint8Array {
  const cb = new PBWriter().uint(5, 0).bytesField(2, new TextEncoder().encode(text))
  return new PBWriter().msg(16, cb.finish()).finish()
}

export interface ParsedClipboard {
  format: number
  content: Uint8Array
}

export function encodeTestDelayEcho(time: number, lastDelay = 0): Uint8Array {
  const td = new PBWriter().uint(1, time).bool(2, false).uint(3, lastDelay)
  return new PBWriter().msg(5, td.finish()).finish() // Message.test_delay = 5
}

// A TestDelay initiated by this client (from_client=true). The host mirrors it
// back with the same timestamp, letting us measure the round trip to the host
// through the relay: RTT = now - time when the echo arrives.
export function encodeTestDelayFromClient(time: number): Uint8Array {
  const td = new PBWriter().uint(1, time).bool(2, true)
  return new PBWriter().msg(5, td.finish()).finish() // Message.test_delay = 5
}

export interface MouseEventBody {
  mask: number
  x: number
  y: number
  modifiers: number[]
}

export function encodeMouseEvent(ev: MouseEventBody): Uint8Array {
  // x/y are sint32 in message.proto -> zigzag-encoded.
  const w = new PBWriter()
    .uint(1, ev.mask)
    .uint(2, zigzagEncode(ev.x))
    .uint(3, zigzagEncode(ev.y))
  for (const m of ev.modifiers) w.uint(4, m)
  return new PBWriter().msg(10, w.finish()).finish() // Message.mouse_event = 10
}

// Relative pointer move (phone trackpad): unsolicited deltas, no absolute
// coordinates. event_type 5 = MOUSE_TYPE_MOVE_RELATIVE -> host clamps to
// +/-10000 and calls mouse_move_relative. x/y are sint32 (zigzag-encoded).
export function encodeMouseRelative(dx: number, dy: number): Uint8Array {
  const w = new PBWriter().uint(1, 5).uint(2, zigzagEncode(dx)).uint(3, zigzagEncode(dy))
  return new PBWriter().msg(10, w.finish()).finish()
}

export interface KeyEventBody {
  down: boolean
  press?: boolean
  controlKey?: number
  chr?: number
  unicodeValue?: number
  modifiers: number[]
  // KeyboardMode: Legacy=0 (default), Map=1, Translate=2, Auto=3.
  mode?: number
}

export function encodeKeyEvent(ev: KeyEventBody): Uint8Array {
  const w = new PBWriter().bool(1, ev.down).bool(2, ev.press ?? false)
  if (ev.controlKey !== undefined) w.uint(3, ev.controlKey)
  else if (ev.chr !== undefined) w.uint(4, ev.chr)
  else if (ev.unicodeValue !== undefined) w.uint(5, ev.unicodeValue)
  for (const m of ev.modifiers) w.uint(8, m)
  w.uint(9, ev.mode ?? 0)
  return new PBWriter().msg(15, w.finish()).finish() // Message.key_event = 15
}

export interface ParsedCursor {
  id: number
  hotx: number
  hoty: number
  width: number
  height: number
  colors: Uint8Array
}

// Message.cursor_data = 12. Two wire schemas exist in the wild:
//  - modern (rustdesk-server 1.1.16, /tmp/msg.proto): single CursorData with
//    { id=1 (uint64), hotx=2 (sint32), hoty=3 (sint32), width=4, height=5,
//      colors=6 }. The colors payload may be raw 32-bit BGRA, zstd-compressed
//    (hosts run hbb_common::compress over it) or a PNG — the length therefore
//    is NOT necessarily width*height*4, so we accept any non-empty payload and
//    let the consumer (RemoteScreen) sniff the magic / validate the size;
//  - legacy: repeated Cursor online_cursors = 1, where Cursor has
//    { id=1, hotx=2 (sint32), hoty=3 (sint32), data=5, flags=7 } and the BMP
//    size is implied (data.length / 4, typically 32x32 or 68x68 for Android).
// Legacy data is always raw BGRA; width/height are explicit in the modern form.
export function parseCursorData(raw: Uint8Array): ParsedCursor | null {
  try {
    return parseCursorDataInner(raw)
  } catch {
    return null // malformed cursor must never kill the message handler
  }
}

function parseCursorDataInner(raw: Uint8Array): ParsedCursor | null {
  let legacy: { hotx: number; hoty: number; data: Uint8Array; flags: number } | null = null
  // Legacy detection: a length-delimited Cursor in field 1.
  for (const f of parse(raw)) {
    if (f.field !== 1 || f.wireType !== 2) continue
    const c = parse(f.value as Uint8Array)
    const data = getBytes(c, 5)
    if (data) {
      legacy = {
        hotx: zigzagDecode(getInt(c, 2) ?? 0),
        hoty: zigzagDecode(getInt(c, 3) ?? 0),
        data,
        flags: toInt32(getInt(c, 7) ?? 0),
      }
    }
  }
  const top = parse(raw)
  const w = toInt32(getInt(top, 4) ?? 0)
  const h = toInt32(getInt(top, 5) ?? 0)
  const colors = getBytes(top, 6)
  if (w > 0 && h > 0 && colors && colors.length > 0) {
    return {
      id: getInt(top, 1) ?? 0,
      hotx: zigzagDecode(getInt(top, 2) ?? 0),
      hoty: zigzagDecode(getInt(top, 3) ?? 0),
      width: w,
      height: h,
      colors,
    }
  }
  if (legacy) {
    const px = legacy.data.length / 4
    let cw = 32
    let ch = 32
    if ((legacy.flags & 1) !== 0) cw = ch = 68
    else if (px === 4096) cw = ch = 32
    else if (px === 16384) cw = ch = 64
    else {
      cw = Math.max(1, Math.round(Math.sqrt(px)))
      ch = Math.max(1, Math.floor(px / cw))
    }
    if (cw * ch * 4 === legacy.data.length) {
      return { id: 0, hotx: legacy.hotx, hoty: legacy.hoty, width: cw, height: ch, colors: legacy.data }
    }
  }
  return null
}

export interface ParsedCursorPosition {
  x: number
  y: number
}

// Message.cursor_position = 13 -> CursorPosition { x = 1 (sint32), y = 2 (sint32) }.
// Used to anchor the local touch trackpad indicator to the real pointer.
export function parseCursorPosition(raw: Uint8Array): ParsedCursorPosition | null {
  const p = parse(raw)
  return { x: zigzagDecode(getInt(p, 1) ?? 0), y: zigzagDecode(getInt(p, 2) ?? 0) }
}

export type ParsedMessage =
  | { kind: 'signed_id'; id: Uint8Array }
  | { kind: 'hash'; salt: Uint8Array; challenge: Uint8Array }
  | { kind: 'login_response'; error: string | null; peerInfo: ParsedPeerInfo | null }
  | { kind: 'video_frame'; codec: string | null; frames: EncodedVideoFrame[]; display: number }
  | { kind: 'audio_frame'; data: Uint8Array }
  | { kind: 'test_delay'; time: number; fromClient: boolean; targetBitrate: number }
  | { kind: 'peer_info'; peerInfo: ParsedPeerInfo }
  | { kind: 'cursor_data'; cursor: ParsedCursor | null }
  | { kind: 'cursor_position'; position: ParsedCursorPosition | null }
  | { kind: 'cursor_id'; id: number }
  | { kind: 'clipboard'; clipboard: ParsedClipboard }
  | { kind: 'misc'; fields: RawField[] }
  | { kind: 'unknown'; fields: RawField[] }

export function parseMessage(buf: Uint8Array): ParsedMessage {
  const fields = parse(buf)
  const pick = (field: number): Uint8Array | null => getBytes(fields, field)

  if (getBytes(fields, 3)) return { kind: 'signed_id', id: pick(3)! }
  if (pick(9)) {
    const h = parse(pick(9)!)
    return {
      kind: 'hash',
      salt: getBytes(h, 1) ?? new Uint8Array(0),
      challenge: getBytes(h, 2) ?? new Uint8Array(0),
    }
  }
  if (pick(8)) {
    const lr = parse(pick(8)!)
    const error = getStr(lr, 1)
    const piRaw = getBytes(lr, 2)
    return {
      kind: 'login_response',
      error,
      peerInfo: piRaw ? parsePeerInfo(piRaw) : null,
    }
  }
  if (pick(6)) {
    const vf = parseVideoFrame(pick(6)!)
    return { kind: 'video_frame', codec: vf.codec, frames: vf.frames, display: vf.display }
  }
  if (pick(11)) return { kind: 'audio_frame', data: pick(11)! }
  if (pick(5)) {
    const td = parse(pick(5)!)
    return {
      kind: 'test_delay',
      time: getInt(td, 1) ?? 0,
      fromClient: (getInt(td, 2) ?? 0) === 1,
      targetBitrate: getInt(td, 4) ?? 0,
    }
  }
  if (pick(25)) return { kind: 'peer_info', peerInfo: parsePeerInfo(pick(25)!) }
  if (pick(12)) return { kind: 'cursor_data', cursor: parseCursorData(pick(12)!) }
  if (pick(13)) return { kind: 'cursor_position', position: parseCursorPosition(pick(13)!) }
  // The host caches cursor bitmaps by id and, once it has handed them out, only
  // re-sends the id reference (input_service.rs:140-149). The viewer must keep
  // its own id -> bitmap cache and substitute the bitmap here.
  if (fields.some((f) => f.field === 14 && f.wireType === 0)) {
    return { kind: 'cursor_id', id: getInt(fields, 14) ?? 0 }
  }
  // Clipboard variants: single Message.clipboard = 16 or repeated
  // MultiClipboards = 28 { repeated Clipboard clipboards = 1 }.
  if (getBytes(fields, 16)) return { kind: 'clipboard', clipboard: parseClipboard(pick(16)!) }
  if (getBytes(fields, 28)) {
    const mc = parse(pick(28)!)
    const first = getBytes(mc, 1)
    if (first) return { kind: 'clipboard', clipboard: parseClipboard(first) }
  }
  if (pick(19)) return { kind: 'misc', fields: parse(pick(19)!) }
  return { kind: 'unknown', fields }
}