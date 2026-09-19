declare namespace nacl {
  export interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }
}

declare const nacl: {
  randomBytes(length: number): Uint8Array;
  box: {
    (message: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(
      message: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array | null;
    keyPair(): nacl.BoxKeyPair;
    nonceLength: number;
    publicKeyLength: number;
    secretKeyLength: number;
  };
  secretbox: {
    (message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    keyLength: number;
    nonceLength: number;
  };
};

export default nacl;