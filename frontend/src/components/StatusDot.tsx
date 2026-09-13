import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function StatusDot({ online }: { online: boolean }) {
  const { t } = useTranslation()
  const label = online ? t('dash.online') : t('dash.offline')
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        online
          ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.85)]'
          : 'bg-zinc-400 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)] dark:bg-zinc-600'
      )}
    />
  )
}