import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRelativeTime(
  lng: string,
  date: string | Date | null | undefined,
  neverLabel?: string
): string {
  if (!date) return neverLabel ?? 'Never'
  const d = new Date(date)
  const diffMs = d.getTime() - Date.now()
  const absMs = Math.abs(diffMs)
  const opts: Intl.RelativeTimeFormatOptions = { numeric: 'auto' }
  if (lng === 'ar') (opts as { numberingSystem?: string }).numberingSystem = 'latn'

  try {
    if (absMs < 60000) {
      return new Intl.RelativeTimeFormat(lng, opts).format(Math.round(diffMs / 1000), 'second')
    }
    if (absMs < 3600000) {
      return new Intl.RelativeTimeFormat(lng, opts).format(Math.round(diffMs / 60000), 'minute')
    }
    if (absMs < 86400000) {
      return new Intl.RelativeTimeFormat(lng, opts).format(Math.round(diffMs / 3600000), 'hour')
    }
    if (absMs < 604800000) {
      return new Intl.RelativeTimeFormat(lng, opts).format(Math.round(diffMs / 86400000), 'day')
    }
    const diffDays = Math.floor(diffMs / 86400000)
    return new Intl.DateTimeFormat(lng === 'zh' ? 'zh-CN' : lng === 'ru' ? 'ru-RU' : lng === 'ar' ? 'ar-EG' : 'en-US', {
      numberingSystem: lng === 'ar' ? 'latn' : undefined,
      month: 'short',
      day: 'numeric',
      year: diffDays > 365 ? 'numeric' : undefined,
    }).format(d)
  } catch {
    return neverLabel ?? 'Never'
  }
}