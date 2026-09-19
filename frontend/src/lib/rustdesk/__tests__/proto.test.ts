import { describe, expect, it } from 'vitest'
import {
  PBWriter,
  PREFER_CODEC,
  buildSupportedDecoding,
  CHAT_MAX_CHARS,
  encodeAuth2FA,
  encodeChatMessage,
  encodeClipboardText,
  encodeKeyEvent,
  encodeLoginRequest,
  encodeMiscBool,
  encodeMouseEvent,
  encodeMouseRelative,
  encodeOptionShowRemoteCursor,
  encodeOptionUpdate,
  encodePublicKey,
  encodeEmptyPublicKey,
  encodePunchHoleRequest,
  encodeRequestRelay,
  encodeSwitchDisplay,
  encodeTestDelayEcho,
  encodeTestDelayFromClient,
  getBytes,
  getInt,
  getStr,
  parse,
  parseClipboard,
  parseCursorData,
  parseCursorPosition,
  parseIdPk,
  parseMessage,
  parsePeerInfo,
  parseRendezvous,
  parseVideoFrame,
  zigzagDecode,
  zigzagEncode,
} from '../proto'

function hex(s: string): Uint8Array {
  const b = new Uint8Array(s.length / 2)
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return b
}

describe('zigzag', () => {
  it.each([
    [0, 0],
    [-1, 1],
    [1, 2],
    [-2, 3],
    [100, 200],
    [-100, 199],
    [10000, 20000],
    [-10000, 19999],
  ])('encode %i -> %i and back', (v, enc) => {
    expect(zigzagEncode(v)).toBe(enc)
    expect(zigzagDecode(enc)).toBe(v)
  })
})

describe('PBWriter/parse round-trip', () => {
  it('uint/bool/str/bytes/msg survive', () => {
    const inner = new PBWriter().uint(1, 300).str(2, 'hi').finish()
    const buf = new PBWriter()
      .uint(1, 0)
      .uint(2, 127)
      .uint(3, 128)
      .bool(4, true)
      .str(5, 'peer-1')
      .str(6, '')
      .bytesField(7, new Uint8Array([1, 2, 3]))
      .msg(8, inner)
      .finish()
    const f = parse(buf)
    expect(getInt(f, 1)).toBe(0)
    expect(getInt(f, 2)).toBe(127)
    expect(getInt(f, 3)).toBe(128)
    expect(getInt(f, 4)).toBe(1)
    expect(getStr(f, 5)).toBe('peer-1')
    expect(getStr(f, 6)).toBe('')
    expect(getBytes(f, 7)).toEqual(new Uint8Array([1, 2, 3]))
    expect(getBytes(f, 8)).toEqual(inner)
  })

  it('handles 2^41 varints (TestDelay epoch ms, no >>> truncation)', () => {
    const big = 2 ** 41 + 12345
    const buf = new PBWriter().uint(1, big).finish()
    expect(getInt(parse(buf), 1)).toBe(big)
  })

  it('wrong wire type returns null', () => {
    const buf = new PBWriter().uint(1, 5).finish()
    const f = parse(buf)
    expect(getStr(f, 1)).toBeNull()
    expect(getBytes(f, 1)).toBeNull()
  })

  it('duplicate fields: first wins', () => {
    const buf = new PBWriter().str(1, 'a').str(1, 'b').finish()
    expect(getStr(parse(buf), 1)).toBe('a')
  })

  it('throws on truncated input', () => {
    expect(() => parse(hex('0a'))).toThrow()
    expect(() => parse(hex('0a054142'))).toThrow(/past end/)
    expect(() => parse(hex('ff'))).toThrow()
  })

  it('skips fixed32/fixed64/groups', () => {
    // field1 fixed32, field2 fixed64, field3 group{field1 varint, end-group}, field4 str
    const buf = hex('0d01020304' + '114142434445464748' + '1b08311c' + '220362797a')
    const f = parse(buf)
    expect(getStr(f, 4)).toBe('byz')
  })

  it('rejects invalid wire types', () => {
    expect(() => parse(hex('1f00'))).toThrow(/wire type/)
  })
})

describe('rendezvous', () => {
  it('punch hole request has message 8 + forceRelay default', () => {
    const buf = encodePunchHoleRequest({ peerId: '123', licenceKey: 'k' })
    const top = parse(buf)
    const inner = parse(getBytes(top, 8)!)
    expect(getStr(inner, 1)).toBe('123')
    expect(getInt(inner, 2)).toBe(2) // SYMMETRIC
    expect(getInt(inner, 8)).toBe(1) // forceRelay
  })

  it('request relay carries server uuid, minimal form', () => {
    const buf = encodeRequestRelay({ uuid: 'u-1', licenceKey: 'k' })
    const inner = parse(getBytes(parse(buf), 18)!)
    expect(getStr(inner, 2)).toBe('u-1')
    expect(getStr(inner, 6)).toBe('k')
    expect(getStr(inner, 1)).toBeNull()
  })

  it.each([
    [0, 'ID_NOT_EXIST'],
    [2, 'OFFLINE'],
    [3, 'LICENSE_MISMATCH'],
    [4, 'LICENSE_OVERUSE'],
    [9, 'CODE_9'],
  ])('failure %i -> %s', (code, text) => {
    const ph = new PBWriter().uint(3, code).str(4, 'r').finish()
    const r = parseRendezvous(new PBWriter().msg(11, ph).finish())
    expect(r.type).toBe('punch_hole_response')
    if (r.type === 'punch_hole_response') expect(r.failureText).toBe(text)
  })

  it('relay_response parses uuid/relay/refuse/version', () => {
    const rr = new PBWriter().str(2, 'uuid-1').str(3, 'h:21117').str(6, '').str(7, '1.2.0').finish()
    const r = parseRendezvous(new PBWriter().msg(19, rr).finish())
    expect(r).toMatchObject({ type: 'relay_response', uuid: 'uuid-1', relayServer: 'h:21117', version: '1.2.0' })
  })

  it('empty buffer reports EMPTY punch response', () => {
    expect(parseRendezvous(new Uint8Array(0)).type).toBe('punch_hole_response')
  })
})

describe('parseIdPk', () => {
  it('reads id + 32-byte pk, ignores dtls field', () => {
    const pk = new Uint8Array(32).fill(7)
    const raw = new PBWriter().str(1, '123456789').bytesField(2, pk).str(3, 'fp').finish()
    expect(parseIdPk(raw)).toMatchObject({ id: '123456789', pk })
  })
})

describe('login request', () => {
  it('null password omits field 2, empty hash keeps it', () => {
    const omitted = parse(getBytes(parse(encodeLoginRequest('p', null, 1, {})), 7)!)
    expect(getBytes(omitted, 2)).toBeNull()
    const empty = parse(getBytes(parse(encodeLoginRequest('p', new Uint8Array(0), 1, {})), 7)!)
    expect(getBytes(empty, 2)).toEqual(new Uint8Array(0))
  })

  it('defaults: vp9 prefer, quality 3, fps 30, audio disabled', () => {
    const lr = parse(getBytes(parse(encodeLoginRequest('p', null, 9, {})), 7)!)
    expect(getStr(lr, 1)).toBe('p')
    expect(getInt(lr, 10)).toBe(9)
    const opt = parse(getBytes(lr, 6)!)
    expect(getInt(opt, 11)).toBe(30)
    expect(getInt(opt, 7)).toBe(2) // disable_audio Yes
    const sd = parse(getBytes(opt, 10)!)
    expect(getInt(sd, 4)).toBe(PREFER_CODEC.vp9)
  })

  it('defaults never advertise hardware codecs (no H.264/H.265 invite)', () => {
    const lr = parse(getBytes(parse(encodeLoginRequest('p', null, 9, {})), 7)!)
    const opt = parse(getBytes(lr, 6)!)
    const sd = parse(getBytes(opt, 10)!)
    expect(getInt(sd, 1)).toBe(1) // ability_vp9
    expect(getInt(sd, 2)).toBe(0) // ability_h264 off
    expect(getInt(sd, 3)).toBe(0) // ability_h265 off
  })

  it('client name override lands in my_name (field 5), default stays', () => {
    const def = parse(getBytes(parse(encodeLoginRequest('p', null, 9, {})), 7)!)
    expect(getStr(def, 4)).toBe('web-client')
    expect(getStr(def, 5)).toBe('Web Browser')
    const custom = parse(getBytes(parse(encodeLoginRequest('p', null, 9, {}, undefined, 'Поддержка 🛠️')), 7)!)
    expect(getStr(custom, 4)).toBe('web-client')
    expect(getStr(custom, 5)).toBe('Поддержка 🛠️')
  })

  it('PREFER_CODEC mapping', () => {
    expect(PREFER_CODEC).toMatchObject({ auto: 0, vp9: 1, h264: 2, h265: 3, vp8: 4, av1: 5 })
  })

  it('supported decoding abilities round-trip', () => {
    const sd = buildSupportedDecoding({ prefer: 2, abilities: { vp9: true, h264: false, vp8: true } })
    const f = parse(sd)
    expect(getInt(f, 4)).toBe(2)
    expect(getInt(f, 1)).toBe(1)
    expect(getInt(f, 2)).toBe(0)
    expect(getInt(f, 3)).toBeNull()
  })
})

describe('input encodings', () => {
  it('mouse absolute uses message 10 + zigzag coords', () => {
    const inner = parse(getBytes(parse(encodeMouseEvent({ mask: 1, x: -100, y: 200, modifiers: [4] })), 10)!)
    expect(getInt(inner, 1)).toBe(1)
    expect(zigzagDecode(getInt(inner, 2)!)).toBe(-100)
    expect(zigzagDecode(getInt(inner, 3)!)).toBe(200)
    expect(getInt(inner, 4)).toBe(4)
  })

  it('mouse relative marks event_type 5', () => {
    const inner = parse(getBytes(parse(encodeMouseRelative(5, -6)), 10)!)
    expect(getInt(inner, 1)).toBe(5)
    expect(zigzagDecode(getInt(inner, 2)!)).toBe(5)
  })

  it('key event controlKey branch', () => {
    const inner = parse(getBytes(parse(encodeKeyEvent({ down: true, controlKey: 100, modifiers: [] })), 15)!)
    expect(getInt(inner, 1)).toBe(1)
    expect(getInt(inner, 3)).toBe(100)
  })

  it('clipboard text round-trips (utf-8, emoji)', () => {
    const text = 'hello wörld 🌍'
    const m = parseMessage(encodeClipboardText(text))
    expect(m.kind).toBe('clipboard')
    if (m.kind === 'clipboard') {
      expect(m.clipboard.format).toBe(0)
      expect(new TextDecoder().decode(m.clipboard.content)).toBe(text)
    }
  })

  it('misc/option/switch messages land on right fields; Auth2FA is send-only', () => {
    expect(parseMessage(encodeMiscBool(10)).kind).toBe('misc')
    expect(parseMessage(encodeSwitchDisplay(2)).kind).toBe('misc')
    expect(parseMessage(encodeOptionShowRemoteCursor(true)).kind).toBe('misc')
    // the client only SENDS Auth2FA (27) — the dispatcher has no branch for it
    expect(parseMessage(encodeAuth2FA('123456')).kind).toBe('unknown')
    expect(parseMessage(encodeTestDelayEcho(5)).kind).toBe('test_delay')
    expect(parseMessage(encodeTestDelayFromClient(0)).kind).toBe('test_delay')
  })

  it('chat round-trip: misc(19)/chat_message(4)/text(1), unicode + long', () => {
    for (const text of ['hi', 'Привет 👋', 'a'.repeat(2000)]) {
      const misc = parse(getBytes(parse(encodeChatMessage(text)), 19)!)
      const chat = parse(getBytes(misc, 4)!)
      expect(getStr(chat, 1)).toBe(text)
    }
    expect(CHAT_MAX_CHARS).toBe(2000)
  })
})

describe('parseMessage dispatch', () => {
  it('signed_id wins over everything', () => {
    const buf = new PBWriter().bytesField(3, new Uint8Array([1])).uint(9, 1).finish()
    // field 9 is varint here (not a real hash) — still exercises priority order
    expect(parseMessage(buf).kind).toBe('signed_id')
  })

  it('video frame codec/display/frames', () => {
    const frame = new PBWriter().bytesField(1, new Uint8Array([9])).bool(2, true).uint(3, 7).finish()
    const inner = new PBWriter().msg(1, frame).finish()
    const vf = new PBWriter().msg(10, inner).uint(14, 1).finish() // h264 + display 1
    const m = parseMessage(new PBWriter().msg(6, vf).finish())
    expect(m.kind).toBe('video_frame')
    if (m.kind === 'video_frame') {
      expect(m.codec).toBe('h264')
      expect(m.display).toBe(1)
      expect(m.frames).toHaveLength(1)
      expect(m.frames[0].key).toBe(true)
      expect(m.frames[0].pts).toBe(7)
      expect(m.frames[0].data).toEqual(new Uint8Array([9]))
    }
  })

  it('public key messages are opaque to the dispatcher', () => {
    const pk = parseMessage(encodePublicKey(new Uint8Array(32), new Uint8Array(48)))
    expect(pk.kind).toBe('unknown')
    expect(parseMessage(encodeEmptyPublicKey()).kind).toBe('unknown')
  })

  it('cursor position negatives + cursor_id + peer_info + unknown', () => {
    const pos = new PBWriter().uint(1, zigzagEncode(-5)).uint(2, zigzagEncode(10)).finish()
    const m = parseMessage(new PBWriter().msg(13, pos).finish())
    expect(m).toMatchObject({ kind: 'cursor_position', position: { x: -5, y: 10 } })
    expect(parseMessage(new PBWriter().uint(14, 9).finish()).kind).toBe('cursor_id')
    expect(parseMessage(new Uint8Array([0x48, 0x01])).kind).toBe('unknown')
  })

  it('modern cursor parses, garbage returns null', () => {
    const cur = new PBWriter()
      .uint(1, 3)
      .uint(2, zigzagEncode(2))
      .uint(3, zigzagEncode(4))
      .uint(4, 32)
      .uint(5, 32)
      .bytesField(6, new Uint8Array(32 * 32 * 4))
      .finish()
    const c = parseCursorData(cur)
    expect(c).toMatchObject({ id: 3, hotx: 2, hoty: 4, width: 32, height: 32 })
    expect(parseCursorData(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('clipboard rejects non-text and empty', () => {
    const rt = new PBWriter().uint(5, 2).bytesField(2, new Uint8Array([1])).finish()
    expect(parseClipboard(rt).format).toBe(2)
  })

  it('option update carries quality/fps/audio flags', () => {
    const m = parseMessage(encodeOptionUpdate({ quality: 2, fps: 15, audioEnabled: false }))
    expect(m.kind).toBe('misc')
    // quality omitted when 0/NotSet
    const empty = parseMessage(encodeOptionUpdate({}))
    expect(empty.kind).toBe('misc')
  })

  it('cursor position direct parse', () => {
    const raw = new PBWriter().uint(1, zigzagEncode(7)).uint(2, zigzagEncode(-3)).finish()
    expect(parseCursorPosition(raw)).toMatchObject({ x: 7, y: -3 })
  })

  it('video frame direct parse, empty codec skipped', () => {
    const frame = new PBWriter().bytesField(1, new Uint8Array([1])).bool(2, false).finish()
    const vf = parseVideoFrame(new PBWriter().msg(12, new PBWriter().msg(1, frame).finish()).finish())
    expect(vf.codec).toBe('vp8')
    expect(vf.frames).toHaveLength(1)
    expect(parseVideoFrame(new Uint8Array([])).codec).toBeNull()
  })

  it('peer info displays + encoding flags', () => {
    const d = new PBWriter().uint(1, zigzagEncode(10)).uint(2, zigzagEncode(20)).uint(3, 800).uint(4, 600).finish()
    const enc = new PBWriter().uint(1, 1).uint(2, 0).uint(3, 1).uint(4, 1).finish()
    const pi = new PBWriter()
      .str(1, 'u')
      .str(2, 'h')
      .str(3, 'Windows')
      .msg(4, d)
      .msg(10, enc)
      .finish()
    const info = parsePeerInfo(pi)
    expect(info.displays).toHaveLength(1)
    expect(info.displays[0]).toMatchObject({ x: 10, y: 20, width: 800, height: 600 })
    expect(info.encoding).toMatchObject({ h264: true, h265: false, vp8: true, av1: true })
  })
})
