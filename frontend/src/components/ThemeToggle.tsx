
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notifyThemeChange } from '@/lib/useIsDark'

function initialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  const stored = window.localStorage.getItem('theme')
  if (stored === 'dark' || stored === 'light') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const STAR_PATH =
  'M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z'

export function ThemeToggle() {
  const { t } = useTranslation()
  const [dark, setDark] = useState(initialTheme() === 'dark')

  const handleChange = (checked: boolean) => {
    setDark(checked)
    document.documentElement.classList.toggle('dark', checked)
    window.localStorage.setItem('theme', checked ? 'dark' : 'light')
    notifyThemeChange()
  }

  return (
    <label className="theme-switch" aria-label={t('theme.toggle')} title={t('theme.toggleTitle')}>
      <input
        className="theme-toggle-input"
        type="checkbox"
        checked={dark}
        onChange={(e) => handleChange(e.target.checked)}
      />
      <span className="slider round">
        <span className="sun-moon">
          <svg className="light-ray lr1" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="light-ray lr2" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="light-ray lr3" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="moon-dot md1" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="moon-dot md2" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="moon-dot md3" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="cloud-dark cl1" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="cloud-dark cl2" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="cloud-dark cl3" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="cloud-light cl4" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="cloud-light cl5" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg className="cloud-light cl6" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="50" />
          </svg>
        </span>
        <span className="stars">
          <svg className="star st1" viewBox="0 0 20 20">
            <path d={STAR_PATH} />
          </svg>
          <svg className="star st2" viewBox="0 0 20 20">
            <path d={STAR_PATH} />
          </svg>
          <svg className="star st3" viewBox="0 0 20 20">
            <path d={STAR_PATH} />
          </svg>
          <svg className="star st4" viewBox="0 0 20 20">
            <path d={STAR_PATH} />
          </svg>
        </span>
      </span>
    </label>
  )
}