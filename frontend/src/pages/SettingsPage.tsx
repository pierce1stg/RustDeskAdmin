
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { Server, Network, RefreshCw, ShieldCheck, Languages, Download, Check, Clock } from 'lucide-react'
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
} from '@/api/settings'
import { useChangeCredentials } from '@/api/auth'
import { apiErrorText } from '@/api/client'
import { useServerInfo, useUpdateServerInfo, ServerField } from '@/api/serverInfo'
import { useServerStatus } from '@/api/status'
import { useServerUpdates, useApplyUpdate, UpdateComponent } from '@/api/updates'
import { SUPPORTED_LANGS, LANGUAGE_LABELS, changeAppLanguage } from '@/i18n'
import i18n from '@/i18n'

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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.updateConfirmTitle', { component: componentLabel(comp) })}</DialogTitle>
            <DialogDescription>
              {t('settings.updateConfirmDesc', {
                current: info?.current || '—',
                latest: info?.latest || '—',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmComp(null)} disabled={apply.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
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
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Download className="h-5 w-5 text-primary" />
          <CardTitle>{t('settings.updatesTitle')}</CardTitle>
        </div>
        <p className="text-muted-foreground">{t('settings.updatesDesc')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
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
          {isError && <span className="text-xs text-red-600">{t('settings.checkFailed')}</span>}
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
    </Card>
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
  }, [settings, refreshInterval, accessTtl, refreshTtl])

  const address = serverInfo?.address?.value ?? ''
  const relay = serverInfo?.relay_address?.value ?? address

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

  const handleAccessTtlSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = Number(accessTtl)
    if (!Number.isInteger(value) || value < MIN_ACCESS_TOKEN_TTL || value > MAX_ACCESS_TOKEN_TTL) {
      toast({
        title: t('settings.invalidSessionTtl'),
        description: t('settings.invalidSessionTtlDesc', { min: MIN_ACCESS_TOKEN_TTL, max: MAX_ACCESS_TOKEN_TTL }),
        variant: 'destructive',
      })
      return
    }
    try {
      await updateSetting.mutateAsync({ key: ACCESS_TOKEN_TTL_KEY, value: String(value) })
      toast({ title: t('settings.accessTtlSaved'), description: t('settings.accessTtlSavedDesc', { value }), variant: 'success' })
    } catch {
      toast({ title: t('settings.sessionSaveFailed'), variant: 'destructive' })
    }
  }

  const handleRefreshTtlSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = Number(refreshTtl)
    if (!Number.isInteger(value) || value < MIN_REFRESH_TOKEN_TTL || value > MAX_REFRESH_TOKEN_TTL) {
      toast({
        title: t('settings.invalidSessionTtl'),
        description: t('settings.invalidSessionTtlDesc', { min: MIN_REFRESH_TOKEN_TTL, max: MAX_REFRESH_TOKEN_TTL }),
        variant: 'destructive',
      })
      return
    }
    try {
      await updateSetting.mutateAsync({ key: REFRESH_TOKEN_TTL_KEY, value: String(value) })
      toast({ title: t('settings.refreshTtlSaved'), description: t('settings.refreshTtlSavedDesc', { value }), variant: 'success' })
    } catch {
      toast({ title: t('settings.sessionSaveFailed'), variant: 'destructive' })
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
    <div className="w-full min-w-0 space-y-6">
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

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <CardTitle>{t('settings.serverInfo')}</CardTitle>
          </div>
          <p className="text-muted-foreground">
            {t('settings.serverInfoDesc')}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
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
      </Card>

      <ServerUpdatesCard />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            <CardTitle>{t('settings.webClient')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('settings.webClientDesc')}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg bg-muted p-4 font-mono text-sm space-y-1 overflow-x-auto">
            <p>{t('settings.webClientUrl')}</p>
            <p>{t('settings.webClientId', { address: address || '—' })}</p>
            <p>{t('settings.webClientRelayAddress', { relay: relay || '—' })}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('settings.webClientHint')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            <CardTitle>{t('settings.refreshTitle')}</CardTitle>
          </div>
          <p className="text-muted-foreground">
            {t('settings.refreshDesc')}
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-5">
            <div className="space-y-2">
              <select
                id="updateMode"
                className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
                value={updateMode}
                onChange={handleUpdateModeChange}
              >
                <option value={STATUS_UPDATE_MODE_PUSH}>{t('settings.refreshModePush')}</option>
                <option value={STATUS_UPDATE_MODE_POLL}>{t('settings.refreshModePoll')}</option>
              </select>
              <p className="text-sm text-muted-foreground">{t('settings.refreshModeHint')}</p>
            </div>
            <form onSubmit={handleIntervalSave} className="space-y-4 border-t border-border pt-4">
              <div className="space-y-2">
                <Label htmlFor="refreshInterval">{t('settings.refreshInterval')}</Label>
                <Input
                  id="refreshInterval"
                  type="number"
                  min={MIN_STATUS_REFRESH_INTERVAL}
                  max={MAX_STATUS_REFRESH_INTERVAL}
                  step={1}
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(e.target.value)}
                />
                <p className="text-sm text-muted-foreground">
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
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <CardTitle>{t('settings.sessionTitle')}</CardTitle>
          </div>
          <p className="text-muted-foreground">
            {t('settings.sessionDesc')}
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <form onSubmit={handleAccessTtlSave} className="space-y-2">
            <Label htmlFor="accessTtl">{t('settings.accessTokenTtl')}</Label>
            <Input
              id="accessTtl"
              type="number"
              min={MIN_ACCESS_TOKEN_TTL}
              max={MAX_ACCESS_TOKEN_TTL}
              step={1}
              value={accessTtl}
              onChange={(e) => setAccessTtl(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              {t('settings.accessTtlHint', {
                min: MIN_ACCESS_TOKEN_TTL,
                max: MAX_ACCESS_TOKEN_TTL,
                default: DEFAULT_ACCESS_TOKEN_TTL,
              })}
            </p>
            <Button type="submit" disabled={updateSetting.isPending}>
              {t('common.save')}
            </Button>
          </form>
          <form onSubmit={handleRefreshTtlSave} className="space-y-2 border-t border-border pt-4">
            <Label htmlFor="refreshTtl">{t('settings.refreshTokenTtl')}</Label>
            <Input
              id="refreshTtl"
              type="number"
              min={MIN_REFRESH_TOKEN_TTL}
              max={MAX_REFRESH_TOKEN_TTL}
              step={1}
              value={refreshTtl}
              onChange={(e) => setRefreshTtl(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              {t('settings.refreshTtlHint', {
                min: MIN_REFRESH_TOKEN_TTL,
                max: MAX_REFRESH_TOKEN_TTL,
                default: DEFAULT_REFRESH_TOKEN_TTL,
              })}
            </p>
            <Button type="submit" disabled={updateSetting.isPending}>
              {t('common.save')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <CardTitle>{t('settings.credentials')}</CardTitle>
          </div>
          <p className="text-muted-foreground">
            {t('settings.credentialsDesc')}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCredentialsSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">{t('settings.currentPassword')}</Label>
              <Input
                id="currentPassword"
                type="password"
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
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t('settings.confirmPasswordPh')}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" disabled={changeCredentials.isPending}>
              {changeCredentials.isPending ? t('settings.saving') : t('settings.updateCredentials')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}