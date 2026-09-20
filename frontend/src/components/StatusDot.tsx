import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export type StatusDotState = boolean | 'uncertain'

// Tri-state presence dot: off = definitely offline, green = definitely
// online, yellow = online flag present but the source is uncertain
// (shared socket, unknown source, or activity older than max grace).
// Plain booleans keep working, so stream-only callers are unaffected.
export function StatusDot({ online }: { online: StatusDotState }) {
  const { t } = useTranslation()
  const uncertain = online === 'uncertain'
  const on = online === true
  const label = uncertain ? t('dash.uncertain') : on ? t('dash.online') : t('dash.offline')
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        uncertain
          ? 'bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.85)]'
          : on
            ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.85)]'
            : 'bg-zinc-400 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)] dark:bg-zinc-600'
      )}
    />
  )
}