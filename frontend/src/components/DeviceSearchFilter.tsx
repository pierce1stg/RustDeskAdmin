import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  SEARCH_FIELDS,
  SearchConfig,
  SearchOp,
  defaultSearchConfig,
} from '@/lib/deviceSearch'
import { cn } from '@/lib/utils'

const FIELD_LABEL_KEYS: Record<string, string> = {
  alias: 'common.alias',
  peer_id: 'common.deviceId',
  hostname: 'devices.colHost',
  username: 'devices.colUser',
  platform: 'devices.colOS',
  host_version: 'devices.colVersion',
}

const OPS: SearchOp[] = ['contains', 'exact', 'starts']

// Field picker for device search: a lightweight popover anchored to the
// button (no modal, no backdrop dimming), closing on outside click / Esc.
export function DeviceSearchFilter({
  value,
  onChange,
}: {
  value: SearchConfig
  onChange: (cfg: SearchConfig) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const def = defaultSearchConfig()
  const customized = SEARCH_FIELDS.some((f) => value[f].on !== def[f].on || value[f].op !== def[f].op)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open ])

  return (
    <div className="relative shrink-0">
      <Button
        variant="outline"
        size="icon"
        className="relative h-10 w-10"
        onClick={() => setOpen((v) => !v)}
        title={t('devices.searchFilter')}
        aria-label={t('devices.searchFilter')}
        aria-expanded={open}
      >
        <SlidersHorizontal className="h-4 w-4" />
        {customized && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label={t('devices.searchFilter')}
            className="absolute end-0 top-full z-50 mt-2 w-72 rounded-lg border bg-popover p-3 shadow-xl"
          >
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t('devices.searchFields')}</p>
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {SEARCH_FIELDS.map((f) => (
                <label key={f} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-primary"
                    checked={value[f].on}
                    onChange={(e) => onChange({ ...value, [f]: { ...value[f], on: e.target.checked } })}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{t(FIELD_LABEL_KEYS[f])}</span>
                  <select
                    aria-label={t('devices.searchOp')}
                    className={cn(
                      'h-7 shrink-0 rounded-md border border-input bg-background px-1 text-xs',
                      !value[f].on && 'opacity-40'
                    )}
                    value={value[f].op}
                    disabled={!value[f].on}
                    onChange={(e) => onChange({ ...value, [f]: { ...value[f], op: e.target.value as SearchOp } })}
                  >
                    {OPS.map((op) => (
                      <option key={op} value={op}>
                        {t(`devices.op${op[0].toUpperCase()}${op.slice(1)}` as 'devices.opContains')}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end border-t border-border pt-2">
              <Button size="sm" variant="ghost" onClick={() => onChange(defaultSearchConfig())}>
                {t('devices.searchReset')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
