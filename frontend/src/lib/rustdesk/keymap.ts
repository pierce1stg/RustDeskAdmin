import type { KeyEventBody } from './proto'

// ControlKey enum values from message.proto (0 = Unknown).
export const CONTROL_KEY_MAP: Record<string, number> = {
  Alt: 1,
  Backspace: 2,
  CapsLock: 3,
  Control: 4,
  Delete: 5,
  ArrowDown: 6, // DownArrow
  End: 7,
  Escape: 8,
  F1: 9,
  F10: 10,
  F11: 11,
  F12: 12,
  F2: 13,
  F3: 14,
  F4: 15,
  F5: 16,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  Home: 21,
  ArrowLeft: 22, // LeftArrow
  Meta: 23,
  PageDown: 25,
  PageUp: 26,
  Enter: 27, // Return
  ArrowRight: 28, // RightArrow
  Shift: 29,
  ' ': 30, // Space
  Tab: 31,
  ArrowUp: 32, // UpArrow
  F13: 33,
  F14: 34,
  F15: 35,
  F16: 36,
  F17: 37,
  F18: 38,
  F19: 39,
  F20: 40,
  F21: 41,
  F22: 42,
  F23: 43,
  F24: 44,
  PrintScreen: 45, // PrtScr
  Pause: 46,
  Insert: 58,
  ScrollLock: 62,
  NumLock: 63,
  Print: 45, // some browsers/layouts report 'Print'
}

// Modifier keyname -> ControlKey enum value.
export const MODIFIER_MAP: Record<string, number> = {
  ctrl: 4, // Control
  alt: 1, // Alt
  shift: 29, // Shift
  meta: 23, // Meta
}

export interface BrowserKeyTarget {
  down: boolean
  key: string
  keyCode: number
  code?: string
  modifiers?: string[]
  // Peer OS as reported by the host in PeerInfo (e.g. 'linux', 'windows',
  // 'macos'). When known, raw-keycode (Map mode) input is used.
  platform?: string | null
}

// Physical key (e.code) -> unshifted US character, so shortcuts stay
// layout-independent: Ctrl+C keeps working when the RU layout would otherwise
// produce a Cyrillic 'с' that the host cannot map to a keysym.
const US_CODE_CHAR: Record<string, string> = {
  KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f', KeyG: 'g', KeyH: 'h',
  KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l', KeyM: 'm', KeyN: 'n', KeyO: 'o', KeyP: 'p',
  KeyQ: 'q', KeyR: 'r', KeyS: 's', KeyT: 't', KeyU: 'u', KeyV: 'v', KeyW: 'w', KeyX: 'x',
  KeyY: 'y', KeyZ: 'z',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  IntlBackslash: '\\',
  Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
  Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
  NumpadDecimal: '.', NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/',
}

// Raw keycodes per peer OS (KeyboardMode::Map wire format), derived from the
// rdev keycodes tables used by the RustDesk desktop client:
//   linux   - X11 keycode (= evdev code + 8)
//   windows - Scancode set 1, extended keys carry an 0xE0 high byte
//   macos   - macOS virtual keycode (kVK_*)
// Keyed by the browser KeyboardEvent.code (physical, layout-independent).
const PEER_RAW_KEYCODES: Record<string, { linux?: number; windows?: number; macos?: number }> = {
  "AltLeft": { linux: 64, windows: 56, macos: 58 },
  "AltRight": { linux: 108, windows: 57400, macos: 61 },
  "ArrowDown": { linux: 116, windows: 57424, macos: 125 },
  "ArrowLeft": { linux: 113, windows: 57419, macos: 123 },
  "ArrowRight": { linux: 114, windows: 57421, macos: 124 },
  "ArrowUp": { linux: 111, windows: 57416, macos: 126 },
  "AudioVolumeDown": { linux: 122, windows: 57390, macos: 73 },
  "AudioVolumeMute": { linux: 121, windows: 57376, macos: 74 },
  "AudioVolumeUp": { linux: 123, windows: 57392, macos: 72 },
  "Backquote": { linux: 49, windows: 41, macos: 50 },
  "Backslash": { linux: 51, windows: 43, macos: 42 },
  "Backspace": { linux: 22, windows: 14, macos: 51 },
  "BracketLeft": { linux: 34, windows: 26, macos: 33 },
  "BracketRight": { linux: 35, windows: 27, macos: 30 },
  "CapsLock": { linux: 66, windows: 58, macos: 57 },
  "Comma": { linux: 59, windows: 51, macos: 43 },
  "ContextMenu": { linux: 135, windows: 57437, macos: 110 },
  "ControlLeft": { linux: 37, windows: 29, macos: 59 },
  "ControlRight": { linux: 105, windows: 57373, macos: 62 },
  "Convert": { linux: 100, windows: 121 },
  "Delete": { linux: 119, windows: 57427, macos: 117 },
  "Digit0": { linux: 19, windows: 11, macos: 29 },
  "Digit1": { linux: 10, windows: 2, macos: 18 },
  "Digit2": { linux: 11, windows: 3, macos: 19 },
  "Digit3": { linux: 12, windows: 4, macos: 20 },
  "Digit4": { linux: 13, windows: 5, macos: 21 },
  "Digit5": { linux: 14, windows: 6, macos: 23 },
  "Digit6": { linux: 15, windows: 7, macos: 22 },
  "Digit7": { linux: 16, windows: 8, macos: 26 },
  "Digit8": { linux: 17, windows: 9, macos: 28 },
  "Digit9": { linux: 18, windows: 10, macos: 25 },
  "End": { linux: 115, windows: 57423, macos: 119 },
  "Enter": { linux: 36, windows: 28, macos: 36 },
  "Equal": { linux: 21, windows: 13, macos: 24 },
  "Escape": { linux: 9, windows: 1, macos: 53 },
  "F1": { linux: 67, windows: 59, macos: 122 },
  "F10": { linux: 76, windows: 68, macos: 109 },
  "F11": { linux: 95, windows: 87, macos: 103 },
  "F12": { linux: 96, windows: 88, macos: 111 },
  "F13": { linux: 191, windows: 100, macos: 105 },
  "F14": { linux: 192, windows: 101, macos: 107 },
  "F15": { linux: 193, windows: 102, macos: 113 },
  "F16": { linux: 194, windows: 103, macos: 106 },
  "F17": { linux: 195, windows: 104, macos: 64 },
  "F18": { linux: 196, windows: 105, macos: 79 },
  "F19": { linux: 197, windows: 106, macos: 80 },
  "F2": { linux: 68, windows: 60, macos: 120 },
  "F20": { linux: 198, windows: 107, macos: 90 },
  "F21": { linux: 199, windows: 108 },
  "F22": { linux: 200, windows: 109 },
  "F23": { linux: 201, windows: 110 },
  "F24": { linux: 202, windows: 118 },
  "F3": { linux: 69, windows: 61, macos: 99 },
  "F4": { linux: 70, windows: 62, macos: 118 },
  "F5": { linux: 71, windows: 63, macos: 96 },
  "F6": { linux: 72, windows: 64, macos: 97 },
  "F7": { linux: 73, windows: 65, macos: 98 },
  "F8": { linux: 74, windows: 66, macos: 100 },
  "F9": { linux: 75, windows: 67, macos: 101 },
  "Home": { linux: 110, windows: 57415, macos: 115 },
  "Insert": { linux: 118, windows: 57426, macos: 114 },
  "IntlBackslash": { linux: 94, windows: 86, macos: 10 },
  "IntlRo": { linux: 97, windows: 115, macos: 94 },
  "IntlYen": { linux: 132, windows: 125, macos: 93 },
  "KanaMode": { linux: 101, windows: 112 },
  "KeyA": { linux: 38, windows: 30, macos: 0 },
  "KeyB": { linux: 56, windows: 48, macos: 11 },
  "KeyC": { linux: 54, windows: 46, macos: 8 },
  "KeyD": { linux: 40, windows: 32, macos: 2 },
  "KeyE": { linux: 26, windows: 18, macos: 14 },
  "KeyF": { linux: 41, windows: 33, macos: 3 },
  "KeyG": { linux: 42, windows: 34, macos: 5 },
  "KeyH": { linux: 43, windows: 35, macos: 4 },
  "KeyI": { linux: 31, windows: 23, macos: 34 },
  "KeyJ": { linux: 44, windows: 36, macos: 38 },
  "KeyK": { linux: 45, windows: 37, macos: 40 },
  "KeyL": { linux: 46, windows: 38, macos: 37 },
  "KeyM": { linux: 58, windows: 50, macos: 46 },
  "KeyN": { linux: 57, windows: 49, macos: 45 },
  "KeyO": { linux: 32, windows: 24, macos: 31 },
  "KeyP": { linux: 33, windows: 25, macos: 35 },
  "KeyQ": { linux: 24, windows: 16, macos: 12 },
  "KeyR": { linux: 27, windows: 19, macos: 15 },
  "KeyS": { linux: 39, windows: 31, macos: 1 },
  "KeyT": { linux: 28, windows: 20, macos: 17 },
  "KeyU": { linux: 30, windows: 22, macos: 32 },
  "KeyV": { linux: 55, windows: 47, macos: 9 },
  "KeyW": { linux: 25, windows: 17, macos: 13 },
  "KeyX": { linux: 53, windows: 45, macos: 7 },
  "KeyY": { linux: 29, windows: 21, macos: 16 },
  "KeyZ": { linux: 52, windows: 44, macos: 6 },
  "Lang1": { windows: 242, macos: 104 },
  "Lang2": { windows: 241, macos: 102 },
  "Lang3": { linux: 98, windows: 120 },
  "Lang4": { linux: 99, windows: 119 },
  "Lang5": { linux: 93, windows: 118 },
  "MetaLeft": { linux: 133, windows: 57435, macos: 55 },
  "MetaRight": { linux: 134, windows: 57436, macos: 54 },
  "Minus": { linux: 20, windows: 12, macos: 27 },
  "NonConvert": { linux: 102, windows: 123 },
  "NumLock": { linux: 77, windows: 69, macos: 71 },
  "Numpad0": { linux: 90, windows: 82, macos: 82 },
  "Numpad1": { linux: 87, windows: 79, macos: 83 },
  "Numpad2": { linux: 88, windows: 80, macos: 84 },
  "Numpad3": { linux: 89, windows: 81, macos: 85 },
  "Numpad4": { linux: 83, windows: 75, macos: 86 },
  "Numpad5": { linux: 84, windows: 76, macos: 87 },
  "Numpad6": { linux: 85, windows: 77, macos: 88 },
  "Numpad7": { linux: 79, windows: 71, macos: 89 },
  "Numpad8": { linux: 80, windows: 72, macos: 91 },
  "Numpad9": { linux: 81, windows: 73, macos: 92 },
  "NumpadAdd": { linux: 86, windows: 78, macos: 69 },
  "NumpadComma": { linux: 129, windows: 126, macos: 95 },
  "NumpadDecimal": { linux: 91, windows: 83, macos: 65 },
  "NumpadDivide": { linux: 106, windows: 57397, macos: 75 },
  "NumpadEnter": { linux: 104, windows: 57372, macos: 76 },
  "NumpadEqual": { linux: 125, windows: 89, macos: 81 },
  "NumpadMultiply": { linux: 63, windows: 55, macos: 67 },
  "NumpadSubtract": { linux: 82, windows: 74, macos: 78 },
  "PageDown": { linux: 117, windows: 57425, macos: 121 },
  "PageUp": { linux: 112, windows: 57417, macos: 116 },
  "Period": { linux: 60, windows: 52, macos: 47 },
  "PrintScreen": { linux: 107, windows: 57399 },
  "Quote": { linux: 48, windows: 40, macos: 39 },
  "ScrollLock": { linux: 78, windows: 70 },
  "Semicolon": { linux: 47, windows: 39, macos: 41 },
  "ShiftLeft": { linux: 50, windows: 42, macos: 56 },
  "ShiftRight": { linux: 62, windows: 54, macos: 60 },
  "Slash": { linux: 61, windows: 53, macos: 44 },
  "Space": { linux: 65, windows: 57, macos: 49 },
  "Tab": { linux: 23, windows: 15, macos: 48 },
}

// Map a PeerInfo.platform string to a known peer OS, or null when unknown
// (unknown falls back to Legacy mode).
function peerOsFromPlatform(platform: string | null | undefined): 'linux' | 'windows' | 'macos' | null {
  if (!platform) return null
  const p = platform.toLowerCase()
  if (p.includes('win')) return 'windows'
  if (p.includes('mac') || p.includes('darwin') || p.includes('apple')) return 'macos'
  if (p.includes('linux') || p.includes('android') || p.includes('ubuntu') || p.includes('debian')) return 'linux'
  return null
}

export function buildKeyEvent(target: BrowserKeyTarget): KeyEventBody | null {
  // Raw-keycode (KeyboardMode::Map) input for known peer OSes. This mirrors the
  // desktop client: the physical key is pressed on the host, so shortcuts and
  // text work regardless of the local/host layout, and hotkeys behave on
  // Wayland hosts (where Legacy `chr` would be typed as text). The modifier
  // keys themselves are sent as separate raw-key events (e.g. ControlLeft),
  // which is how the host tracks and holds modifiers.
  const peerOs = peerOsFromPlatform(target.platform)
  if (peerOs && target.code && target.code in PEER_RAW_KEYCODES) {
    const code = PEER_RAW_KEYCODES[target.code][peerOs]
    if (code !== undefined) {
      // press stays false: the official client never sets it in Map mode
      // (verified against src/keyboard.rs — the sole `press = true` there is
      // a Legacy Ctrl+Alt+Del). press=true on keydown made Windows hosts
      // tap modifiers instead of holding them, killing every combination.
      return { down: target.down, press: false, chr: code, modifiers: [], mode: 1 }
    }
  }

  const modifiers = (target.modifiers ?? [])
    .map((m) => MODIFIER_MAP[m])
    .filter((v): v is number => v !== undefined)

  const controlKey = CONTROL_KEY_MAP[target.key]
  if (controlKey !== undefined) {
    return { down: target.down, controlKey, modifiers }
  }

  // Skip non-printable keys (Dead, Process, Unidentified, ...).
  if (target.key.length !== 1) return null

  // Ctrl/Alt/Meta shortcuts: send the actual character along with the modifier
  // flags. Do NOT send a virtual-key code: keyCode is always the uppercase VK
  // (65 for both 'a'/'A'), and the host would infer a Shift for it — producing
  // Ctrl+Shift+A for a plain Ctrl+A. The browser's `key` already reflects the
  // real shift state ('a' vs 'A'), so the host gets exactly what was typed.
  const isShortcut = modifiers.some(
    (m) => m === MODIFIER_MAP.ctrl || m === MODIFIER_MAP.alt || m === MODIFIER_MAP.meta,
  )
  if (isShortcut) {
    // Host Legacy mode: `chr` (union field 4) + modifiers → process_chr with
    // _hotkey=true → char_value_to_key(chr) → en.key_down (physical key press)
    // with the OS modifier held → produces the correct shortcut. Using
    // `unicodeValue` (field 5) would call process_unicode which types the char
    // as text, ignoring modifiers entirely.
    const c = target.code ? (US_CODE_CHAR[target.code] ?? target.key).toLowerCase().charCodeAt(0) : 0
    return { down: target.down, chr: c, modifiers }
  }

  // Regular printable char: send the Unicode code point, only on keydown so the
  // host does not double-type while handling down + up. The character itself
  // already carries the shift state (case/symbol), so no modifiers are attached.
  if (!target.down) return null
  return { down: target.down, unicodeValue: target.key.charCodeAt(0), modifiers: [] }
}

const WIRE_MODE_NAMES = ['Legacy', 'Map', 'Translate', 'Auto']

// Reverse ControlKey map (first name wins on aliases like PrintScreen/Print).
const CONTROL_KEY_NAMES: Record<number, string> = (() => {
  const out: Record<number, string> = {}
  for (const [name, value] of Object.entries(CONTROL_KEY_MAP)) {
    if (!(value in out)) out[value] = name
  }
  return out
})()

const MODIFIER_NAMES: Record<number, string> = { 4: 'Ctrl', 1: 'Alt', 29: 'Shift', 23: 'Meta' }

// Reverse raw-keycode tables per peer OS (value -> physical key name), built
// lazily. First name wins; labels are diagnostic-only, so rare collisions
// (shared values across browser codes) don't matter.
let rawNamesCache: Record<'linux' | 'windows' | 'macos', Record<number, string>> | null = null
function rawKeyNames(): Record<'linux' | 'windows' | 'macos', Record<number, string>> {
  if (!rawNamesCache) {
    rawNamesCache = { linux: {}, windows: {}, macos: {} }
    const osses = ['linux', 'windows', 'macos'] as const
    for (const [code, per] of Object.entries(PEER_RAW_KEYCODES)) {
      for (const os of osses) {
        const v = per[os]
        if (v !== undefined && !(v in rawNamesCache[os])) rawNamesCache[os][v] = code
      }
    }
  }
  return rawNamesCache
}

function charOrCode(cp: number): string {
  if (cp === 32) return 'Space'
  if (cp >= 33 && cp <= 126) return String.fromCharCode(cp)
  if (cp > 126 && cp <= 0x10ffff) {
    try {
      return String.fromCodePoint(cp)
    } catch {
      // lone surrogates etc. — fall through to numeric
    }
  }
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}

// Human-readable one-liner for the debug journal: direction, wire mode,
// modifiers + key as a combo, and the actual symbol for text input.
// Map-mode raw codes resolve to physical key names when the peer OS is
// known, else stay numeric (raw:<n>).
// Examples: "down Legacy Ctrl+a", "up Map ShiftLeft",
// "down Translate ф", "down Legacy Ctrl+Alt+Del".
export function describeKeyEvent(body: KeyEventBody, platform?: string | null): string {
  const dir = body.down ? 'down' : 'up'
  const mode = WIRE_MODE_NAMES[body.mode ?? 0] ?? `mode${body.mode ?? 0}`
  const mods = (body.modifiers ?? []).map((m) => MODIFIER_NAMES[m] ?? `mod${m}`)
  let key: string
  if (body.controlKey !== undefined) {
    // 100 is the panel's synthetic Ctrl+Alt+Del (official client parity).
    if (body.controlKey === 100) key = 'Ctrl+Alt+Del'
    else key = CONTROL_KEY_NAMES[body.controlKey] ?? `CK${body.controlKey}`
  } else if (body.chr !== undefined) {
    if ((body.mode ?? 0) === 1) {
      // Map mode: chr is always an OS raw keycode, never a character — even
      // when the number coincides with ASCII ('&'/38 is KeyA on linux).
      const os = peerOsFromPlatform(platform ?? null)
      key = (os ? rawKeyNames()[os][body.chr] : undefined) ?? `raw:${body.chr}`
    } else {
      const ascii = body.chr >= 32 && body.chr <= 126 ? String.fromCharCode(body.chr) : null
      if (ascii) {
        key = ascii === ' ' ? 'Space' : ascii
      } else {
        key = `raw:${body.chr}`
      }
    }
  } else if (body.unicodeValue !== undefined) {
    key = charOrCode(body.unicodeValue)
  } else {
    key = '?'
  }
  const press = body.press ? ' press' : ''
  return `${dir} ${mode} ${[...mods, key].join('+')}${press}`
}
// Panel focus guard: keyboard events born in panel inputs/dialogs belong
// to the panel, never to the host (typing FPS or a password must not
// type on the remote machine).
export interface PanelTarget {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

export function isPanelInputTarget(t: PanelTarget | null | undefined): boolean {
  if (!t || typeof t.closest !== 'function') return false
  if (t.closest('[role="dialog"]')) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable === true
}

// Keyboard events go to the host ONLY while the pointer is captured inside
// the remote-screen zone (and not paused). Otherwise the page behaves
// natively (panel shortcuts, text selection, form controls). Cursor position
// and keyboard focus are different things — this predicate is the bridge.
export function shouldForwardToHost(opts: {
  captured: boolean
  paused: boolean
  target: PanelTarget | null | undefined
}): boolean {
  if (!opts.captured || opts.paused) return false
  return !isPanelInputTarget(opts.target)
}
