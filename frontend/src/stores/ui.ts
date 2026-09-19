import { create } from 'zustand'

interface UiState {
  sidebarCollapsed: boolean
  mobileOpen: boolean
  toggleCollapsed: () => void
  setMobileOpen: (open: boolean) => void
}

const SIDEBAR_KEY = 'rd-sidebar-collapsed'

function loadCollapsed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

export const useUiStore = create<UiState>()((set) => ({
  sidebarCollapsed: loadCollapsed(),
  // mobileOpen deliberately never persists: the drawer always starts closed.
  mobileOpen: false,
  toggleCollapsed: () =>
    set((s) => {
      const next = !s.sidebarCollapsed
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      } catch {
        // private mode — collapse state simply doesn't persist
      }
      return { sidebarCollapsed: next }
    }),
  setMobileOpen: (open) => set({ mobileOpen: open }),
}))