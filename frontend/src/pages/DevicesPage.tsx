
import { Fragment, useState } from 'react'
import { Search, Pin, Trash2, Edit, MoreHorizontal, RefreshCw, Monitor, Terminal, FolderOpen, Copy, Check, Globe, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableFooter } from '@/components/ui/table'
import { StatusDot } from '@/components/StatusDot'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useDevices, useUpdateDevice, useDeleteDevice, useDeviceOnlineStream, Device } from '@/api/devices'
import { apiErrorText } from '@/api/client'
import { formatRelativeTime, cn } from '@/lib/utils'
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
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [page, setPage] = useState(1)
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { toast } = useToast()

  const { data: serverInfo } = useServerInfo()
  const address = serverInfo?.address?.value ?? ''
  const key = serverInfo?.public_key?.value ?? ''

  const { data: settings } = useSettings()
  const refreshMs = (settings?.[STATUS_REFRESH_INTERVAL_KEY] ?? DEFAULT_STATUS_REFRESH_INTERVAL) * 1000
  const pushEnabled = (settings?.[STATUS_UPDATE_MODE_KEY] ?? STATUS_UPDATE_MODE_PUSH) === STATUS_UPDATE_MODE_PUSH
  const { online: onlineSet, streamActive } = useDeviceOnlineStream(pushEnabled)

  const onlineFilter = statusFilter === 'all' ? undefined : statusFilter === 'online'
  const { data, isLoading, refetch } = useDevices(
    { page, limit: 20, search, online: onlineFilter },
    { refetchInterval: refreshMs },
  )
  const updateDevice = useUpdateDevice()
  const deleteDevice = useDeleteDevice()

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
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
    if (!confirm(t('devices.confirmDelete', { name: device.alias || device.peer_id, peerId: device.peer_id }))) return
    try {
      await deleteDevice.mutateAsync(device.id)
      toast({ title: t('devices.deleted'), variant: 'success' })
      refetch()
    } catch (error) {
      toast({ title: t('devices.deleteFailed'), description: apiErrorText(error), variant: 'destructive' })
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
    window.open(url, '_blank')
  }

  const handleWebOpen = async (device: Device) => {
    openWebClientWith(device, toast, address, key, buildClipText(t), t('devices.webClientOpened'), t('devices.webClientOpenedErr'))
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
                <div className="relative w-full">
                  <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('devices.searchPlaceholder')}
                    value={search}
                    onChange={handleSearch}
                    className="ps-10 pe-3 w-full sm:w-64"
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
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">{t('common.status')}</TableHead>
                      <TableHead>{t('common.alias')}</TableHead>
                      <TableHead>{t('common.deviceId')}</TableHead>
                      <TableHead className="w-32">{t('common.lastSeen')}</TableHead>
                      <TableHead className="w-24">{t('devices.pinned')}</TableHead>
                      <TableHead className="w-28">{t('common.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.items ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                          {t('devices.none')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      (data?.items ?? []).map((device) => {
                        const expanded = expandedId === device.id
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
                                  >
                                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                  </Button>
                                  <StatusDot online={deviceOnline(device)} />
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
                                {device.last_seen ? formatRelativeTime(i18n.language, device.last_seen, t('devices.never')) : t('devices.never')}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={device.pinned ? t('devices.unpin') : t('devices.pin')}
                                  className={cn(
                                    'shrink-0',
                                    device.pinned && 'bg-amber-400 text-amber-950 hover:bg-amber-300'
                                  )}
                                  onClick={() => handlePin(device)}
                                >
                                  <Pin className={cn('h-4 w-4', device.pinned ? 'text-amber-950' : 'text-muted-foreground')} />
                                </Button>
                              </TableCell>
                              <TableCell>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon">
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
                                      onClick={() => handleDelete(device)}
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
                                <TableCell colSpan={6} className="bg-muted/30">
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
                      <TableCell colSpan={6} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
    </div>
  )
}

function webClientUrl(peerId: string): string {
  return `https://rustdesk.com/web/#/${peerId}`
}

function buildClipText(t: (key: string, opts?: Record<string, unknown>) => string) {
  return (peerId: string, address: string, key: string) =>
    [
      t('devices.webClientClipTitle'),
      t('devices.webClientClipIdServer', { address }),
      t('devices.webClientClipKey', { key }),
      t('devices.webClientClipId', { peerId }),
      '',
      t('devices.webClientClipHint'),
    ].join('\n')
}

function openWebClientWith(
  device: Device,
  toast: ReturnType<typeof useToast>['toast'],
  address: string,
  key: string,
  getClip: (peerId: string, address: string, key: string) => string,
  successTitle: string,
  errorTitle: string,
) {
  navigator.clipboard.writeText(getClip(device.peer_id, address, key)).then(
    () => toast({ title: successTitle, variant: 'success' }),
    () => toast({ title: errorTitle, variant: 'destructive' }),
  )
  window.open(webClientUrl(device.peer_id), '_blank')
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
    <Button variant="ghost" size="icon" onClick={handleCopyId} title={t('devices.copyId')} className="h-6 w-6 shrink-0">
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
    <Button variant="ghost" size="icon" onClick={handleCopy} title={t('common.copy')} className="h-6 w-6 shrink-0">
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
    window.open(url, '_blank')
  }

  const openWebClient = () =>
    openWebClientWith(device, toast, address, key, buildClipText(t), t('devices.webClientOpened'), t('devices.webClientOpenedErr'))

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
        <p className="font-medium text-foreground">{t('devices.webClientWarnTitle')}</p>
        <p>
          {t('devices.webClientWarnDesc', {
            id: address ? `${address}:${idPort}` : '—',
            relay: address ? `${address}:${relayPort}` : '—',
          })}
        </p>
        <p className="font-mono">
          {address
            ? t('devices.webClientWss', { address })
            : t('devices.webClientNoAddress')}
        </p>
      </div>
    </div>
  )
}

function EditAliasDialog({ device, onClose, onSave }: { device: Device; onClose: () => void; onSave: (alias: string) => void }) {
  const { t } = useTranslation()
  const [alias, setAlias] = useState(device.alias || '')

  return (
    <Dialog open={!!device} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => { onSave(alias); onClose() }} disabled={!alias.trim()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}