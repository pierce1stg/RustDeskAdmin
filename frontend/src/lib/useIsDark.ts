import { useSyncExternalStore } from 'react'

function subscribeToTheme(callback: () => void) {
  if (typeof window === 'undefined') {
    return () => {}
  }
  const observer = new MutationObserver(callback)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('themechange', callback)
  return () => {
    observer.disconnect()
    window.removeEventListener('themechange', callback)
  }
}

function isDark() {
  if (typeof window === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeToTheme, isDark)
}

export function notifyThemeChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('themechange'))
  }
}