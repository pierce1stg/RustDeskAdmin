import nacl from './vendor/tweetnacl/nacl-fast'

export function randomBytes(size: number): Uint8Array {
  return nacl.randomBytes(size)
}

export function boxKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

export function sealSymmetricKey(
  symKey: Uint8Array,
  peerPk: Uint8Array,
  ephemeralSecretKey: Uint8Array,
): Uint8Array {
  const zeroNonce = new Uint8Array(nacl.box.nonceLength) // 24 zero bytes
  return nacl.box(symKey, zeroNonce, peerPk, ephemeralSecretKey)
}

export function hexUuid(): string {
  const b = randomBytes(16)
  let s = ''
  for (let i = 0; i < 16; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

// RustDesk session nonce: 8-byte little-endian sequence number + 16 zero bytes.
export function makeSessionNonce(seq: number): Uint8Array {
  const nonce = new Uint8Array(nacl.secretbox.nonceLength) // 24
  const view = new DataView(nonce.buffer)
  view.setBigUint64(0, BigInt(seq), true)
  return nonce
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((acc, c) => acc + c.length, 0)
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export async function sha256Bytes(...chunks: Uint8Array[]): Promise<Uint8Array> {
  const merged = concat(chunks)
  const digest = await crypto.subtle.digest('SHA-256', merged)
  return new Uint8Array(digest)
}

// RustDesk password handshake:
//   final = SHA256( SHA256(password_utf8 + salt) + challenge )
export async function hashRustdeskPassword(
  password: string,
  salt: Uint8Array,
  challenge: Uint8Array,
): Promise<Uint8Array> {
  const intermediate = await sha256Bytes(new TextEncoder().encode(password), salt)
  return sha256Bytes(intermediate, challenge)
}