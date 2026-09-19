import { describe, expect, it } from 'vitest'
import { buildKeyEvent, describeKeyEvent, isPanelInputTarget, shouldForwardToHost } from '../keymap'

describe('buildKeyEvent map mode (known peer OS)', () => {
  it('KeyA on linux/windows/macos uses raw codes', () => {
    expect(buildKeyEvent({ down: true, key: 'a', keyCode: 65, code: 'KeyA', platform: 'linux' })).toMatchObject({
      down: true,
      chr: 38,
      mode: 1,
    })
    expect(buildKeyEvent({ down: true, key: 'a', keyCode: 65, code: 'KeyA', platform: 'Windows 10' })).toMatchObject({
      chr: 30,
      mode: 1,
    })
  })

  it('never sets press in Map mode (official client parity)', () => {
    // press=true on keydown made Windows hosts tap modifiers instead of
    // holding them, killing every combination (see src/keyboard.rs: the
    // desktop client only ever sets press for Legacy Ctrl+Alt+Del).
    for (const down of [true, false]) {
      const body = buildKeyEvent({ down, key: 'Control', keyCode: 17, code: 'ControlLeft', platform: 'Windows' })!
      expect(body.press).toBe(false)
      const key = buildKeyEvent({ down, key: 'c', keyCode: 67, code: 'KeyC', platform: 'Windows 10' })!
      expect(key.press).toBe(false)
      expect(key.mode).toBe(1)
    }
  })

  it('Android maps to linux codes', () => {
    expect(
      buildKeyEvent({ down: true, key: 'a', keyCode: 65, code: 'KeyA', platform: 'Android' }),
    ).toMatchObject({ chr: 38, mode: 1 })
  })
})

describe('buildKeyEvent legacy (unknown peer OS)', () => {
  it('control keys use controlKey', () => {
    expect(buildKeyEvent({ down: true, key: 'Escape', keyCode: 27, platform: null })).toMatchObject({
      controlKey: 8,
    })
    expect(buildKeyEvent({ down: false, key: 'Escape', keyCode: 27 })).toMatchObject({ down: false })
  })

  it('Ctrl+C on RU layout sends US char, not keyCode', () => {
    const ev = buildKeyEvent({
      down: true,
      key: 'с',
      keyCode: 67,
      code: 'KeyC',
      modifiers: ['ctrl'],
      platform: null,
    })!
    expect(ev.chr).toBe('c'.charCodeAt(0))
    expect(ev.modifiers.length).toBeGreaterThan(0)
  })

  it('printable char down sends unicode, up sends null', () => {
    expect(
      buildKeyEvent({ down: true, key: 'ф', keyCode: 1060, platform: null })?.unicodeValue,
    ).toBe('ф'.charCodeAt(0))
    expect(buildKeyEvent({ down: false, key: 'ф', keyCode: 1060, platform: null })).toBeNull()
  })

  it('non-printables without mapping return null', () => {
    expect(buildKeyEvent({ down: true, key: 'Dead', keyCode: 229, platform: null })).toBeNull()
    expect(buildKeyEvent({ down: true, key: 'Unidentified', keyCode: 0, platform: null })).toBeNull()
  })
})

describe('shouldForwardToHost (input capture zone)', () => {
  const canvas = { tagName: 'CANVAS', closest: () => null, isContentEditable: false }
  const select = { tagName: 'SELECT', closest: () => null, isContentEditable: false }
  const dialog = { tagName: 'DIV', closest: (sel: string) => (sel === '[role="dialog"]' ? {} : null) }

  it('forwards only when captured, unpaused, outside panel inputs', () => {
    expect(shouldForwardToHost({ captured: true, paused: false, target: canvas })).toBe(true)
    expect(shouldForwardToHost({ captured: false, paused: false, target: canvas })).toBe(false)
    expect(shouldForwardToHost({ captured: true, paused: true, target: canvas })).toBe(false)
    expect(shouldForwardToHost({ captured: true, paused: false, target: select })).toBe(false)
    expect(shouldForwardToHost({ captured: true, paused: false, target: dialog })).toBe(false)
    expect(shouldForwardToHost({ captured: true, paused: false, target: null })).toBe(true)
  })

  it('isPanelInputTarget matches dialog/inputs, not canvas', () => {
    expect(isPanelInputTarget(canvas)).toBe(false)
    expect(isPanelInputTarget(select)).toBe(true)
    expect(isPanelInputTarget(dialog)).toBe(true)
    expect(isPanelInputTarget(null)).toBe(false)
    expect(isPanelInputTarget({} as never)).toBe(false)
  })
})

describe('describeKeyEvent (debug journal audit)', () => {
  it('legacy shortcut combo with symbol', () => {
    expect(describeKeyEvent({ down: true, chr: 97, modifiers: [4] }, 'Linux')).toBe('down Legacy Ctrl+a')
    expect(describeKeyEvent({ down: false, chr: 97, modifiers: [4] }, 'Linux')).toBe('up Legacy Ctrl+a')
  })

  it('named control keys', () => {
    expect(describeKeyEvent({ down: true, controlKey: 8, modifiers: [] })).toBe('down Legacy Escape')
    expect(describeKeyEvent({ down: true, controlKey: 27, modifiers: [] })).toBe('down Legacy Enter')
    expect(describeKeyEvent({ down: true, controlKey: 999, modifiers: [] })).toBe('down Legacy CK999')
  })

  it('panel synthetic ctrl+alt+del', () => {
    expect(describeKeyEvent({ down: true, controlKey: 100, modifiers: [] })).toBe('down Legacy Ctrl+Alt+Del')
  })

  it('map-mode raw codes resolve with known peer OS', () => {
    expect(describeKeyEvent({ down: true, chr: 38, modifiers: [], mode: 1 }, 'linux')).toBe('down Map KeyA')
    expect(describeKeyEvent({ down: true, chr: 113, modifiers: [], mode: 1 }, 'Linux')).toBe('down Map ArrowLeft')
    expect(describeKeyEvent({ down: true, chr: 30, modifiers: [], mode: 1 }, 'Windows 10')).toBe(
      'down Map KeyA',
    )
  })

  it('map-mode raw codes stay numeric without peer OS', () => {
    expect(describeKeyEvent({ down: true, chr: 38, modifiers: [], mode: 1 }, null)).toBe('down Map raw:38')
    expect(describeKeyEvent({ down: false, chr: 50, modifiers: [], mode: 1 })).toBe('up Map raw:50')
  })

  it('unicode symbols shown as characters', () => {
    expect(describeKeyEvent({ down: true, unicodeValue: 0x444, modifiers: [] })).toBe('down Legacy ф')
    expect(describeKeyEvent({ down: true, unicodeValue: 32, modifiers: [] })).toBe('down Legacy Space')
    expect(describeKeyEvent({ down: true, unicodeValue: 7, modifiers: [] })).toBe('down Legacy U+0007')
  })

  it('press flag and unknown mode degrade gracefully', () => {
    expect(describeKeyEvent({ down: true, press: true, chr: 98, modifiers: [] })).toBe('down Legacy b press')
    expect(describeKeyEvent({ down: true, chr: 99, modifiers: [99], mode: 9 })).toBe('down mode9 mod99+c')
  })

  it('no key at all', () => {
    expect(describeKeyEvent({ down: true, modifiers: [] })).toBe('down Legacy ?')
  })
})
