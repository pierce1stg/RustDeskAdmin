
import { Fragment, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Pin, Trash2, Edit, MoreHorizontal, RefreshCw, Monitor, Terminal, FolderOpen, Copy, Check, Globe, ChevronDown, ChevronUp, KeyRound, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableFooter } from '@/components/ui/table'
import { StatusDot } from '@/components/StatusDot'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useDevices, useUpdateDevice, useDeleteDevice, useDeviceOnlineStream, useSaveDevicePassword, useDeleteDevicePassword, Device, formatDisplays, describeDisplays } from '@/api/devices'
import { DeviceSearchFilter } from '@/components/DeviceSearchFilter'
import { loadSearchConfig, saveSearchConfig, searchConfigToParams, SearchConfig } from '@/lib/deviceSearch'
import { apiErrorText } from '@/api/client'
import { formatRelativeTime, cn } from '@/lib/utils'
import { parseOnlineSource, onlineDotState } from '@/lib/devicePresence'
import { useToast } from '@/hooks/use-toast'
import { useServerInfo } from '@/api/serverInfo'
import {
  useSettings,
  STATUS_REFRESH_INTERVAL_KEY,
  DEFAULT_STATUS_REFRESH_INTERVAL,
  STATUS_UPDATE_MODE_KEY,
  STATUS_UPDATE_MODE_PUSH,
} from '@/api/settings'

export function DevicesPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [searchCfg, setSearchCfg] = useState<SearchConfig>(loadSearchConfig)
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [page, setPage] = useState(1)
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [passwordDevice, setPasswordDevice] = useState<Device | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { toast } = useToast()

  const { data: settings } = useSettings()
  const refreshMs = (settings?.[STATUS_REFRESH_INTERVAL_KEY] ?? DEFAULT_STATUS_REFRESH_INTERVAL) * 1000
  const pushEnabled = (settings?.[STATUS_UPDATE_MODE_KEY] ?? STATUS_UPDATE_MODE_PUSH) === STATUS_UPDATE_MODE_PUSH
  const { online: onlineSet, streamActive } = useDeviceOnlineStream(pushEnabled)

  const onlineFilter = statusFilter === 'all' ? undefined : statusFilter === 'online'
  const searchParams = searchConfigToParams(searchCfg)
  const { data, isLoading, isError, error, refetch } = useDevices(
    { page, limit: 20, search, online: onlineFilter, ...searchParams },
    { refetchInterval: refreshMs },
  )
  const updateDevice = useUpdateDevice()
  const deleteDevice = useDeleteDevice()

  // Self-healing: TanStack Query pauses polling after repeated failures, which
  // could otherwise leave the page on a silent "no devices" state. While the
  // list query is errored, retry on a short timer until it succeeds.
  useEffect(() => {
    if (!isError) return
    console.error('[devices] list error', error)
    const timer = setTimeout(() => {
      void refetch()
    }, 5000)
    return () => clearTimeout(timer)
  }, [isError, error, refetch])

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
    setPage(1)
  }

  const handleSearchFilterChange = (cfg: typeof searchCfg) => {
    setSearchCfg(cfg)
    saveSearchConfig(cfg)
    setPage(1)
  }

  const handleStatusFilter = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value as 'all' | 'online' | 'offline')
    setPage(1)
  }

  const deviceOnline = (device: Device) => (streamActive ? onlineSet.has(device.peer_id) : device.online)

  const handlePageChange = (newPage: number) => {
    setPage(newPage)
  }

  const handleUpdate = async (device: Device, data: { alias?: string; pinned?: boolean }) => {
    try {
      await updateDevice.mutateAsync({ id: device.id, data })
      toast({ title: t('devices.updated'), variant: 'success' })
      refetch()
    } catch (error) {
      toast({ title: t('devices.updateFailed'), description: apiErrorText(error), variant: 'destructive' })
    }
  }

  const handleDelete = async (device: Device) => {
    try {
      await deleteDevice.mutateAsync(device.id)
      toast({ title: t('devices.deleted'), variant: 'success' })
      refetch()
    } catch (error) {
      toast({ title: t('devices.deleteFailed'), description: apiErrorText(error), variant: 'destructive' })
    } finally {
      setDeleteTarget(null)
    }
  }

  const handlePin = async (device: Device) => {
    await handleUpdate(device, { pinned: !device.pinned })
  }

  const handleAliasChange = async (device: Device, alias: string) => {
    await handleUpdate(device, { alias })
  }

  const copyAndOpen = async (label: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: t('devices.linkCopied', { label }), variant: 'success' })
    } catch {
      toast({ title: t('devices.copyLinkFailed'), variant: 'destructive' })
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleWebOpen = (device: Device) => {
    navigate(`/control/${device.peer_id}`)
  }

  return (
    <div className="w-full min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-muted-foreground">{t('devices.manage')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="me-2 h-4 w-4" /> {t('common.refresh')}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <CardTitle>{t('devices.title')}</CardTitle>
              <p className="text-muted-foreground">
                {t('devices.total', { count: data?.total ?? 0 })}
              </p>
            </div>
            <div className="w-full sm:w-auto">
              <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
                <DeviceSearchFilter value={searchCfg} onChange={handleSearchFilterChange} />
                <div className="relative w-full sm:w-64">
                  <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('devices.searchPlaceholder')}
                    aria-label={t('devices.searchPlaceholder')}
                    value={search}
                    onChange={handleSearch}
                    className="ps-10 pe-3 w-full"
                  />
                </div>
                <select
                  aria-label={t('devices.filter')}
                  className="neu-field h-10 w-full sm:w-40 px-3 py-2 text-sm"
                  value={statusFilter}
                  onChange={handleStatusFilter}
                >
                  <option value="all">{t('devices.filterAll')}</option>
                  <option value="online">{t('devices.filterOnline')}</option>
                  <option value="offline">{t('devices.filterOffline')}</option>
                </select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : isError && !data ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertTriangle className="h-10 w-10 text-destructive" />
              <p className="text-sm font-medium text-destructive dark:text-red-400">
                {apiErrorText(error) || t('devices.loadFailed')}
              </p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                <RefreshCw className="me-2 h-4 w-4" />
                {t('common.refresh')}
              </Button>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">{t('common.status')}</TableHead>
                      <TableHead>{t('common.alias')}</TableHead>
                      <TableHead>{t('common.deviceId')}</TableHead>
                      <TableHead>{t('devices.colHost')}</TableHead>
                      <TableHead>{t('devices.colUser')}</TableHead>
                      <TableHead>{t('devices.colOS')}</TableHead>
                      <TableHead>{t('devices.colVersion')}</TableHead>
                      <TableHead>{t('devices.colDisplays')}</TableHead>
                      <TableHead className="w-32">{t('common.lastSeen')}</TableHead>
                      <TableHead className="w-24">{t('devices.pinned')}</TableHead>
                      <TableHead className="w-24">{t('devices.password')}</TableHead>
                      <TableHead className="w-28">{t('common.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.items ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={12} className="text-center py-12 text-muted-foreground">
                          {t('devices.none')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      (data?.items ?? []).map((device) => {
                        const expanded = expandedId === device.id
                        const isOn = deviceOnline(device)
                        const src = parseOnlineSource(device.online_source)
                        const graceTime =
                          src.kind === 'grace' && src.until
                            ? new Date(src.until)
                            : null
                        const sourceText = !isOn
                          ? null
                          : src.kind === 'hbbs'
                            ? t('devices.hbbsSrc')
                            : src.kind === 'conn'
                              ? t('devices.liveConn', { ip: src.ip })
                              : src.kind === 'shared'
                                ? t('devices.sharedConn', { ip: src.ip })
                                : src.kind === 'grace' && graceTime && !Number.isNaN(graceTime.getTime())
                              ? t('devices.graceHold', {
                                  time: graceTime.toLocaleTimeString(i18n.language, {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  }),
                                })
                              : t('devices.sourceUnknown')
                        return (
                          <Fragment key={device.id}>
                            <TableRow>
                              <TableCell className="w-24">
                                <div className="flex items-center gap-3 whitespace-nowrap">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 shrink-0"
                                    onClick={() => setExpandedId(expanded ? null : device.id)}
                                    title={expanded ? t('devices.hideDetails') : t('devices.showDetails')}
                                    aria-label={expanded ? t('devices.hideDetails') : t('devices.showDetails')}
                                    aria-expanded={expanded}
                                  >
                                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                  </Button>
                                  <StatusDot online={onlineDotState(isOn, src, device.last_seen)} />
                                </div>
                              </TableCell>
                              <TableCell>
                                {device.alias ? (
                                  <span className="font-medium">{device.alias}</span>
                                ) : (
                                  <span className="text-muted-foreground">{t('devices.noAlias')}</span>
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-sm">
                                <div className="flex items-center gap-2">
                                  <span className="min-w-0 break-all">{device.peer_id}</span>
                                  <CopyIdButton id={device.peer_id} />
                                </div>
                              </TableCell>
                              <TableCell>
                                {device.hostname ? (
                                  <span className="font-mono text-sm">{device.hostname}</span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell>
                                {device.username ? (
                                  <span>{device.username}</span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell>
                                {device.platform ? (
                                  <span>{device.platform}</span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-sm">
                                {device.host_version ? (
                                  <span>{device.host_version}</span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell>
                                {formatDisplays(device.displays).length > 0 ? (
                                  <div className="flex flex-col gap-0.5" title={describeDisplays(device.displays)}>
                                    {formatDisplays(device.displays).map((line) => (
                                      <span key={line} className="whitespace-nowrap font-mono text-xs">
                                        {line}
                                      </span>
                                    ))}
                                    <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                                      {device.peerinfo_updated_at
                                        ? formatRelativeTime(i18n.language, device.peerinfo_updated_at, '')
                                        : '—'}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-0.5">
                                  <span className="whitespace-nowrap">
                                    {device.last_seen ? formatRelativeTime(i18n.language, device.last_seen, t('devices.never')) : t('devices.never')}
                                  </span>
                                  {isOn && sourceText && (
                                    <span
                                      className="whitespace-nowrap text-[11px] text-muted-foreground"
                                      title={device.online_source ?? undefined}
                                    >
                                      {sourceText}
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={device.pinned ? t('devices.unpin') : t('devices.pin')}
                                  aria-label={device.pinned ? t('devices.unpin') : t('devices.pin')}
                                  aria-pressed={device.pinned}
                                  className={cn(
                                    'shrink-0',
                                    // The ghost variant pulls in .neu-btn (own bg/border/shadow);
                                    // kill the neumorphic chrome so the flat amber reads clean.
                                    device.pinned && 'border-transparent bg-amber-500 text-white shadow-none hover:bg-amber-400 dark:bg-amber-500 dark:text-white dark:hover:bg-amber-400'
                                  )}
                                  onClick={() => handlePin(device)}
                                >
                                  <Pin className={cn('h-4 w-4', device.pinned ? 'text-white' : 'text-muted-foreground')} />
                                </Button>
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={device.password_saved ? t('devices.changePassword') : t('devices.savePassword')}
                                  aria-label={device.password_saved ? t('devices.changePassword') : t('devices.savePassword')}
                                  className="shrink-0"
                                  onClick={() => setPasswordDevice(device)}
                                >
                                  <span className="relative">
                                    <KeyRound className={cn('h-4 w-4', device.password_saved ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')} />
                                    {device.password_saved && (
                                      <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-green-500" />
                                    )}
                                  </span>
                                </Button>
                              </TableCell>
                              <TableCell>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" aria-label={t('common.actions')}>
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => copyAndOpen(t('devices.desktop'), `rustdesk://${device.peer_id}`)}>
                                      <Monitor className="me-2 h-4 w-4" /> {t('devices.desktop')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => copyAndOpen(t('devices.terminal'), `rustdesk://terminal/${device.peer_id}`)}>
                                      <Terminal className="me-2 h-4 w-4" /> {t('devices.terminal')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => copyAndOpen(t('devices.fileTransfer'), `rustdesk://file-transfer/${device.peer_id}`)}>
                                      <FolderOpen className="me-2 h-4 w-4" /> {t('devices.fileTransfer')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleWebOpen(device)}>
                                      <Globe className="me-2 h-4 w-4" /> {t('devices.webClient')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => setSelectedDevice(device)}>
                                      <Edit className="me-2 h-4 w-4" /> {t('devices.editAlias')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handlePin(device)}
                                      className={cn(device.pinned && 'text-primary')}
                                    >
                                      <Pin className="me-2 h-4 w-4" />
                                      {device.pinned ? t('devices.unpin') : t('devices.pin')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onClick={() => setDeleteTarget(device)}
                                      className="text-red-600 focus:text-red-600"
                                    >
                                      <Trash2 className="me-2 h-4 w-4" /> {t('devices.delete')}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </TableCell>
                            </TableRow>
                            {expanded && (
                              <TableRow>
                                <TableCell colSpan={12} className="bg-muted/30">
                                  <DeviceConnectionPanel device={device} />
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        )
                      })
                    )}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={12}>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <span className="text-sm text-muted-foreground">
                            {t('devices.showing', { from: ((page - 1) * 20) + 1, to: Math.min(page * 20, data?.total ?? 0), count: data?.total ?? 0 })}
                          </span>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={page === 1}
                              onClick={() => handlePageChange(page - 1)}
                            >
                              {t('common.previous')}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={page * 20 >= (data?.total ?? 0)}
                              onClick={() => handlePageChange(page + 1)}
                            >
                              {t('common.next')}
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selectedDevice && (
        <EditAliasDialog
          device={selectedDevice}
          onClose={() => setSelectedDevice(null)}
          onSave={(alias) => {
            handleAliasChange(selectedDevice, alias)
            setSelectedDevice(null)
          }}
        />
      )}

      {passwordDevice && (
        <PasswordDialog
          device={passwordDevice}
          onClose={() => setPasswordDevice(null)}
          onChanged={() => {
            refetch()
            setPasswordDevice(null)
          }}
        />
      )}

      {deleteTarget && (
        <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <DialogContent className="w-[calc(100vw-2rem)] sm:w-fit sm:max-w-[calc(100vw-2rem)]">
            <DialogHeader>
              <DialogTitle>{t('devices.delete')}</DialogTitle>
              <DialogDescription className="break-words">
                {t('devices.confirmDelete', { name: deleteTarget.alias || deleteTarget.peer_id, peerId: deleteTarget.peer_id })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col-reverse items-stretch gap-2 sm:space-x-0 sm:flex-row sm:justify-end">
              <Button variant="outline" className="w-full whitespace-normal sm:w-auto" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="destructive" className="w-full whitespace-normal sm:w-auto" onClick={() => handleDelete(deleteTarget)} disabled={deleteDevice.isPending}>
                {t('devices.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function CopyIdButton({ id }: { id: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const { toast } = useToast()

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({ title: t('devices.idCopied'), variant: 'success' })
    } catch {
      toast({ title: t('devices.copyFailed'), variant: 'destructive' })
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={handleCopyId} title={t('devices.copyId')} aria-label={t('devices.copyId')} className="h-6 w-6 shrink-0">
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const { toast } = useToast()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({ title: t('common.copied'), variant: 'success' })
    } catch {
      toast({ title: t('common.copyFailed'), variant: 'destructive' })
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={handleCopy} title={t('common.copy')} aria-label={t('common.copy')} className="h-6 w-6 shrink-0">
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

function InfoField({ label, value, monoSmall }: { label: string; value: string; monoSmall?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className={cn('font-mono text-sm break-all', monoSmall && 'text-xs')}>{value}</p>
      </div>
      <CopyButton text={value} />
    </div>
  )
}

function DeviceConnectionPanel({ device }: { device: Device }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { data: serverInfo } = useServerInfo()

  const address = serverInfo?.address?.value ?? ''
  const idPort = serverInfo?.id_port?.value ?? '21116'
  const relayPort = serverInfo?.relay_port?.value ?? '21117'
  const key = serverInfo?.public_key?.value ?? ''

  const copyAndOpen = async (label: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: t('devices.linkCopied', { label }), variant: 'success' })
    } catch {
      toast({ title: t('devices.copyLinkFailed'), variant: 'destructive' })
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const openWebClient = () => navigate(`/control/${device.peer_id}`)

  const nativeUrl = `rustdesk://${device.peer_id}`
  const fileTransferUrl = `rustdesk://file-transfer/${device.peer_id}`
  const terminalUrl = `rustdesk://terminal/${device.peer_id}`

  return (
    <div className="space-y-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <InfoField label={t('common.deviceId')} value={device.peer_id} />
        <InfoField label={t('devices.idServer')} value={address ? `${address}:${idPort}` : '—'} />
        <InfoField label={t('devices.relayServer')} value={address ? `${address}:${relayPort}` : '—'} />
        <InfoField label={t('devices.serverKey')} value={key || '—'} monoSmall />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={openWebClient}>
          <Globe className="me-2 h-4 w-4" />
          {t('devices.openBrowser')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyAndOpen(t('devices.openApp'), nativeUrl)}>
          <Monitor className="me-2 h-4 w-4" />
          {t('devices.openApp')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyAndOpen(t('devices.fileTransfer'), fileTransferUrl)}>
          <FolderOpen className="me-2 h-4 w-4" />
          {t('devices.filesInApp')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyAndOpen(t('devices.terminal'), terminalUrl)}>
          <Terminal className="me-2 h-4 w-4" />
          {t('devices.terminalInApp')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copyAndOpen(t('devices.copyConnLink'), nativeUrl)}>
          <Copy className="me-2 h-4 w-4" />
          {t('devices.copyConnLink')}
        </Button>
      </div>

      <div className="rounded-lg bg-muted/60 p-3 text-xs space-y-1.5 text-muted-foreground">
        <p className="font-medium text-foreground">{t('devices.connInfoTitle')}</p>
        <p>{t('devices.firstSeen', {
          date: device.created_at
            ? new Date(device.created_at).toLocaleDateString()
            : t('devices.unknownSeen'),
        })}</p>
        <p>{t('devices.lastSeen', {
          date: device.last_seen
            ? new Date(device.last_seen).toLocaleDateString()
            : t('devices.neverSeen'),
        })}</p>
        <p>{t('devices.daysInSystem', {
          days: device.created_at
            ? Math.max(0, Math.floor((Date.now() - new Date(device.created_at).getTime()) / 86400000))
            : 0,
        })}</p>
      </div>
    </div>
  )
}

function PasswordDialog({
  device,
  onClose,
  onChanged,
}: {
  device: Device
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [password, setPassword] = useState('')
  const savePassword = useSaveDevicePassword()
  const deletePassword = useDeleteDevicePassword()

  const handleSave = async () => {
    if (!password) return
    try {
      await savePassword.mutateAsync({ id: device.id, password })
      toast({ title: t('devices.passwordSaved', { name: device.alias || device.peer_id }), variant: 'success' })
      onChanged()
    } catch (error) {
      toast({ title: t('devices.passwordSaveFailed'), description: apiErrorText(error), variant: 'destructive' })
    }
  }

  const handleClear = async () => {
    try {
      await deletePassword.mutateAsync(device.id)
      toast({ title: t('devices.passwordCleared'), variant: 'success' })
      onChanged()
    } catch (error) {
      toast({ title: t('devices.passwordSaveFailed'), description: apiErrorText(error), variant: 'destructive' })
    }
  }

  return (
    <Dialog open={!!device} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:w-fit sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>
            {device.password_saved ? t('devices.changePassword') : t('devices.savePassword')}
          </DialogTitle>
          <DialogDescription>
            <span className="mt-1 block max-w-[70vw] break-all font-mono text-[11px] sm:max-w-xs">{device.peer_id}</span>
            {t('devices.passwordDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="password-save">{t('control.password')}</Label>
            <PasswordInput
              id="password-save"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
              }}
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:space-x-0 sm:justify-between">
          <div>
            {device.password_saved && (
              <Button variant="destructive" size="sm" className="w-full whitespace-normal sm:w-auto" onClick={handleClear}>
                {t('devices.clearPassword')}
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2 min-[420px]:flex-row">
            <Button variant="outline" className="w-full whitespace-normal min-[420px]:w-auto" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button className="w-full whitespace-normal min-[420px]:w-auto" onClick={handleSave} disabled={!password}>
              {t('devices.passwordSaveAction')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditAliasDialog({ device, onClose, onSave }: { device: Device; onClose: () => void; onSave: (alias: string) => void }) {
  const { t } = useTranslation()
  const [alias, setAlias] = useState(device.alias || '')

  return (
    <Dialog open={!!device} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:w-fit sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('devices.editAlias')}</DialogTitle>
          <DialogDescription>{t('devices.editAliasDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Label htmlFor="alias">{t('common.alias')}</Label>
          <Input
            id="alias"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={t('devices.aliasPlaceholder')}
          />
        </div>
        <DialogFooter className="flex-col-reverse items-stretch gap-2 sm:space-x-0 sm:flex-row sm:justify-end">
          <Button variant="outline" className="w-full whitespace-normal sm:w-auto" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button className="w-full whitespace-normal sm:w-auto" onClick={() => { onSave(alias); onClose() }} disabled={!alias.trim()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}