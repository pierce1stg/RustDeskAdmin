import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { PBWriter, getStr, parse } from '../proto'
import { WebRustDeskSession, selectAutoTarget, autoDiffNeed, type SessionEvent } from '../session'
import nacl from '../vendor/tweetnacl/nacl-fast'
import { makeSessionNonce } from '../crypto'

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

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
  closed = false

  constructor(url: string) {
    this.url = url
    MockWS.instances.push(this)
  }

  send(data: Uint8Array) {
    this.sent.push(new Uint8Array(data))
  }

  close() {
    this.readyState = 3
    this.closed = true
  }

  fireOpen() {
    this.onopen?.(undefined as never)
  }

  peerEmit(data: Uint8Array) {
    const copy = new Uint8Array(data.length)
    copy.set(data)
    this.onmessage?.({ data: copy.buffer as ArrayBuffer })
  }
}

function lastSentOf(ws: MockWS, n = -1): Uint8Array {
  return ws.sent.at(n)!
}

function topField(buf: Uint8Array): number {
  return buf[0] >> 3
}

// SubtleCrypto digests resolve slower than one macrotask: poll instead of
// assuming a single setTimeout flushes the whole async login chain.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function makeSession(onEvent: (ev: SessionEvent) => void) {
  return new WebRustDeskSession(
    {
      address: 'h',
      serverKey: '',
      peerId: '123',
      password: 'pw',
      relayServer: 'h:21117',
      video: { quality: 3, fps: 30, audioEnabled: false },
    },
    onEvent,
  )
}

function loginResponseOk(): Uint8Array {
  const lr = new PBWriter().finish()
  return new PBWriter().msg(8, lr).finish()
}

function loginResponseError(text: string): Uint8Array {
  const lr = new PBWriter().str(1, text).finish()
  return new PBWriter().msg(8, lr).finish()
}

function hashMsg(): Uint8Array {
  const h = new PBWriter()
    .bytesField(1, new Uint8Array([1, 2, 3]))
    .bytesField(2, new Uint8Array([4, 5, 6]))
    .finish()
  return new PBWriter().msg(9, h).finish()
}

function signedIdMsg(peerId: string, pk: Uint8Array): Uint8Array {
  const sig = new Uint8Array(64).fill(9)
  const idpk = new PBWriter().str(1, peerId).bytesField(2, pk).finish()
  const id = new Uint8Array([...sig, ...idpk])
  return new PBWriter().bytesField(3, id).finish()
}

beforeEach(() => {
  MockWS.instances = []
  localStorage.clear()
  vi.stubGlobal('WebSocket', MockWS)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function driveFullHandshake(events: SessionEvent[]) {
  const session = makeSession((ev) => events.push(ev))
  session.connect()
  const idWs = MockWS.instances[0]
  expect(idWs.url).toContain('/ws/id')
  idWs.fireOpen()
  // punch request went out
  expect(topField(lastSentOf(idWs))).toBe(8)
  // server answers relay_response directly (official flow)
  const rr = new PBWriter().str(2, 'uuid-1').str(3, 'h:21117').str(7, '1.2.0').finish()
  idWs.peerEmit(new PBWriter().msg(19, rr).finish())
  const relayWs = MockWS.instances[1]
  expect(relayWs.url).toContain('/ws/relay')
  relayWs.fireOpen()
  // single RequestRelay with the SERVER uuid
  expect(topField(lastSentOf(relayWs))).toBe(18)
  // signed_id from host (standard 64-byte prefix layout)
  const pk = new Uint8Array(32).fill(5)
  relayWs.peerEmit(signedIdMsg('123', pk))
  // client answers with PublicKey (message 4)
  expect(topField(lastSentOf(relayWs))).toBe(4)
  // host sends hash challenge
  const ch = makeChannel()
  ch.sendEnc(relayWs, session, hashMsg())
  // login request went out (decrypted: field 7)
  await waitFor(() => ch.sentKinds(relayWs, session).includes(7))
  // host accepts
  ch.sendEnc(relayWs, session, loginResponseOk())
  return { session, idWs, relayWs, ch }
}

// Post-handshake the relay channel is secretbox-encrypted: mirror the
// session's recvSeq (starts at 0, ++ per received message) to speak to it,
// and decrypt everything the session sends (RequestRelay + PublicKey go out
// plaintext BEFORE the key exists; the rest is ciphertext).
function makeChannel() {
  let recvSeq = 0
  const symkeyOf = (session: WebRustDeskSession): Uint8Array | null =>
    (session as unknown as { symmetricKey: Uint8Array | null }).symmetricKey

  const sendEnc = (relayWs: MockWS, session: WebRustDeskSession, payload: Uint8Array) => {
    const key = symkeyOf(session)
    if (!key) throw new Error('no session key yet')
    recvSeq++
    relayWs.peerEmit(nacl.secretbox(payload, makeSessionNonce(recvSeq), key))
  }

  // Trial-decrypt each outbound message with a FRESH counter per call:
  // plaintext pre-key messages fail open and fall back to raw parsing.
  const kindsOf = (relayWs: MockWS, session: WebRustDeskSession): number[] => {
    const key = symkeyOf(session)
    let seq = 0
    return relayWs.sent.map((b) => {
      if (key) {
        const opened = nacl.secretbox.open(b, makeSessionNonce(seq + 1), key)
        if (opened) {
          seq++
          return opened[0] >> 3
        }
      }
      return b[0] >> 3
    })
  }

  const sentKinds = (relayWs: MockWS, session: WebRustDeskSession): number[] => kindsOf(relayWs, session)

  const findSent = (relayWs: MockWS, session: WebRustDeskSession, field: number): Uint8Array => {
    const key = symkeyOf(session)
    let seq = 0
    for (const b of relayWs.sent) {
      let raw = b
      if (key) {
        const opened = nacl.secretbox.open(b, makeSessionNonce(seq + 1), key)
        if (opened) {
          seq++
          raw = opened
        }
      }
      if (raw[0] >> 3 === field) return raw
    }
    throw new Error(`no sent message with field ${field}`)
  }

  return { sendEnc, sentKinds, findSent }
}

describe('handshake happy path', () => {
  it('connects end-to-end and emits connected', async () => {
    const events: SessionEvent[] = []
    const { session } = await driveFullHandshake(events)
    expect(events.some((e) => e.type === 'status' && e.status === 'connected')).toBe(true)
    session.disconnect()
  })

  it('login request carries peer id + options', async () => {
    const events: SessionEvent[] = []
    const { session, relayWs, ch } = await driveFullHandshake(events)
    const login = ch.findSent(relayWs, session, 7)
    const lr = parse(
      (function () {
        for (const f of parse(login)) if (f.field === 7 && f.wireType === 2) return f.value as Uint8Array
        throw new Error('no login_request')
      })(),
    )
    expect(getStr(lr, 1)).toBe('123')
    session.disconnect()
  })
})

describe('plain fallback (garbage SignedId)', () => {
  async function relayReady(events: SessionEvent[]) {
    const session = makeSession((ev) => events.push(ev))
    session.connect()
    const idWs = MockWS.instances[0]
    idWs.fireOpen()
    const rr = new PBWriter().str(2, 'u9').str(3, 'h:21117').finish()
    idWs.peerEmit(new PBWriter().msg(19, rr).finish())
    const relayWs = MockWS.instances[1]
    relayWs.fireOpen()
    relayWs.sent = []
    return { session, relayWs }
  }

  it('sends empty PublicKey and proceeds to Hash login', async () => {
    const events: SessionEvent[] = []
    const { session, relayWs } = await relayReady(events)
    // complete envelope, unparseable IdPk inside
    const garbage = new Uint8Array([0x1a, 0x05, 0xff, 0xff, 0xff, 0xff, 0xff])
    relayWs.peerEmit(garbage)
    // empty PublicKey fallback must go out (message 4, empty payload)
    expect(relayWs.sent.length).toBe(1)
    expect(topField(relayWs.sent[0])).toBe(4)
    // host answers with hash -> plain login proceeds (plaintext channel here)
    relayWs.peerEmit(hashMsg())
    await waitFor(() => relayWs.sent.some((b) => topField(b) === 7))
    relayWs.peerEmit(loginResponseOk())
    expect(events.some((e) => e.type === 'status' && e.status === 'connected')).toBe(true)
    session.disconnect()
  })

  it('reassembles a first message split across two frames', async () => {
    const events: SessionEvent[] = []
    const { session, relayWs } = await relayReady(events)
    const pk = new Uint8Array(32).fill(5)
    const full = signedIdMsg('123', pk)
    const part1 = full.slice(0, 100)
    const part2 = full.slice(100)
    relayWs.peerEmit(part1)
    // incomplete: nothing sent yet, still waiting
    expect(relayWs.sent.length).toBe(0)
    relayWs.peerEmit(part2)
    // completed envelope -> PublicKey out
    expect(relayWs.sent.length).toBe(1)
    expect(topField(relayWs.sent[0])).toBe(4)
    session.disconnect()
  })
})

describe('rendezvous failures', () => {
  it('relay refused surfaces error', () => {
    const events: SessionEvent[] = []
    const session = makeSession((ev) => events.push(ev))
    session.connect()
    const idWs = MockWS.instances[0]
    idWs.fireOpen()
    const rr = new PBWriter().str(6, 'denied by policy').finish()
    idWs.peerEmit(new PBWriter().msg(19, rr).finish())
    expect(events.some((e) => e.type === 'error')).toBe(true)
    session.disconnect()
  })

  it('offline peer (failure 2) surfaces error, no relay opened', () => {
    const events: SessionEvent[] = []
    const session = makeSession((ev) => events.push(ev))
    session.connect()
    const idWs = MockWS.instances[0]
    idWs.fireOpen()
    const ph = new PBWriter().uint(3, 2).finish()
    idWs.peerEmit(new PBWriter().msg(11, ph).finish())
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(MockWS.instances).toHaveLength(1)
    session.disconnect()
  })
})

describe('login branches', () => {
  async function loginTo(events: SessionEvent[]) {
    const session = makeSession((ev) => events.push(ev))
    const ch = makeChannel()
    session.connect()
    const idWs = MockWS.instances[0]
    idWs.fireOpen()
    const rr = new PBWriter().str(2, 'u2').str(3, 'h:21117').finish()
    idWs.peerEmit(new PBWriter().msg(19, rr).finish())
    const relayWs = MockWS.instances[1]
    relayWs.fireOpen()
    relayWs.peerEmit(signedIdMsg('123', new Uint8Array(32).fill(5)))
    ch.sendEnc(relayWs, session, hashMsg())
    await waitFor(() => ch.sentKinds(relayWs, session).includes(7))
    return { session, relayWs, ch }
  }

  it('No Password Access -> approval-pending, session alive', async () => {
    const events: SessionEvent[] = []
    const { session, relayWs, ch } = await loginTo(events)
    ch.sendEnc(relayWs, session, loginResponseError('No Password Access'))
    expect(events.some((e) => e.type === 'approval-pending')).toBe(true)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    // later accept still connects
    ch.sendEnc(relayWs, session, loginResponseOk())
    expect(events.some((e) => e.type === 'status' && e.status === 'connected')).toBe(true)
    session.disconnect()
  })

  it('2FA Required -> two-fa, session alive, Auth2FA sends message 27', async () => {
    const events: SessionEvent[] = []
    const { session, relayWs, ch } = await loginTo(events)
    ch.sendEnc(relayWs, session, loginResponseError('2FA Required'))
    expect(events.some((e) => e.type === 'two-fa')).toBe(true)
    session.submit2FACode('123456')
    expect(ch.sentKinds(relayWs, session)).toContain(27)
    session.disconnect()
  })

  it('Wrong Password -> error', async () => {
    const events: SessionEvent[] = []
    const { session, relayWs, ch } = await loginTo(events)
    ch.sendEnc(relayWs, session, loginResponseError('Wrong Password'))
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeTruthy()
    session.disconnect()
  })
})

describe('selectAutoTarget (auto-quality hysteresis)', () => {
  const base = { decodeMs: 10, paintMs: 8, queueWaitMs: 20, queueDropsGrew: false, stuckTicks: 0 }
  it('picks bands by throughput and ping', () => {
    expect(selectAutoTarget({ ...base, kbps: 500, pingMs: 40, current: { quality: 3, fps: 30 } })).toEqual({
      quality: 2,
      fps: 15,
    })
    expect(selectAutoTarget({ ...base, kbps: 2000, pingMs: 40, current: { quality: 3, fps: 30 } })).toEqual({
      quality: 3,
      fps: 30,
    })
    expect(selectAutoTarget({ ...base, kbps: 9000, pingMs: 40, current: { quality: 3, fps: 30 } })).toEqual({
      quality: 4,
      fps: 60,
    })
    expect(selectAutoTarget({ ...base, kbps: 9000, pingMs: 300, current: { quality: 4, fps: 60 } })).toEqual({
      quality: 2,
      fps: 15,
    })
  })
  it('unknown ping holds the level instead of gambling up', () => {
    expect(
      selectAutoTarget({ ...base, kbps: 9000, pingMs: null, current: { quality: 3, fps: 30 } }),
    ).toEqual({ quality: 3, fps: 30 })
    // ...but still allows downshifts on bad throughput.
    expect(selectAutoTarget({ ...base, kbps: 500, pingMs: null, current: { quality: 4, fps: 60 } })).toEqual({
      quality: 2,
      fps: 15,
    })
  })
  it('decoder-side strain steps one level down', () => {
    const good = { ...base, kbps: 9000, pingMs: 40, current: { quality: 4, fps: 60 } }
    expect(selectAutoTarget({ ...good, decodeMs: 55 })).toEqual({ quality: 3, fps: 30 })
    expect(selectAutoTarget({ ...good, paintMs: 30 })).toEqual({ quality: 3, fps: 30 })
    expect(selectAutoTarget({ ...good, queueWaitMs: 200 })).toEqual({ quality: 3, fps: 30 })
    expect(selectAutoTarget({ ...good, queueDropsGrew: true })).toEqual({ quality: 3, fps: 30 })
    expect(selectAutoTarget({ ...good, current: { quality: 2, fps: 15 }, decodeMs: 55 })).toEqual({ quality: 3, fps: 30 })
  })
  it('deep floor (1/10) after two stuck ticks, single tick still bands', () => {
    const stuck = { ...base, kbps: 9000, pingMs: 40, queueWaitMs: 400, current: { quality: 2, fps: 15 } }
    // One stuck tick: bands + one strain step (3/30), not the deep floor yet.
    expect(selectAutoTarget({ ...stuck, stuckTicks: 1 })).toEqual({ quality: 3, fps: 30 })
    // Two stuck ticks: the only lever left is sending less.
    expect(selectAutoTarget({ ...stuck, stuckTicks: 2 })).toEqual({ quality: 1, fps: 10 })
    expect(selectAutoTarget({ ...stuck, stuckTicks: 5 })).toEqual({ quality: 1, fps: 10 })
    // Recovery: streak reset -> normal bands (upshift path).
    expect(selectAutoTarget({ ...stuck, stuckTicks: 0, queueWaitMs: 20 })).toEqual({ quality: 4, fps: 60 })
  })
})

describe('autoDiffNeed (hysteresis thresholds)', () => {
  it('first decision from unset (quality 0) is always fast', () => {
    expect(autoDiffNeed({ quality: 0, fps: 60 }, { quality: 2, fps: 15 })).toBe(3)
    expect(autoDiffNeed({ quality: 0, fps: 60 }, { quality: 4, fps: 60 })).toBe(3)
    expect(autoDiffNeed({ quality: 0, fps: 60 }, { quality: 1, fps: 10 })).toBe(3)
  })

  it('down fast, up slow', () => {
    expect(autoDiffNeed({ quality: 3, fps: 30 }, { quality: 2, fps: 15 })).toBe(3)
    expect(autoDiffNeed({ quality: 2, fps: 15 }, { quality: 3, fps: 30 })).toBe(6)
    expect(autoDiffNeed({ quality: 3, fps: 30 }, { quality: 4, fps: 60 })).toBe(6)
    expect(autoDiffNeed({ quality: 4, fps: 60 }, { quality: 1, fps: 10 })).toBe(3)
  })
})
