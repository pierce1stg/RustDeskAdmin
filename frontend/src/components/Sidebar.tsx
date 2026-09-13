
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

const LOGO_FONT =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

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
          {!compact && (
            <NavLink
              to="/"
              onClick={() => setMobileOpen(false)}
              className="flex min-w-0 flex-1 items-center text-primary"
              aria-label={t('nav.logoLabel')}
            >
              <svg
                className="logo-emboss h-9 w-full min-w-0"
                viewBox="0 0 200 32"
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={t('nav.logoLabel')}
              >
                <defs>
                  <linearGradient id="logo-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="currentColor" stopOpacity="0.5" />
                    <stop offset="0.45" stopColor="currentColor" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0.75" />
                  </linearGradient>
                </defs>
                <text
                  x="2"
                  y="24.5"
                  textAnchor="start"
                  fill="url(#logo-grad)"
                  fontSize="18.5"
                  fontWeight="800"
                  letterSpacing="0.5"
                  fontFamily={LOGO_FONT}
                >
                  {t('nav.logoLabel')}
                </text>
              </svg>
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