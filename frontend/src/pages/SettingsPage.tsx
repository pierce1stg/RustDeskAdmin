
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { Server, RefreshCw, ShieldCheck, Languages, Download, Check, Clock, Rocket, MonitorSmartphone, MessageCircle, ChevronDown, ChevronUp } from 'lucide-react'
import {
  useSettings,
  useUpdateSetting,
  STATUS_REFRESH_INTERVAL_KEY,
  DEFAULT_STATUS_REFRESH_INTERVAL,
  MIN_STATUS_REFRESH_INTERVAL,
  MAX_STATUS_REFRESH_INTERVAL,
  STATUS_UPDATE_MODE_KEY,
  STATUS_UPDATE_MODE_PUSH,
  STATUS_UPDATE_MODE_POLL,
  DEFAULT_STATUS_UPDATE_MODE,
  ACCESS_TOKEN_TTL_KEY,
  DEFAULT_ACCESS_TOKEN_TTL,
  MIN_ACCESS_TOKEN_TTL,
  MAX_ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_KEY,
  DEFAULT_REFRESH_TOKEN_TTL,
  MIN_REFRESH_TOKEN_TTL,
  MAX_REFRESH_TOKEN_TTL,
  WEB_CLIENT_QUALITY_KEY,
  DEFAULT_WEB_CLIENT_QUALITY,
  WEB_CLIENT_FPS_KEY,
  DEFAULT_WEB_CLIENT_FPS,
  MIN_WEB_CLIENT_FPS,
  MAX_WEB_CLIENT_FPS,
  WEB_CLIENT_CODEC_KEY,
  DEFAULT_WEB_CLIENT_CODEC,
  WEB_CLIENT_CODECS,
  WEB_CLIENT_RENDER_SCALE_KEY,
  DEFAULT_WEB_CLIENT_RENDER_SCALE,
  WEB_CLIENT_RENDER_SCALES,
  WEB_CLIENT_CURSOR_KEY,
  DEFAULT_WEB_CLIENT_CURSOR,
  WEB_CLIENT_INPUT_MODE_KEY,
  DEFAULT_WEB_CLIENT_INPUT_MODE,
  WEB_CLIENT_INPUT_MODES,
  WEB_CLIENT_NAME_KEY,
  DEFAULT_WEB_CLIENT_NAME,
  MAX_WEB_CLIENT_NAME,
  WEB_CLIENT_CHAT_GREETING_KEY,
  DEFAULT_WEB_CLIENT_CHAT_GREETING,
  WEB_CLIENT_CHAT_GREETING_ENABLED_KEY,
  WEB_CLIENT_CHAT_CLOSE_KEY,
  DEFAULT_WEB_CLIENT_CHAT_CLOSE,
  WEB_CLIENT_CHAT_CLOSE_ENABLED_KEY,
  MAX_WEB_CLIENT_CHAT_TEXT,
} from '@/api/settings'
import { useChangeCredentials } from '@/api/auth'
import { apiErrorText } from '@/api/client'
import { useServerInfo, useUpdateServerInfo, ServerField } from '@/api/serverInfo'
import { useServerStatus } from '@/api/status'
import { useServerUpdates, useApplyUpdate, UpdateComponent } from '@/api/updates'
import {
  usePanelUpdateCheck,
  usePanelUpdateStatus,
  useApplyPanelUpdate,
  PANEL_ACTIVE_PHASES,
} from '@/api/panel'
import { SUPPORTED_LANGS, LANGUAGE_LABELS, changeAppLanguage } from '@/i18n'
import i18n from '@/i18n'
import { loadOpenIds, saveOpenIds, toggleOpenId } from '@/lib/settingsCollapse'

// Settings section card with a clickable header: collapsed shows only the
// title + description. State persists per browser (expanded by default).
function CollapsibleCard({
  id,
  icon,
  title,
  desc,
  children,
}: {
  id: string
  icon: React.ReactNode
  title: string
  desc: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(() => loadOpenIds().includes(id))
  const toggle = () => {
    setOpen((v) => {
      const next = !v
      saveOpenIds(toggleOpenId(loadOpenIds(), id, next))
      return next
    })
  }
  return (
    <Card>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
        className="raw-focus cursor-pointer select-none"
      >
        <CardHeader>
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle>{title}</CardTitle>
            <span className="ms-auto text-muted-foreground">
              {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>
          </div>
          <p className="text-muted-foreground">{desc}</p>
        </CardHeader>
      </div>
      {open && children}
    </Card>
  )
}

function SourceBadge({ source }: { source: string }) {
  const { t } = useTranslation()
  if (!source) return <Badge variant="secondary">{t('settings.sourceNotConfigured')}</Badge>
  const label =
    source === 'rustdesk-server'
      ? t('settings.sourceRustdeskServer')
      : source === 'env:DOMAIN'
        ? t('settings.sourceEnvDomain')
        : source === 'env:RELAY_ADDRESS'
          ? t('settings.sourceEnvRelay')
          : source === 'env:RUSTDESK_API_SERVER'
            ? t('settings.sourceEnvApi')
            : source === 'default (same as id server)'
              ? t('settings.sourceDefault')
              : source === 'stack default'
                ? t('settings.sourceStackDefault')
                : source === 'manual'
                  ? t('settings.sourceManual')
                  : t('settings.sourceAuto')
  return <Badge variant={source === 'manual' ? 'outline' : 'secondary'}>{label}</Badge>
}

function ServerInfoRow({
  label,
  fieldKey,
  field,
  hint,
}: {
  label: string
  fieldKey: string
  field?: ServerField
  hint?: string
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const update = useUpdateServerInfo()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const value = field?.value ?? ''
  const source = field?.source ?? ''

  const startEdit = () => {
    setDraft(value)
    setEditing(true)
  }

  const save = async () => {
    try {
      await update.mutateAsync({ key: fieldKey, value: draft.trim() })
      toast({ title: t('settings.fieldSaved', { label }), variant: 'success' })
      setEditing(false)
    } catch (error) {
      toast({
        title: t('settings.saveFailed'),
        description: apiErrorText(error, t('settings.checkValue')),
        variant: 'destructive',
      })
    }
  }

  const reset = async () => {
    try {
      await update.mutateAsync({ key: fieldKey, value: '' })
      toast({ title: t('settings.fieldReset', { label }), variant: 'success' })
      setEditing(false)
    } catch (error) {
      toast({ title: t('settings.resetFailed'), description: apiErrorText(error), variant: 'destructive' })
    }
  }

  const auto =
    source === 'rustdesk-server' ||
    source === 'env:DOMAIN' ||
    source === 'env:RELAY_ADDRESS' ||
    source === 'env:RUSTDESK_API_SERVER' ||
    source === 'default (same as id server)' ||
    source === 'stack default' ||
    source === 'request host'

  return (
    <div className="rounded-lg border px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm font-medium">{label}</Label>
        <SourceBadge source={source} />
      </div>
      <Input
        value={editing ? draft : value}
        onChange={(e) => setDraft(e.target.value)}
        disabled={!editing}
        placeholder={auto ? t('settings.autoPlaceholder') : t('settings.enterValue')}
        className="font-mono text-sm"
      />
      <div className="flex gap-2">
        {editing ? (
          <Button size="sm" onClick={save} disabled={update.isPending}>
            {update.isPending ? t('settings.saving') : t('common.save')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={startEdit}>
            {t('common.edit')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={reset} disabled={update.isPending}>
          {t('settings.resetToAuto')}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ServerUpdatesCard() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { data: serverStatus } = useServerStatus()
  const { data: check, refetch, isFetching, isError } = useServerUpdates(false)
  const apply = useApplyUpdate()
  const [confirmComp, setConfirmComp] = useState<UpdateComponent | null>(null)

  const componentLabel = (comp: UpdateComponent) => (comp === 'hbbs' ? t('dash.idServer') : t('dash.relay'))

  const compInfo = (comp: UpdateComponent) => check?.components.find((c) => c.component === comp)

  const handleCheck = async () => {
    try {
      await refetch()
    } catch {
      /* surfaced by isError below */
    }
  }

  const confirm = (comp: UpdateComponent) => {
    const info = compInfo(comp)
    return (
      <Dialog open={confirmComp === comp} onOpenChange={(open) => !open && setConfirmComp(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:w-fit sm:max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{t('settings.updateConfirmTitle', { component: componentLabel(comp) })}</DialogTitle>
            <DialogDescription>
              {t('settings.updateConfirmDesc', {
                current: info?.current || '—',
                latest: info?.latest || '—',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse items-stretch gap-2 sm:space-x-0 sm:flex-row sm:justify-end">
            <Button variant="outline" className="w-full whitespace-normal sm:w-auto" onClick={() => setConfirmComp(null)} disabled={apply.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="w-full whitespace-normal sm:w-auto"
              disabled={apply.isPending}
              onClick={async () => {
                try {
                  await apply.mutateAsync(comp)
                  toast({ title: t('settings.updateApplied', { component: componentLabel(comp) }), variant: 'success' })
                  await refetch()
                } catch (error) {
                  toast({
                    title: t('settings.updateFailed'),
                    description: apiErrorText(error),
                    variant: 'destructive',
                  })
                } finally {
                  setConfirmComp(null)
                }
              }}
            >
              {apply.isPending ? t('settings.updating') : t('settings.updateConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <CollapsibleCard
      id="updates"
      icon={<Download className="h-5 w-5 text-primary" />}
      title={t('settings.updatesTitle')}
      desc={t('settings.updatesDesc')}
    >
      <CardContent className="space-y-5">
        {(['hbbs', 'hbbr'] as UpdateComponent[]).map((comp) => {
          const info = compInfo(comp)
          const current =
            (comp === 'hbbs' ? serverStatus?.hbbs_version : serverStatus?.hbbr_version) ||
            info?.current
          const hasUpdate = info?.update_available
          const applying = apply.isPending && apply.variables === comp
          return (
            <div key={comp} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{componentLabel(comp)}</span>
                <Badge variant="outline" className="font-mono text-[11px]">
                  v{current || '—'}
                </Badge>
                {hasUpdate ? (
                  <Badge variant="destructive" className="font-mono text-[11px]">
                    → v{info?.latest}
                  </Badge>
                ) : info && !info.unknown ? (
                  <Badge variant="success" className="text-[11px]">
                    <Check className="me-1 h-3 w-3" />
                    {t('settings.upToDate')}
                  </Badge>
                ) : null}
              </div>
              <Button
                size="sm"
                variant={hasUpdate ? 'destructive' : 'outline'}
                disabled={!hasUpdate}
                title={hasUpdate ? undefined : t('settings.noUpdateHint')}
                onClick={() => setConfirmComp(comp)}
              >
                {applying ? t('settings.updating') : t('settings.updateNow')}
              </Button>
            </div>
          )
        })}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={handleCheck} disabled={isFetching}>
            {isFetching ? (
              <>
                <span className="me-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t('settings.checkingUpdates')}
              </>
            ) : (
              <>
                <RefreshCw className="me-2 h-4 w-4" />
                {t('settings.checkUpdates')}
              </>
            )}
          </Button>
          {isError && <span className="text-xs text-red-600 dark:text-red-400">{t('settings.checkFailed')}</span>}
          {check && !isError && (
            <span className="text-xs text-muted-foreground">
              {t('settings.checkResults', {
                source: check.source,
                time: new Date(check.checked_at).toLocaleTimeString(),
              })}
            </span>
          )}
        </div>
      </CardContent>
      {confirmComp && confirm(confirmComp)}
    </CollapsibleCard>
  )
}

function PanelUpdatesCard() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { data: check, refetch, isFetching, isError } = usePanelUpdateCheck(true)
  const apply = useApplyPanelUpdate()
  const { data: status } = usePanelUpdateStatus(apply.isPending)
  const [confirm, setConfirm] = useState(false)

  const phase = status?.phase ?? 'idle'
  const active = PANEL_ACTIVE_PHASES.includes(phase)
  const hasUpdate = check?.update_available
  const enabled = check?.enabled !== false

  const phaseLabel = (p: string) => {
    switch (p) {
      case 'verifying':
        return t('settings.panelPhaseVerifying')
      case 'backup':
        return t('settings.panelPhaseBackup')
      case 'extracting':
        return t('settings.panelPhaseExtracting')
      case 'building':
        return t('settings.panelPhaseBuilding')
      case 'health':
        return t('settings.panelPhaseHealth')
      case 'rollback':
        return t('settings.panelPhaseRollback')
      case 'rolled_back':
        return t('settings.panelPhaseRolledBack')
      case 'error':
        return t('settings.panelPhaseError')
      case 'ok':
        return t('settings.panelPhaseOk')
      default:
        return t('settings.panelPhaseIdle')
    }
  }

  const handleCheck = async () => {
    try {
      await refetch()
    } catch {
      /* surfaced by isError below */
    }
  }

  return (
    <CollapsibleCard
      id="panel-updates"
      icon={<Rocket className="h-5 w-5 text-primary" />}
      title={t('settings.panelUpdatesTitle')}
      desc={t('settings.panelUpdatesDesc')}
    >
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('settings.panelVersion')}</span>
            <Badge variant="outline" className="font-mono text-[11px]">
              v{check?.current || '—'}
            </Badge>
            {hasUpdate ? (
              <Badge variant="destructive" className="font-mono text-[11px]">
                → v{check?.latest}
              </Badge>
            ) : check ? (
              <Badge variant="success" className="text-[11px]">
                <Check className="me-1 h-3 w-3" />
                {t('settings.panelUpToDate')}
              </Badge>
            ) : null}
          </div>
          <Button
            size="sm"
            variant={hasUpdate ? 'destructive' : 'outline'}
            disabled={!hasUpdate || !enabled || active || apply.isPending}
            title={!enabled ? t('settings.panelUpdateDisabled') : !hasUpdate ? t('settings.noUpdateHint') : undefined}
            onClick={() => setConfirm(true)}
          >
            {apply.isPending || active ? t('settings.panelPhaseWorking') : t('settings.panelUpdateNow')}
          </Button>
        </div>

        {active && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            <span className="me-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            {t('settings.panelPhaseWorking')} — {phaseLabel(phase)}
          </div>
        )}

        {(phase === 'rolled_back' || phase === 'error') && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 px-4 py-3 text-sm text-red-600 dark:border-red-900 dark:text-red-400">
            {phaseLabel(phase)}
            {status?.error && <span className="font-mono text-xs">{status.error}</span>}
          </div>
        )}

        {!enabled && <p className="text-xs text-muted-foreground">{t('settings.panelUpdateDisabled')}</p>}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={handleCheck} disabled={isFetching || active}>
            {isFetching ? (
              <>
                <span className="me-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t('settings.checkingUpdates')}
              </>
            ) : (
              <>
                <RefreshCw className="me-2 h-4 w-4" />
                {t('settings.checkUpdates')}
              </>
            )}
          </Button>
          {isError && <span className="text-xs text-red-600 dark:text-red-400">{t('settings.panelCheckFailed')}</span>}
          {check && !isError && (
            <span className="text-xs text-muted-foreground">
              {t('settings.checkResults', {
                source: check.source,
                time: new Date(check.checked_at).toLocaleTimeString(),
              })}
            </span>
          )}
        </div>
      </CardContent>

      <Dialog open={confirm} onOpenChange={(open) => !open && setConfirm(false)}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:w-fit sm:max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{t('settings.panelUpdateConfirmTitle', { latest: check?.latest })}</DialogTitle>
            <DialogDescription>
              {t('settings.panelUpdateConfirmDesc', {
                current: check?.current || '—',
                latest: check?.latest || '—',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse items-stretch gap-2 sm:space-x-0 sm:flex-row sm:justify-end">
            <Button variant="outline" className="w-full whitespace-normal sm:w-auto" onClick={() => setConfirm(false)} disabled={apply.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="w-full whitespace-normal sm:w-auto"
              disabled={apply.isPending}
              onClick={async () => {
                try {
                  await apply.mutateAsync()
                  toast({ title: t('settings.panelUpdateAccepted'), variant: 'success' })
                } catch (error) {
                  toast({
                    title: t('settings.panelUpdateFailed'),
                    description: apiErrorText(error),
                    variant: 'destructive',
                  })
                } finally {
                  setConfirm(false)
                }
              }}
            >
              {apply.isPending ? t('settings.panelPhaseWorking') : t('settings.panelUpdateConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CollapsibleCard>
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const changeCredentials = useChangeCredentials()

  const { data: serverInfo } = useServerInfo()

  const { data: settings } = useSettings()
  const updateSetting = useUpdateSetting()
  const [refreshInterval, setRefreshInterval] = useState<string>('')
  const [updateMode, setUpdateMode] = useState<string>(DEFAULT_STATUS_UPDATE_MODE)
  const [accessTtl, setAccessTtl] = useState<string>('')
  const [refreshTtl, setRefreshTtl] = useState<string>('')
  const [webQuality, setWebQuality] = useState<string>(String(DEFAULT_WEB_CLIENT_QUALITY))
  const [webFps, setWebFps] = useState<string>(String(DEFAULT_WEB_CLIENT_FPS))
  const [webCodec, setWebCodec] = useState<string>(DEFAULT_WEB_CLIENT_CODEC)
  const [webRenderScale, setWebRenderScale] = useState<string>(DEFAULT_WEB_CLIENT_RENDER_SCALE)
  const [webCursor, setWebCursor] = useState<boolean>(DEFAULT_WEB_CLIENT_CURSOR)
  const [webInputMode, setWebInputMode] = useState<string>(DEFAULT_WEB_CLIENT_INPUT_MODE)
  const [clientName, setClientName] = useState<string>('')
  const clientNameHydratedRef = useRef(false)
  const [chatGreeting, setChatGreeting] = useState<string>('')
  const [chatGreetingEnabled, setChatGreetingEnabled] = useState<boolean>(true)
  const [chatClose, setChatClose] = useState<string>('')
  const [chatCloseEnabled, setChatCloseEnabled] = useState<boolean>(true)
  // Hydrate once: later refetches (e.g. after unrelated saves) must not wipe
  // long texts mid-typing.
  const chatHydratedRef = useRef(false)
  useEffect(() => {
    if (settings && refreshInterval === '') {
      setRefreshInterval(String(settings[STATUS_REFRESH_INTERVAL_KEY] ?? DEFAULT_STATUS_REFRESH_INTERVAL))
    }
    if (settings) {
      setUpdateMode(settings[STATUS_UPDATE_MODE_KEY] ?? DEFAULT_STATUS_UPDATE_MODE)
    }
    if (settings && accessTtl === '') {
      setAccessTtl(String(settings[ACCESS_TOKEN_TTL_KEY] ?? DEFAULT_ACCESS_TOKEN_TTL))
    }
    if (settings && refreshTtl === '') {
      setRefreshTtl(String(settings[REFRESH_TOKEN_TTL_KEY] ?? DEFAULT_REFRESH_TOKEN_TTL))
    }
    if (settings) {
      setWebQuality(String(settings[WEB_CLIENT_QUALITY_KEY] ?? DEFAULT_WEB_CLIENT_QUALITY))
      setWebFps(String(settings[WEB_CLIENT_FPS_KEY] ?? DEFAULT_WEB_CLIENT_FPS))
      // Stale hardware defaults (h264/h265, removed from the product) fall
      // back to auto instead of rendering an unselectable value.
      setWebCodec(
        WEB_CLIENT_CODECS.includes(settings[WEB_CLIENT_CODEC_KEY] as (typeof WEB_CLIENT_CODECS)[number])
          ? String(settings[WEB_CLIENT_CODEC_KEY])
          : DEFAULT_WEB_CLIENT_CODEC,
      )
      const rs = settings[WEB_CLIENT_RENDER_SCALE_KEY]
      if (typeof rs === 'string' && (WEB_CLIENT_RENDER_SCALES as readonly string[]).includes(rs)) {
        setWebRenderScale(rs)
      }
      if (typeof settings[WEB_CLIENT_CURSOR_KEY] === 'boolean') {
        setWebCursor(settings[WEB_CLIENT_CURSOR_KEY] as boolean)
      }
      const im = settings[WEB_CLIENT_INPUT_MODE_KEY]
      if (typeof im === 'string' && (WEB_CLIENT_INPUT_MODES as readonly string[]).includes(im)) {
        setWebInputMode(im)
      }
    }
    if (settings && !chatHydratedRef.current) {
      chatHydratedRef.current = true
      setChatGreeting(String(settings[WEB_CLIENT_CHAT_GREETING_KEY] ?? DEFAULT_WEB_CLIENT_CHAT_GREETING))
      setChatGreetingEnabled(settings[WEB_CLIENT_CHAT_GREETING_ENABLED_KEY] ?? true)
      setChatClose(String(settings[WEB_CLIENT_CHAT_CLOSE_KEY] ?? DEFAULT_WEB_CLIENT_CHAT_CLOSE))
      setChatCloseEnabled(settings[WEB_CLIENT_CHAT_CLOSE_ENABLED_KEY] ?? true)
    }
    if (settings && !clientNameHydratedRef.current) {
      clientNameHydratedRef.current = true
      setClientName(String(settings[WEB_CLIENT_NAME_KEY] ?? DEFAULT_WEB_CLIENT_NAME))
    }
  }, [settings, refreshInterval, accessTtl, refreshTtl])

  const handleIntervalSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = Number(refreshInterval)
    if (!Number.isInteger(value) || value < MIN_STATUS_REFRESH_INTERVAL || value > MAX_STATUS_REFRESH_INTERVAL) {
      toast({
        title: t('settings.invalidInterval'),
        description: t('settings.invalidIntervalDesc', { min: MIN_STATUS_REFRESH_INTERVAL, max: MAX_STATUS_REFRESH_INTERVAL }),
        variant: 'destructive',
      })
      return
    }
    try {
      await updateSetting.mutateAsync({ key: STATUS_REFRESH_INTERVAL_KEY, value: String(value) })
      toast({ title: t('settings.intervalSaved'), description: t('settings.intervalSavedDesc', { value }), variant: 'success' })
    } catch {
      toast({ title: t('settings.intervalSaveFailed'), variant: 'destructive' })
    }
  }

  const handleUpdateModeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    setUpdateMode(value)
    try {
      await updateSetting.mutateAsync({ key: STATUS_UPDATE_MODE_KEY, value })
      toast({ title: t('settings.refreshModeSaved'), description: t('settings.refreshModeSavedDesc'), variant: 'success' })
    } catch {
      toast({ title: t('settings.refreshModeSaveFailed'), variant: 'destructive' })
    }
  }

  const handleSessionTtlSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const access = Number(accessTtl)
    const refresh = Number(refreshTtl)
    if (
      !Number.isInteger(access) ||
      access < MIN_ACCESS_TOKEN_TTL ||
      access > MAX_ACCESS_TOKEN_TTL ||
      !Number.isInteger(refresh) ||
      refresh < MIN_REFRESH_TOKEN_TTL ||
      refresh > MAX_REFRESH_TOKEN_TTL
    ) {
      toast({
        title: t('settings.invalidSessionTtl'),
        description: t('settings.invalidSessionTtlDesc', { min: MIN_ACCESS_TOKEN_TTL, max: MAX_ACCESS_TOKEN_TTL }),
        variant: 'destructive',
      })
      return
    }
    try {
      await updateSetting.mutateAsync({ key: ACCESS_TOKEN_TTL_KEY, value: String(access) })
      await updateSetting.mutateAsync({ key: REFRESH_TOKEN_TTL_KEY, value: String(refresh) })
      toast({
        title: t('settings.sessionAllTtlSaved'),
        description: t('settings.sessionAllTtlSavedDesc', { access, refresh }),
        variant: 'success',
      })
    } catch {
      toast({ title: t('settings.sessionSaveFailed'), variant: 'destructive' })
    }
  }

  const handleWebDefaultsSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const quality = Number(webQuality)
    if (quality !== 0 && quality !== 2 && quality !== 3 && quality !== 4) {
      toast({ title: t('settings.invalidWebQuality'), variant: 'destructive' })
      return
    }
    const fps = Number(webFps)
    if (!Number.isInteger(fps) || fps < MIN_WEB_CLIENT_FPS || fps > MAX_WEB_CLIENT_FPS) {
      toast({
        title: t('settings.invalidWebFps'),
        description: t('settings.invalidWebFpsDesc', { min: MIN_WEB_CLIENT_FPS, max: MAX_WEB_CLIENT_FPS }),
        variant: 'destructive',
      })
      return
    }
    if (!WEB_CLIENT_CODECS.includes(webCodec as typeof WEB_CLIENT_CODECS[number])) {
      toast({ title: t('settings.invalidWebCodec'), variant: 'destructive' })
      return
    }
    if (!(WEB_CLIENT_RENDER_SCALES as readonly string[]).includes(webRenderScale)) {
      toast({ title: t('settings.invalidWebRenderScale'), variant: 'destructive' })
      return
    }
    if (!(WEB_CLIENT_INPUT_MODES as readonly string[]).includes(webInputMode)) {
      toast({ title: t('settings.invalidWebInputMode'), variant: 'destructive' })
      return
    }
    try {
      await updateSetting.mutateAsync({ key: WEB_CLIENT_QUALITY_KEY, value: String(quality) })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_FPS_KEY, value: String(fps) })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_CODEC_KEY, value: webCodec })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_RENDER_SCALE_KEY, value: webRenderScale })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_CURSOR_KEY, value: String(webCursor) })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_INPUT_MODE_KEY, value: webInputMode })
      toast({ title: t('settings.webDefaultsSaved'), variant: 'success' })
    } catch {
      toast({ title: t('settings.webDefaultsSaveFailed'), variant: 'destructive' })
    }
  }

  // The codec select only updates local state; it is saved together with
  // quality and FPS by the Save button below.
  const handleWebCodecChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setWebCodec(e.target.value)
  }

  // Client display name (LoginRequest.my_name shown on hosts). Hydrated once
  // so refetches never wipe typing; validated 1-64 chars like the backend.
  const handleClientNameSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const v = clientName.trim()
    if ([...v].length < 1 || [...v].length > MAX_WEB_CLIENT_NAME) {
      toast({ title: t('settings.invalidClientName'), description: t('settings.invalidClientNameDesc', { max: MAX_WEB_CLIENT_NAME }), variant: 'destructive' })
      return
    }
    try {
      await updateSetting.mutateAsync({ key: WEB_CLIENT_NAME_KEY, value: v })
      setClientName(v)
      toast({ title: t('settings.clientNameSaved'), variant: 'success' })
    } catch {
      toast({ title: t('settings.clientNameSaveFailed'), variant: 'destructive' })
    }
  }

  // Session-chat system messages: greeting (first user-initiated open) and
  // close notice (X button on a non-empty chat). Each toggles independently;
  // empty text sends nothing.
  const handleChatSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (
      [...chatGreeting].length > MAX_WEB_CLIENT_CHAT_TEXT ||
      [...chatClose].length > MAX_WEB_CLIENT_CHAT_TEXT
    ) {
      toast({ title: t('settings.invalidChatText'), description: t('settings.invalidChatTextDesc', { max: MAX_WEB_CLIENT_CHAT_TEXT }), variant: 'destructive' })
      return
    }
    try {
      await updateSetting.mutateAsync({ key: WEB_CLIENT_CHAT_GREETING_ENABLED_KEY, value: String(chatGreetingEnabled) })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_CHAT_GREETING_KEY, value: chatGreeting })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_CHAT_CLOSE_ENABLED_KEY, value: String(chatCloseEnabled) })
      await updateSetting.mutateAsync({ key: WEB_CLIENT_CHAT_CLOSE_KEY, value: chatClose })
      toast({ title: t('settings.chatSaved'), variant: 'success' })
    } catch {
      toast({ title: t('settings.chatSaveFailed'), variant: 'destructive' })
    }
  }

  const handleCredentialsSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const hasNewUsername = newUsername.trim().length > 0
    const hasNewPassword = newPassword.length > 0

    if (!hasNewUsername && !hasNewPassword) {
      toast({ title: t('settings.nothingToChange'), description: t('settings.nothingToChangeDesc'), variant: 'destructive' })
      return
    }
    if (!currentPassword) {
      toast({ title: t('settings.passwordRequired'), variant: 'destructive' })
      return
    }
    if (hasNewPassword && newPassword !== confirmPassword) {
      toast({ title: t('settings.passwordMismatch'), variant: 'destructive' })
      return
    }
    if (hasNewPassword && newPassword.length < 8) {
      toast({ title: t('settings.passwordShort'), description: t('settings.passwordShortDesc'), variant: 'destructive' })
      return
    }

    try {
      await changeCredentials.mutateAsync({
        current_password: currentPassword,
        new_username: hasNewUsername ? newUsername.trim() : undefined,
        new_password: hasNewPassword ? newPassword : undefined,
      })
      toast({ title: t('settings.credentialsUpdated'), description: t('settings.credentialsUpdatedDesc'), variant: 'success' })
      setCurrentPassword('')
      setNewUsername('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      toast({
        title: t('settings.credentialsFailed'),
        description: apiErrorText(error, t('settings.credentialsFailedDesc')),
        variant: 'destructive',
      })
    }
  }

  const currentLang = i18n.resolvedLanguage || 'en'
  const intervalSec = Number(refreshInterval) || DEFAULT_STATUS_REFRESH_INTERVAL

  return (
    <div className="w-full min-w-0 max-w-6xl space-y-6">
      <div>
        <p className="text-muted-foreground">{t('settings.desc')}</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Languages className="h-5 w-5 text-primary" />
            <CardTitle>{t('settings.language')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('settings.languageDesc')}</p>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border space-y-2 px-4 py-3">
            <select
              id="languageSelect"
              aria-label={t('settings.language')}
              className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
              value={currentLang}
              onChange={(e) => changeAppLanguage(e.target.value)}
            >
              {(SUPPORTED_LANGS as readonly string[]).map((code) => (
                <option key={code} value={code} dir={code === 'ar' ? 'rtl' : 'ltr'}>
                  {LANGUAGE_LABELS[code as keyof typeof LANGUAGE_LABELS]}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Client display name: deliberately NOT collapsible (explicit spec) —
          it sits right after language so a fresh panel shows it immediately. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <MonitorSmartphone className="h-5 w-5 text-primary" />
            <CardTitle>{t('settings.clientNameTitle')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('settings.clientNameDesc')}</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleClientNameSave} className="space-y-4">
            <Label htmlFor="clientName">{t('settings.clientName')}</Label>
            <Input
              id="clientName"
              type="text"
              maxLength={MAX_WEB_CLIENT_NAME}
              className="max-w-2xl"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.clientNameHint', { max: MAX_WEB_CLIENT_NAME })}
            </p>
            <div>
              <Button type="submit" disabled={updateSetting.isPending}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <CollapsibleCard
        id="server-info"
        icon={<Server className="h-5 w-5 text-primary" />}
        title={t('settings.serverInfo')}
        desc={t('settings.serverInfoDesc')}
      >
        <CardContent className="space-y-5">
          <ServerInfoRow
            label={t('settings.address')}
            fieldKey="address"
            field={serverInfo?.address}
            hint={t('settings.addressHint')}
          />
          <ServerInfoRow
            label={t('settings.relayHost')}
            fieldKey="relay_address"
            field={serverInfo?.relay_address}
            hint={t('settings.relayHostHint')}
          />
          <ServerInfoRow
            label={t('settings.apiServer')}
            fieldKey="api_server"
            field={serverInfo?.api_server}
            hint={t('settings.apiServerHint')}
          />
          <ServerInfoRow
            label={t('settings.idPort')}
            fieldKey="id_port"
            field={serverInfo?.id_port}
            hint={t('settings.idPortHint')}
          />
          <ServerInfoRow
            label={t('settings.relayPort')}
            fieldKey="relay_port"
            field={serverInfo?.relay_port}
            hint={t('settings.relayPortHint')}
          />
          <ServerInfoRow
            label={t('settings.wsPort')}
            fieldKey="ws_port"
            field={serverInfo?.ws_port}
            hint={t('settings.wsPortHint')}
          />
          <ServerInfoRow
            label={t('settings.publicKey')}
            fieldKey="public_key"
            field={serverInfo?.public_key}
            hint={t('settings.publicKeyHint')}
          />
        </CardContent>
      </CollapsibleCard>

      <ServerUpdatesCard />

      <PanelUpdatesCard />

      <CollapsibleCard
        id="refresh"
        icon={<RefreshCw className="h-5 w-5 text-primary" />}
        title={t('settings.refreshTitle')}
        desc={t('settings.refreshDesc')}
      >
        <CardContent>
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="updateMode">{t('settings.refreshTitle')}</Label>
              <select
                id="updateMode"
                className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
                value={updateMode}
                onChange={handleUpdateModeChange}
              >
                <option value={STATUS_UPDATE_MODE_PUSH}>{t('settings.refreshModePush')}</option>
                <option value={STATUS_UPDATE_MODE_POLL}>{t('settings.refreshModePoll')}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t('settings.refreshModeHint')}</p>
            </div>
            <form onSubmit={handleIntervalSave} className="space-y-4 border-t border-border pt-4">
              <div className="space-y-2">
                <Label htmlFor="refreshInterval">{t('settings.refreshInterval')}</Label>
                <Input
                  id="refreshInterval"
                  type="number"
                  className="max-w-md"
                  min={MIN_STATUS_REFRESH_INTERVAL}
                  max={MAX_STATUS_REFRESH_INTERVAL}
                  step={1}
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.refreshHint', {
                    min: MIN_STATUS_REFRESH_INTERVAL,
                    max: MAX_STATUS_REFRESH_INTERVAL,
                    default: DEFAULT_STATUS_REFRESH_INTERVAL,
                    multiplier: 4 * intervalSec,
                  })}
                </p>
              </div>
              <Button type="submit" disabled={updateSetting.isPending}>
                {t('settings.saveInterval')}
              </Button>
            </form>
          </div>
        </CardContent>
      </CollapsibleCard>

      <CollapsibleCard
        id="session"
        icon={<Clock className="h-5 w-5 text-primary" />}
        title={t('settings.sessionTitle')}
        desc={t('settings.sessionDesc')}
      >
        <CardContent className="space-y-5">
          <form onSubmit={handleSessionTtlSave} className="space-y-4">
            <Label htmlFor="accessTtl">{t('settings.accessTokenTtl')}</Label>
            <Input
              id="accessTtl"
              type="number"
              className="max-w-md"
              min={MIN_ACCESS_TOKEN_TTL}
              max={MAX_ACCESS_TOKEN_TTL}
              step={1}
              value={accessTtl}
              onChange={(e) => setAccessTtl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.accessTtlHint', {
                min: MIN_ACCESS_TOKEN_TTL,
                max: MAX_ACCESS_TOKEN_TTL,
                default: DEFAULT_ACCESS_TOKEN_TTL,
              })}
            </p>
            <div className="border-t border-border pt-4">
              <Label htmlFor="refreshTtl">{t('settings.refreshTokenTtl')}</Label>
              <Input
                id="refreshTtl"
                type="number"
                className="max-w-md"
                min={MIN_REFRESH_TOKEN_TTL}
                max={MAX_REFRESH_TOKEN_TTL}
                step={1}
                value={refreshTtl}
                onChange={(e) => setRefreshTtl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.refreshTtlHint', {
                  min: MIN_REFRESH_TOKEN_TTL,
                  max: MAX_REFRESH_TOKEN_TTL,
                  default: DEFAULT_REFRESH_TOKEN_TTL,
                })}
              </p>
            </div>
            <Button type="submit" disabled={updateSetting.isPending}>
              {t('common.save')}
            </Button>
          </form>
        </CardContent>
      </CollapsibleCard>

      <CollapsibleCard
        id="web"
        icon={<MonitorSmartphone className="h-5 w-5 text-primary" />}
        title={t('settings.webDefaultsTitle')}
        desc={t('settings.webDefaultsDesc')}
      >
        <CardContent className="space-y-5">
          <form onSubmit={handleWebDefaultsSave} className="space-y-4">
            <Label htmlFor="webQuality">{t('settings.webQuality')}</Label>
            <select
              id="webQuality"
              className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
              value={webQuality}
              onChange={(e) => setWebQuality(e.target.value)}
            >
              <option value={0}>{t('settings.webQualityAuto')}</option>
              <option value={2}>{t('settings.webQualityLow')}</option>
              <option value={3}>{t('settings.webQualityBalanced')}</option>
              <option value={4}>{t('settings.webQualityBest')}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t('settings.webQualityHint')}
            </p>
            <Label htmlFor="webFps">{t('settings.webFps')}</Label>
            <Input
              id="webFps"
              type="number"
              className="max-w-md"
              min={MIN_WEB_CLIENT_FPS}
              max={MAX_WEB_CLIENT_FPS}
              step={1}
              value={webFps}
              onChange={(e) => setWebFps(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.webFpsHint', { min: MIN_WEB_CLIENT_FPS, max: MAX_WEB_CLIENT_FPS, default: DEFAULT_WEB_CLIENT_FPS })}
            </p>
            <Label htmlFor="webCodec">{t('settings.webCodec')}</Label>
            <select
              id="webCodec"
              className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
              value={webCodec}
              onChange={handleWebCodecChange}
            >
              {WEB_CLIENT_CODECS.map((c) => (
                <option key={c} value={c}>
                  {t(`settings.webCodec_${c}`)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('settings.webCodecHint')}</p>
            <Label htmlFor="webRenderScale">{t('settings.webRenderScale')}</Label>
            <select
              id="webRenderScale"
              className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
              value={webRenderScale}
              onChange={(e) => setWebRenderScale(e.target.value)}
            >
              {WEB_CLIENT_RENDER_SCALES.map((s) => (
                <option key={s} value={s}>
                  {t(`settings.webRenderScale_${s}`)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('settings.webRenderScaleHint')}</p>
            <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('settings.webCursor')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.webCursorHint')}</p>
              </div>
              <input
                id="webCursor"
                type="checkbox"
                aria-label={t('settings.webCursor')}
                className="accent-primary h-5 w-5 shrink-0"
                checked={webCursor}
                onChange={(e) => setWebCursor(e.target.checked)}
              />
            </div>
            <Label htmlFor="webInputMode">{t('settings.webInputMode')}</Label>
            <select
              id="webInputMode"
              className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
              value={webInputMode}
              onChange={(e) => setWebInputMode(e.target.value)}
            >
              {WEB_CLIENT_INPUT_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`settings.webInputMode_${m}`)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('settings.webInputModeHint')}</p>
            <Button type="submit" disabled={updateSetting.isPending}>
              {t('common.save')}
            </Button>
          </form>
        </CardContent>
      </CollapsibleCard>

      <CollapsibleCard
        id="chat"
        icon={<MessageCircle className="h-5 w-5 text-primary" />}
        title={t('settings.chatTitle')}
        desc={t('settings.chatDesc')}
      >
        <CardContent className="space-y-5">
          <form onSubmit={handleChatSave} className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('settings.chatGreetingEnabled')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.chatGreetingHint')}</p>
              </div>
              <input
                id="chatGreetingEnabled"
                type="checkbox"
                aria-label={t('settings.chatGreetingEnabled')}
                className="accent-primary h-5 w-5 shrink-0"
                checked={chatGreetingEnabled}
                onChange={(e) => setChatGreetingEnabled(e.target.checked)}
              />
            </div>
            <Label htmlFor="chatGreeting">{t('settings.chatGreeting')}</Label>
            <Input
              id="chatGreeting"
              type="text"
              maxLength={MAX_WEB_CLIENT_CHAT_TEXT}
              className="max-w-2xl"
              value={chatGreeting}
              onChange={(e) => setChatGreeting(e.target.value)}
            />
            <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('settings.chatCloseEnabled')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.chatCloseHint')}</p>
              </div>
              <input
                id="chatCloseEnabled"
                type="checkbox"
                aria-label={t('settings.chatCloseEnabled')}
                className="accent-primary h-5 w-5 shrink-0"
                checked={chatCloseEnabled}
                onChange={(e) => setChatCloseEnabled(e.target.checked)}
              />
            </div>
            <Label htmlFor="chatClose">{t('settings.chatClose')}</Label>
            <Input
              id="chatClose"
              type="text"
              maxLength={MAX_WEB_CLIENT_CHAT_TEXT}
              className="max-w-2xl"
              value={chatClose}
              onChange={(e) => setChatClose(e.target.value)}
            />
            <div>
              <Button type="submit" disabled={updateSetting.isPending}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        </CardContent>
      </CollapsibleCard>

      <CollapsibleCard
        id="credentials"
        icon={<ShieldCheck className="h-5 w-5 text-primary" />}
        title={t('settings.credentials')}
        desc={t('settings.credentialsDesc')}
      >
        <CardContent>
          <form onSubmit={handleCredentialsSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">{t('settings.currentPassword')}</Label>
              <Input
                id="currentPassword"
                type="password"
                className="max-w-md"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={t('settings.currentPasswordPh')}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newUsername">{t('settings.newUsername')}</Label>
              <Input
                id="newUsername"
                type="text"
                className="max-w-md"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t('settings.newUsernamePh')}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">{t('settings.newPassword')}</Label>
              <Input
                id="newPassword"
                type="password"
                className="max-w-md"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('settings.newPasswordPh')}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t('settings.confirmPassword')}</Label>
              <Input
                id="confirmPassword"
                type="password"
                className="max-w-md"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t('settings.confirmPasswordPh')}
                autoComplete="new-password"
              />
            </div>
            <div>
              <Button type="submit" disabled={changeCredentials.isPending}>
                {changeCredentials.isPending ? t('settings.saving') : t('settings.updateCredentials')}
              </Button>
            </div>
          </form>
        </CardContent>
      </CollapsibleCard>
    </div>
  )
}