
import { Link } from 'react-router-dom'
import axios from 'axios'
import { Monitor, Wifi, WifiOff, RefreshCw, Settings as SettingsIcon, ChevronRight, ChevronDown, Copy, Check, Link2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StatusDot } from '@/components/StatusDot'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useDevices, useDeviceOnlineStream } from '@/api/devices'
import { useServerStatus, ServerStatusConn } from '@/api/status'
import { useConnectCode } from '@/api/serverInfo'
import { useSettings, STATUS_UPDATE_MODE_KEY, STATUS_UPDATE_MODE_PUSH } from '@/api/settings'
import { useToast } from '@/hooks/use-toast'
import { formatRelativeTime, cn } from '@/lib/utils'

// Max rows in the "Recent Devices" table. Kept small so the table (and the
// page below it) keeps a stable height when the device count changes.
const RECENT_DEVICES_LIMIT = 3

export function DashboardPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading, refetch } = useDevices({ limit: RECENT_DEVICES_LIMIT })
  const onlineQuery = useDevices({ limit: 1, online: true })
  const offlineQuery = useDevices({ limit: 1, online: false })
  const { data: serverStatus } = useServerStatus()

  const { data: settings } = useSettings()
  const pushEnabled = (settings?.[STATUS_UPDATE_MODE_KEY] ?? STATUS_UPDATE_MODE_PUSH) === STATUS_UPDATE_MODE_PUSH
  const { online: onlineSet, onlineCount, streamActive } = useDeviceOnlineStream(pushEnabled)

  const total = data?.total ?? 0
  const online = streamActive && onlineCount != null ? onlineCount : onlineQuery.data?.total ?? 0
  const offline = streamActive && onlineCount != null ? Math.max(0, total - onlineCount) : offlineQuery.data?.total ?? 0

  const deviceOnline = (deviceId: string, fallback: boolean) => (streamActive ? onlineSet.has(deviceId) : fallback)

  const handleRefresh = () => {
    void refetch()
    queryClient.invalidateQueries({ queryKey: ['devices'] })
    queryClient.invalidateQueries({ queryKey: ['server-status'] })
    queryClient.invalidateQueries({ queryKey: ['server-info'] })
  }

  return (
    <div className="w-full min-w-0 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-muted-foreground">{t('dash.overview')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="me-2 h-4 w-4" /> {t('common.refresh')}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dash.totalDevices')}</CardTitle>
            <Monitor className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="neu-title text-2xl font-bold">{isLoading ? '...' : total}</div>
            <p className="text-xs text-muted-foreground">{t('dash.totalDevicesHint')}</p>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dash.online')}</CardTitle>
            <Wifi className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="neu-title text-2xl font-bold text-green-600">{online}</div>
            <p className="text-xs text-muted-foreground">{t('dash.onlineHint')}</p>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dash.offline')}</CardTitle>
            <WifiOff className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="neu-title text-2xl font-bold">{offline}</div>
            <p className="text-xs text-muted-foreground">{t('dash.offlineHint')}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t('dash.recentDevices')}</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/devices" className="flex items-center gap-1">
                {t('dash.viewAll')} <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex min-h-[13.5rem] items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : (
              <div className="overflow-x-auto min-h-[13.5rem]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">{t('common.status')}</TableHead>
                      <TableHead>{t('common.deviceId')}</TableHead>
                      <TableHead>{t('common.alias')}</TableHead>
                      <TableHead className="w-32">{t('common.lastSeen')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.items ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-[10.5rem] text-center text-muted-foreground">
                          {t('dash.noDevices')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      (data?.items ?? []).map((device) => (
                        <TableRow key={device.id}>
                          <TableCell>
                            <StatusDot online={deviceOnline(device.peer_id, device.online)} />
                          </TableCell>
                          <TableCell className="font-mono text-sm">{device.peer_id}</TableCell>
                          <TableCell>{device.alias ?? t('devices.noAlias')}</TableCell>
                          <TableCell>{formatRelativeTime(i18n.language, device.last_seen, t('devices.never'))}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t('dash.server')}</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/settings">
                <SettingsIcon className="h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            <ServerConnRow
              label={t('dash.idServer')}
              unit={t('dash.devicesUnit')}
              listening={serverStatus?.hbbs_listening ?? false}
              version={serverStatus?.hbbs_version}
              count={serverStatus?.hbbs_devices ?? (serverStatus?.hbbs_clients?.length ?? 0)}
              conns={serverStatus?.hbbs_conns ?? []}
              emptyLabel={t('dash.noConnections')}
            />
            <ServerConnRow
              label={t('dash.relay')}
              unit={t('dash.devicesUnit')}
              listening={serverStatus?.hbbr_listening ?? false}
              version={serverStatus?.hbbr_version}
              count={serverStatus?.hbbr_devices ?? (serverStatus?.relay_clients?.length ?? 0)}
              conns={serverStatus?.hbbr_conns ?? []}
              emptyLabel={t('dash.noConnections')}
            />
            <p className="text-xs text-muted-foreground pt-1">
              {serverStatus?.relay_active ? t('dash.relayActive') : t('dash.noRelay')}
            </p>
            <Button asChild variant="outline" size="sm" className="w-full mt-1">
              <Link to="/settings">{t('dash.connDetails')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <ClientSetupCodeCard />
    </div>
  )
}

function ClientSetupCodeCard() {
  const { t } = useTranslation()
  const { data, isLoading, isError, error } = useConnectCode()

  const meta = data?.api
    ? t('dash.setupCodeMetaApi', { host: data?.host ?? '—', relay: data?.relay ?? '—', api: data.api, key: data?.key ? `${data.key.slice(0, 12)}…` : '—' })
    : t('dash.setupCodeMeta', { host: data?.host ?? '—', relay: data?.relay ?? '—', key: data?.key ? `${data.key.slice(0, 12)}…` : '—' })

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-primary" />
          <CardTitle>{t('dash.setupCode')}</CardTitle>
        </div>
        <p className="text-muted-foreground">
          {t('dash.setupCodeDesc')} {meta}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-6">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            {axios.isAxiosError<{ error?: string }>(error)
              ? (error.response?.data?.error ?? t('dash.setupUnavailable'))
              : t('dash.setupUnavailable')}{' '}
            <Link to="/settings" className="underline">
              {t('dash.setupConfigure')}
            </Link>
            .
          </p>
        ) : (
          <>
            <CopyField label={t('dash.configCode')} value={data!.json} mono />
            <CopyField label={t('dash.rawJson')} value={data!.raw} mono />
            <CopyField label={t('dash.altFormat')} value={data!.comma} mono />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function CopyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({ title: t('common.copiedClipboard'), variant: 'success' })
    } catch {
      toast({ title: t('common.copyFailed'), description: t('common.copyFailedDesc'), variant: 'destructive' })
    }
  }

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
        <div className={`neu-field h-auto w-full justify-start rounded-lg p-3 text-xs overflow-x-auto ${mono ? 'font-mono break-all whitespace-pre-wrap' : ''}`}>
          {value}
        </div>
      </div>
      <Button variant="outline" size="sm" className="mt-4" onClick={copy}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
    </div>
  )
}

function ServerConnRow({
  label,
  unit,
  listening,
  version,
  count,
  conns,
  emptyLabel,
}: {
  label: string
  unit: string
  listening: boolean
  version?: string
  count: number
  conns: ServerStatusConn[]
  emptyLabel: string
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation()

  return (
    <div className="neu-panel overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="raw-focus flex w-full select-none items-center justify-between gap-2 px-3 py-2.5 transition-colors hover:bg-muted/40"
        aria-expanded={expanded}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-muted-foreground">{label}</span>
          {version ? (
            <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
              v{version}
            </Badge>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <OnlineBadge ok={listening} />
          <span className="flex items-baseline gap-1">
            <span className="neu-title text-lg font-bold leading-none">{count}</span>
            <span className="text-[11px] text-muted-foreground">{unit}</span>
          </span>
          <ChevronDown
            className={cn('h-4 w-4 text-muted-foreground transition-transform', expanded && 'rotate-180')}
          />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border bg-muted/20 px-3 py-2 space-y-1.5">
          {conns.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">{emptyLabel}</p>
          ) : (
            conns.map((conn, idx) => (
              <div
                key={`${conn.ip}-${conn.port ?? ''}-${idx}`}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/40',
                  conn.stale && 'opacity-60'
                )}
                title={conn.stale ? t('dash.connStaleHint') : undefined}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm">{conn.alias || conn.peer_id || conn.ip}</span>
                  {!conn.alias && conn.peer_id && (
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{conn.peer_id}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{conn.ip}</span>
                  {conn.port ? (
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      :{conn.port}
                    </Badge>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function OnlineBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge variant="success">Up</Badge>
  ) : (
    <Badge variant="secondary">Down</Badge>
  )
}