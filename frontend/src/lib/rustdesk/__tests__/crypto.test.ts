import { describe, expect, it } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import nacl from '../vendor/tweetnacl/nacl-fast'
import { hashRustdeskPassword, makeSessionNonce, randomBytes, sealSymmetricKey } from '../crypto'

// happy-dom may lack SubtleCrypto: fall back to node's WebCrypto for digests.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

describe('makeSessionNonce', () => {
  it('24 bytes, LE u64 prefix', () => {
    const n0 = makeSessionNonce(0)
    expect(n0).toHaveLength(24)
    expect([...n0.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    const n1 = makeSessionNonce(1)
    expect([...n1.slice(0, 8)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    const nBig = makeSessionNonce(2 ** 32)
    expect([...nBig.slice(0, 8)]).toEqual([0, 0, 0, 0, 1, 0, 0, 0])
    expect([...n0.slice(8)]).toEqual(new Array(16).fill(0))
  })
})

describe('sealSymmetricKey round-trip', () => {
  it('box open recovers the key', () => {
    const sym = randomBytes(32)
    const kp = nacl.box.keyPair()
    const sealed = sealSymmetricKey(sym, kp.publicKey, kp.secretKey)
    const opened = nacl.box.open(sealed, new Uint8Array(24), kp.publicKey, kp.secretKey)
    expect(opened).not.toBeNull()
    expect(opened!).toEqual(sym)
  })

  it('randomBytes length', () => {
    expect(randomBytes(16)).toHaveLength(16)
    expect(randomBytes(32)).toHaveLength(32)
  })
})

describe('hashRustdeskPassword', () => {
  it('matches SHA256(SHA256(pw+salt)+challenge)', async () => {
    const pw = new TextEncoder().encode('s3cret!')
    const salt = new TextEncoder().encode('salty')
    const challenge = new TextEncoder().encode('chall')
    const inter = sha256(Buffer.concat([pw, salt]))
    const expected = sha256(Buffer.concat([inter, challenge]))
    expect(await hashRustdeskPassword('s3cret!', salt, challenge)).toEqual(expected)
  })

  it('empty password hashes deterministically', async () => {
    const salt = new Uint8Array([1, 2, 3])
    const ch = new Uint8Array([4, 5, 6])
    const a = await hashRustdeskPassword('', salt, ch)
    const b = await hashRustdeskPassword('', salt, ch)
    expect(a).toEqual(b)
    expect(a).toHaveLength(32)
  })
})
