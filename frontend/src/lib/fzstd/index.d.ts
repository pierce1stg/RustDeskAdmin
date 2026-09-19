export const ZstdErrorCode: {
  InvalidData: number
  WindowSizeTooLarge: number
  InvalidBlockType: number
  FSEAccuracyTooHigh: number
  DistanceTooFarBack: number
  UnexpectedEOF: number
}

export function decompress(dat: Uint8Array, buf?: Uint8Array): Uint8Array

export class Decompress {
  constructor(ondata?: (chunk: Uint8Array, isLast: boolean) => void)
  ondata: ((chunk: Uint8Array, isLast: boolean) => void) | null
  push(chunk: Uint8Array, final?: boolean): void
}