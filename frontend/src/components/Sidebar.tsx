
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Home, Settings, Users, Download, LogOut, X } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { usePanelVersion } from '@/api/panel'
import { Button } from '@/components/ui/button'

const navigation = [
  { nameKey: 'nav.dashboard', href: '/', icon: Home },
  { nameKey: 'nav.devices', href: '/devices', icon: Users },
  { nameKey: 'nav.downloadConfig', href: '/download-config', icon: Download },
  { nameKey: 'nav.settings', href: '/settings', icon: Settings },
]

export function Sidebar() {
  const { t } = useTranslation()
  const { logout } = useAuthStore()
  const { sidebarCollapsed: collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useUiStore()
  const { data: version } = usePanelVersion()
  const compact = collapsed && !mobileOpen
  const isRtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl'

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'neu-sidebar fixed inset-y-0 start-0 z-50 flex h-dvh w-64 flex-col transition-transform duration-300 lg:static lg:z-auto lg:translate-x-0 lg:transition-none',
          collapsed ? 'lg:w-16' : 'lg:w-64',
          mobileOpen
            ? 'translate-x-0 shadow-2xl'
            : isRtl
              ? 'translate-x-full'
              : '-translate-x-full'
        )}
      >
        <div className="flex h-16 items-center justify-between px-4">
          {compact ? (
            <NavLink
              to="/"
              onClick={() => setMobileOpen(false)}
              className="flex items-center justify-center"
              aria-label={t('nav.logoLabel')}
            >
              <img src="/favicon.svg" alt="" className="logo-emboss h-11 w-11 rounded-[12px]" />
            </NavLink>
          ) : (
            <NavLink
              to="/"
              onClick={() => setMobileOpen(false)}
              className="flex min-w-0 flex-1 items-center gap-2.5"
              aria-label={t('nav.logoLabel')}
            >
              <img src="/favicon.svg" alt="" className="logo-emboss h-11 w-11 shrink-0 rounded-[12px]" />
              <span className="flex min-w-0 flex-col leading-none">
                <span className="truncate text-[19px] font-extrabold tracking-tight drop-shadow-sm">
                  <span className="text-foreground">Rust</span>
                  <span className="text-primary">Desk</span>
                </span>
                <span className="mt-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground">
                  admin panel
                </span>
              </span>
            </NavLink>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="hidden h-8 w-8 shrink-0 lg:inline-flex"
            onClick={toggleCollapsed}
            title={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          >
            {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 lg:hidden"
            onClick={() => setMobileOpen(false)}
            title={t('nav.closeMenu')}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        <nav className="flex-1 space-y-1.5 overflow-y-auto p-4">
          {navigation.map((item) => (
            <NavLink
              key={item.nameKey}
              to={item.href}
              onClick={() => setMobileOpen(false)}
              className={({ isActive: active }) =>
                cn(
                  'nav-item flex items-center gap-3 px-3 py-2 text-sm font-medium transition-all',
                  active
                    ? 'nav-item-active bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                  compact && 'justify-center'
                )
              }
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!compact && <span>{t(item.nameKey)}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="border-t p-4">
          {!compact && (
            <p
              className="mb-2 px-2 text-[11px] leading-none text-muted-foreground"
              title={t('nav.version')}
            >
              v{version?.version ?? '…'}
            </p>
          )}
          <Button
            variant="ghost"
            className={cn('w-full justify-start', compact && 'justify-center px-2')}
            title={t('nav.logout')}
            onClick={() => {
              logout()
              setMobileOpen(false)
            }}
          >
            <LogOut className={cn('h-4 w-4', !compact && 'me-2')} />
            {!compact && <span>{t('nav.logout')}</span>}
          </Button>
        </div>
      </aside>
    </>
  )
}

function ChevronLeftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}