
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LogOut, Settings, User, Menu } from 'lucide-react'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useUiStore } from '@/stores/ui'
import { logoutRemote } from '@/api/auth'

const TITLES: Record<string, string> = {
  '/': 'nav.dashboard',
  '/devices': 'nav.devices',
  '/settings': 'nav.settings',
  '/download-config': 'nav.downloadConfig',
}

export function Header() {
  const { t } = useTranslation()
  const { setMobileOpen } = useUiStore()
  const location = useLocation()
  const navigate = useNavigate()
  const titleKey = location.pathname.startsWith('/control/') ? 'control.nav' : TITLES[location.pathname]
  const currentTitle = titleKey ? t(titleKey) : ''

  const handleLogout = () => {
    void logoutRemote().finally(() => navigate('/login', { replace: true }))
  }

  return (
    <header className="neu-header sticky top-0 z-30 h-16">
      <div className="flex h-full items-center justify-between px-4 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 lg:hidden"
            onClick={() => setMobileOpen(true)}
            title={t('header.openMenu')}
            aria-label={t('header.openMenu')}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <h1 className="truncate text-xl font-bold">{currentTitle}</h1>
        </div>

        <div className="flex items-center gap-4">
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="neu-ghost-icon relative h-9 w-9 rounded-full"
                title={t('header.user')}
                aria-label={t('header.user')}
              >
                <User className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end" forceMount>
              <DropdownMenuItem asChild>
                <Link to="/settings" className="flex w-full items-center gap-2 px-2 py-1.5 text-sm">
                  <Settings className="h-4 w-4" />
                  {t('nav.settings')}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} className="text-red-600 focus:text-red-600">
                <LogOut className="me-2 h-4 w-4" />
                {t('nav.logout')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}