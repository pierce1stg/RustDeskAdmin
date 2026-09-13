import type { CSSProperties } from 'react'

export interface InstructionColor {
  key: string
  swatch: string
}

const colorDef = (key: string, swatch: string): InstructionColor => ({
  key,
  swatch,
})

export const INSTRUCTION_COLORS: InstructionColor[] = [
  colorDef('blue', '#2563eb'),
  colorDef('green', '#16a34a'),
  colorDef('red', '#dc2626'),
  colorDef('amber', '#d97706'),
  colorDef('purple', '#7c3aed'),
  colorDef('teal', '#0d9488'),
  colorDef('pink', '#db2777'),
]

const INSTRUCTION_COLOR_SWATCHES: Record<string, string> = INSTRUCTION_COLORS.reduce(
  (acc, c) => {
    acc[c.key] = c.swatch
    return acc
  },
  {} as Record<string, string>,
)

export function normalizeHexColor(value: string): string {
  const trimmed = value.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`
  }
  return ''
}

export function isHexColor(value: string): boolean {
  return normalizeHexColor(value) !== ''
}

export function instructionColorSwatch(color: string): string {
  if (color === '') return ''
  return INSTRUCTION_COLOR_SWATCHES[color] || (isHexColor(color) ? normalizeHexColor(color) : '')
}

function textOnColor(color: string): string {
  const hex = normalizeHexColor(color)
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111111' : '#ffffff'
}

// instructionColorStyle overrides the neumorphic button CSS variables so the
// whole button (background, border, shadow and focus ring) takes the requested
// color instead of the default primary blue. Works for preset keys and #rrggbb.
export function instructionColorStyle(color: string): CSSProperties {
  const base = instructionColorSwatch(color)
  if (!base) return {}
  return {
    backgroundColor: base,
    borderColor: base,
    color: textOnColor(base),
    ['--neu-bg' as string]: base,
    ['--neu-bg-hover' as string]: `color-mix(in srgb, ${base} 85%, #000)`,
    ['--neu-fg' as string]: textOnColor(base),
    ['--neu-border' as string]: base,
    ['--neu-shadow' as string]: `6px 6px 12px color-mix(in srgb, ${base} 55%, #000), -6px -6px 12px color-mix(in srgb, ${base} 45%, #fff)`,
    ['--neu-shadow-active' as string]: `inset 4px 4px 12px color-mix(in srgb, ${base} 70%, #000), inset -4px -4px 12px color-mix(in srgb, ${base} 30%, #fff)`,
    ['--neu-active-fg' as string]: textOnColor(base),
    ['--tw-ring-color' as string]: base,
  }
}