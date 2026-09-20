import { describe, expect, it } from 'vitest'
import {
  defaultSearchConfig,
  loadSearchConfig,
  saveSearchConfig,
  searchConfigToParams,
} from '../deviceSearch'

describe('searchConfigToParams', () => {
  it('default serializes to nothing', () => {
    expect(searchConfigToParams(defaultSearchConfig())).toEqual({})
  })

  it('serializes field toggles', () => {
    const cfg = defaultSearchConfig()
    cfg.username.on = false
    cfg.platform.on = false
    cfg.host_version.on = false
    expect(searchConfigToParams(cfg)).toEqual({ fields: 'alias,peer_id,hostname' })
  })

  it('serializes non-default ops', () => {
    const cfg = defaultSearchConfig()
    cfg.peer_id.op = 'exact'
    cfg.alias.op = 'starts'
    expect(searchConfigToParams(cfg)).toEqual({ ops: 'alias:starts,peer_id:exact' })
  })

  it('empty field set is passed through (backend shows all)', () => {
    const cfg = defaultSearchConfig()
    for (const f of Object.keys(cfg) as (keyof typeof cfg)[]) cfg[f].on = false
    expect(searchConfigToParams(cfg)).toEqual({ fields: '' })
  })
})

describe('load/saveSearchConfig', () => {
  it('round-trips through storage', () => {
    const store: Record<string, string> = {}
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
    }
    const cfg = defaultSearchConfig()
    cfg.peer_id.op = 'exact'
    cfg.username.on = false
    saveSearchConfig(cfg, storage)
    expect(loadSearchConfig(storage)).toEqual(cfg)
  })

  it('sanitizes garbage', () => {
    const storage = {
      getItem: () => '{"peer_id":{"on":"yes","op":"regex"},"bogus":{}}',
    }
    const cfg = loadSearchConfig(storage)
    expect(cfg).toEqual(defaultSearchConfig())
    expect(loadSearchConfig({ getItem: () => '{broken' })).toEqual(defaultSearchConfig())
  })

  it('tolerates missing storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('nope')
      },
      setItem: () => {
        throw new Error('nope')
      },
    }
    expect(loadSearchConfig(broken)).toEqual(defaultSearchConfig())
    expect(() => saveSearchConfig(defaultSearchConfig(), broken)).not.toThrow()
  })
})
