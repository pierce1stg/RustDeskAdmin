import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@/locales/en'
import ru from '@/locales/ru'
import zh from '@/locales/zh'
import ar from '@/locales/ar'

export const SUPPORTED_LANGS = ['en', 'ru', 'zh', 'ar'] as const
export type SupportedLang = (typeof SUPPORTED_LANGS)[number]

const STORAGE_KEY = 'rustdesk-admin-lang'

export const LANGUAGE_LABELS: Record<SupportedLang, string> = {
  en: 'English',
  ru: 'Русский',
  zh: '中文（简体）',
  ar: 'العربية',
}

function detectBrowserLang(): SupportedLang | null {
  if (typeof navigator === 'undefined') return null
  const code = (navigator.language || '').split('-')[0].toLowerCase()
  if ((SUPPORTED_LANGS as readonly string[]).includes(code)) return code as SupportedLang
  return null
}

function getSavedLang(): SupportedLang {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (SUPPORTED_LANGS.includes(saved as SupportedLang)) return saved as SupportedLang
  } catch {
    /* ignore */
  }
  return detectBrowserLang() || 'en'
}

export function applyDir(lng: string) {
  document.documentElement.dir = lng === 'ar' ? 'rtl' : 'ltr'
}

export function changeAppLanguage(lng: string) {
  if ((SUPPORTED_LANGS as readonly string[]).includes(lng)) {
    try {
      window.localStorage.setItem(STORAGE_KEY, lng)
    } catch {
      /* ignore */
    }
    applyDir(lng)
    i18n.changeLanguage(lng)
  }
}

const savedLang = getSavedLang()

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    zh: { translation: zh },
    ar: { translation: ar },
  },
  lng: savedLang,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
})

applyDir(savedLang)

export default i18n