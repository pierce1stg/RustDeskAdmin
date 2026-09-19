import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { DevicesPage } from '@/pages/DevicesPage'
import { RemoteControlPage } from '@/pages/RemoteControlPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { DownloadPage } from '@/pages/DownloadPage'
import { DownloadConfigPage } from '@/pages/DownloadConfigPage'
import { Layout } from '@/components/Layout'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="control/:id" element={<RemoteControlPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="download-config" element={<DownloadConfigPage />} />
      </Route>
      <Route path="/download" element={<DownloadPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}