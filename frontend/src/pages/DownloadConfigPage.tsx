import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { SUPPORTED_LANGS, LANGUAGE_LABELS } from '@/i18n'
import {
  Monitor,
  Laptop,
  Terminal,
  Smartphone,
  Tablet,
  Languages,
  Link2,
  Image as ImageIcon,
  Plus,
  Trash2,
  Save,
  ExternalLink,
  Loader2,
  ChevronUp,
  ChevronDown,
  ListOrdered,
  ImagePlus,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { apiErrorText } from '@/api/client'
import { cn } from '@/lib/utils'
import {
  INSTRUCTION_COLORS,
  instructionColorStyle,
  instructionColorSwatch,
  normalizeHexColor,
  isHexColor,
} from '@/lib/instructionColors'
import {
  useDownloadPageConfig,
  useSaveDownloadPageConfig,
  useUploadScreenshot,
  useDeleteScreenshot,
  type DownloadPageConfig,
  type DownloadLang,
  type DownloadButton,
  type PlatformKey,
  type Instruction,
  type InstructionStep,
  type ScreenshotEntry,
} from '@/api/downloadPage'

const PLATFORM_ICONS: Record<PlatformKey, LucideIcon> = {
  windows: Monitor,
  macos: Laptop,
  linux: Terminal,
  android: Smartphone,
  ios: Tablet,
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

type LangTexts = { en: string; ru: string; zh: string; ar: string }

const emptyTexts = (): LangTexts => ({ en: '', ru: '', zh: '', ar: '' })
const emptyStep = (): InstructionStep => ({ text: '', imagesLight: [], imagesDark: [], buttons: [] })

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const fileBase = (url: string) => {
  const i = url.lastIndexOf('/')
  return i >= 0 ? url.slice(i + 1) : url
}

export function DownloadConfigPage() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const query = useDownloadPageConfig()
  const saveMutation = useSaveDownloadPageConfig()
  const uploadMutation = useUploadScreenshot()
  const deleteMutation = useDeleteScreenshot()

  const [editLang, setEditLang] = useState<DownloadLang>(() => {
    const resolved = i18n.resolvedLanguage || 'en'
    return (SUPPORTED_LANGS as readonly string[]).includes(resolved) ? (resolved as DownloadLang) : 'en'
  })

  const [cfg, setCfg] = useState<DownloadPageConfig | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<Instruction | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const hydratedRef = useRef(false)

  useEffect(() => {
    if (!hydratedRef.current && query.data) {
      hydratedRef.current = true
      setCfg(query.data)
    }
  }, [query.data])

  if (!cfg) {
    return <p className="text-muted-foreground">{t('downloadConfig.loading')}</p>
  }

  const updateLangString = (target: 'title' | 'subtitle' | 'intro' | 'instructionsTitle', value: string) => {
    setCfg((prev) => {
      if (!prev) return prev
      const copy: DownloadPageConfig = JSON.parse(JSON.stringify(prev))
      copy[target] = { ...copy[target], [editLang]: value }
      return copy
    })
  }

  const setPlatform = (key: PlatformKey, patch: Partial<DownloadPageConfig['platforms'][PlatformKey]>) => {
    setCfg((prev) => {
      if (!prev) return prev
      const copy: DownloadPageConfig = JSON.parse(JSON.stringify(prev))
      copy.platforms = {
        ...copy.platforms,
        [key]: {
          ...copy.platforms[key],
          ...patch,
        },
      }
      return copy
    })
  }

  const setPlatformButton = (key: PlatformKey, index: number, patch: Partial<DownloadButton>) => {
    setCfg((prev) => {
      if (!prev) return prev
      const copy: DownloadPageConfig = JSON.parse(JSON.stringify(prev))
      const platform = { ...copy.platforms[key] }
      const list = [...(platform.buttons?.[editLang] || [])]
      list[index] = { ...list[index], ...patch }
      platform.buttons = { ...platform.buttons, [editLang]: list }
      copy.platforms = { ...copy.platforms, [key]: platform }
      return copy
    })
  }

  const addPlatformButton = (key: PlatformKey) => {
    setCfg((prev) => {
      if (!prev) return prev
      const copy: DownloadPageConfig = JSON.parse(JSON.stringify(prev))
      const platform = { ...copy.platforms[key] }
      const list = [...(platform.buttons?.[editLang] || []), { name: '', url: '', enabled: true }]
      platform.buttons = { ...platform.buttons, [editLang]: list }
      copy.platforms = { ...copy.platforms, [key]: platform }
      return copy
    })
  }

  const removePlatformButton = (key: PlatformKey, index: number) => {
    setCfg((prev) => {
      if (!prev) return prev
      const copy: DownloadPageConfig = JSON.parse(JSON.stringify(prev))
      const platform = { ...copy.platforms[key] }
      const list = (platform.buttons?.[editLang] || []).filter((_, i) => i !== index)
      platform.buttons = { ...platform.buttons, [editLang]: list }
      copy.platforms = { ...copy.platforms, [key]: platform }
      return copy
    })
  }

  const movePlatform = (key: PlatformKey, dir: -1 | 1) => {
    setCfg((prev) => {
      if (!prev) return prev
      const ordered = (Object.keys(PLATFORM_ICONS) as PlatformKey[])
        .slice()
        .sort((a, b) => (prev.platforms[a]?.order ?? 0) - (prev.platforms[b]?.order ?? 0))
      const i = ordered.indexOf(key)
      const j = i + dir
      if (j < 0 || j >= ordered.length) return prev
      const next = [...ordered]
      ;[next[i], next[j]] = [next[j], next[i]]
      const copy: DownloadPageConfig = JSON.parse(JSON.stringify(prev))
      next.forEach((k, idx) => {
        copy.platforms[k] = { ...copy.platforms[k], order: idx }
      })
      return copy
    })
  }

  const setInstruction = (index: number, updater: (ins: Instruction) => Instruction) => {
    setCfg((prev) => {
      if (!prev) return prev
      const copy: DownloadPageConfig = JSON.parse(JSON.stringify(prev))
      const list = [...(copy.instructions[editLang] || [])]
      list[index] = updater(list[index])
      copy.instructions = { ...copy.instructions, [editLang]: list }
      return copy
    })
  }

  const removeInstruction = (index: number) =>
    setCfg((prev) => {
      if (!prev) return prev
      const list = [...(prev.instructions[editLang] || [])]
      list.splice(index, 1)
      return { ...prev, instructions: { ...prev.instructions, [editLang]: list } }
    })

  const moveInstruction = (index: number, dir: -1 | 1) =>
    setCfg((prev) => {
      if (!prev) return prev
      const j = index + dir
      const list = [...(prev.instructions[editLang] || [])]
      if (j < 0 || j >= list.length) return prev
      ;[list[index], list[j]] = [list[j], list[index]]
      return { ...prev, instructions: { ...prev.instructions, [editLang]: list } }
    })

  const onSave = async () => {
    if (!cfg) return
    try {
      const resolved = i18n.resolvedLanguage || 'en'
      const lang = (SUPPORTED_LANGS as readonly string[]).includes(resolved) ? resolved : 'en'
      await saveMutation.mutateAsync({ ...cfg, lang })
      toast({ title: t('downloadConfig.saved'), variant: 'success' })
    } catch (error) {
      toast({
        title: t('downloadConfig.saveFailed'),
        description: apiErrorText(error),
        variant: 'destructive',
      })
    }
  }

  const uploadScreenshotUrl = async (file: File): Promise<string> => {
    const entry = await uploadMutation.mutateAsync(file)
    toast({ title: t('downloadConfig.uploaded'), variant: 'success' })
    setCfg((prev) => {
      if (!prev) return prev
      if (prev.screenshots.some((s) => s.id === entry.id)) return prev
      return { ...prev, screenshots: [...prev.screenshots, entry] }
    })
    return entry.url
  }

  const onDelete = async (screenshot: DownloadPageConfig['screenshots'][number]) => {
    setCfg((prev) => (prev ? { ...prev, screenshots: prev.screenshots.filter((s) => s.id !== screenshot.id) } : prev))
    try {
      await deleteMutation.mutateAsync(screenshot.id)
      toast({ title: t('downloadConfig.deleted'), variant: 'success' })
    } catch (error) {
      toast({
        title: t('downloadConfig.deleteFailed'),
        description: apiErrorText(error),
        variant: 'destructive',
      })
    }
  }

  const openCreateDialog = () => {
    setDraft({ id: newId(), title: '', target: '', color: '', steps: [emptyStep()] })
    setDialogOpen(true)
  }

  const commitDraft = () => {
    if (!draft) return
    setCfg((prev) => {
      if (!prev) return prev
      const list = [...(prev.instructions[editLang] || []), draft]
      return { ...prev, instructions: { ...prev.instructions, [editLang]: list } }
    })
    setExpandedId(draft.id)
    setDialogOpen(false)
  }

  const langValue = (ls?: LangTexts) => (ls && ls[editLang]) || ''

  const currentInstructions = cfg.instructions[editLang] || []

  const platformOrderedKeys = (Object.keys(PLATFORM_ICONS) as PlatformKey[])
    .slice()
    .sort((a, b) => (cfg.platforms[a]?.order ?? 0) - (cfg.platforms[b]?.order ?? 0))

  return (
    <div className="w-full min-w-0 max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">{t('downloadConfig.desc')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <a href="/download" target="_blank" rel="noreferrer">
              <ExternalLink className="me-2 h-4 w-4" />
              {t('downloadConfig.openPublic')}
            </a>
          </Button>
          <Button onClick={onSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="me-2 h-4 w-4" />
            )}
            {t('downloadConfig.save')}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Languages className="h-5 w-5 text-primary" />
            <CardTitle>{t('downloadConfig.language')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('downloadConfig.languageDesc')}</p>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border space-y-2 px-4 py-3">
            <select
              aria-label={t('downloadConfig.language')}
              className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
              value={editLang}
              onChange={(e) => setEditLang(e.target.value as DownloadLang)}
            >
              {(SUPPORTED_LANGS as readonly string[]).map((code) => (
                <option key={code} value={code} dir={code === 'ar' ? 'rtl' : 'ltr'}>
                  {LANGUAGE_LABELS[code as keyof typeof LANGUAGE_LABELS]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('downloadConfig.localizePage')}</p>
              <p className="text-xs text-muted-foreground">{t('downloadConfig.localizePageDesc')}</p>
            </div>
            <input
              aria-label={t('downloadConfig.localizePage')}
              type="checkbox"
              className="accent-primary h-5 w-5 shrink-0"
              checked={cfg.localized}
              onChange={(e) =>
                setCfg((prev) => (prev ? { ...prev, localized: e.target.checked } : prev))
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Languages className="h-5 w-5 text-primary" />
            <CardTitle>{t('downloadConfig.textsTitle')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('downloadConfig.textsDesc')}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dp-title">
              {t('downloadConfig.pageTitle')}
            </label>
            <input
              id="dp-title"
              className="neu-field h-10 w-full px-3 py-2 text-sm"
              placeholder={t('download.title')}
              value={langValue(cfg.title) || ''}
              onChange={(e) => updateLangString('title', e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dp-subtitle">
              {t('downloadConfig.pageSubtitle')}
            </label>
            <input
              id="dp-subtitle"
              className="neu-field h-10 w-full px-3 py-2 text-sm"
              placeholder={t('download.subtitle', { host: '' })}
              value={langValue(cfg.subtitle) || ''}
              onChange={(e) => updateLangString('subtitle', e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dp-intro">
              {t('downloadConfig.pageIntro')}
            </label>
            <textarea
              id="dp-intro"
              className="neu-field min-h-24 w-full max-w-2xl resize-y px-3 py-2 text-sm"
              placeholder={t('download.intro')}
              value={langValue(cfg.intro) || ''}
              onChange={(e) => updateLangString('intro', e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('downloadConfig.showConnectionDetails')}</p>
              <p className="text-xs text-muted-foreground">
                {t('downloadConfig.showConnectionDetailsDesc')}
              </p>
            </div>
            <input
              aria-label={t('downloadConfig.showConnectionDetails')}
              type="checkbox"
              className="accent-primary h-5 w-5 shrink-0"
              checked={cfg.showConnectionDetails}
              onChange={(e) =>
                setCfg((prev) => (prev ? { ...prev, showConnectionDetails: e.target.checked } : prev))
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            <CardTitle>{t('downloadConfig.platformsTitle')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('downloadConfig.platformsDesc')}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          {platformOrderedKeys.map((key) => {
            const Icon = PLATFORM_ICONS[key]
            const platform = cfg.platforms[key] || { enabled: true, instructions: emptyTexts(), buttons: {} }
            const platformIndex = platformOrderedKeys.indexOf(key)
            return (
              <div key={key} className="rounded-lg border p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5 text-primary" />
                    <span className="font-medium">{t(`download.platforms.${key}.name`)}</span>
                    <div className="flex items-center gap-1 ms-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={platformIndex === 0}
                        title={t('downloadConfig.moveUp')}
                        onClick={() => movePlatform(key, -1)}
                      >
                        <ChevronUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={platformIndex === platformOrderedKeys.length - 1}
                        title={t('downloadConfig.moveDown')}
                        onClick={() => movePlatform(key, 1)}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      className="accent-primary h-4 w-4"
                      checked={platform.enabled}
                      onChange={(e) => setPlatform(key, { enabled: e.target.checked })}
                    />
                    {t('downloadConfig.enabled')}
                  </label>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor={`dp-instr-${key}`}>
                    {t('downloadConfig.platformDescription')}
                  </label>
                  <textarea
                    id={`dp-instr-${key}`}
                    className="neu-field min-h-20 w-full max-w-2xl resize-y px-3 py-2 text-sm"
                    value={langValue(platform.instructions) || ''}
                    onChange={(e) =>
                      setPlatform(key, {
                        instructions: { ...platform.instructions, [editLang]: e.target.value },
                      })
                    }
                  />
                </div>

                <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-sm font-medium">{t('downloadConfig.buttons')}</label>
                    <Button variant="outline" size="sm" onClick={() => addPlatformButton(key)}>
                      <Plus className="me-2 h-4 w-4" />
                      {t('downloadConfig.addButton')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('downloadConfig.buttonsDesc')}</p>

                  {(platform.buttons?.[editLang] || []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('downloadConfig.noButtons')}</p>
                  ) : (
                    <div className="space-y-2">
                      {(platform.buttons?.[editLang] || []).map((b, index) => (
                        <div
                          key={index}
                          className="grid grid-cols-1 gap-2 rounded-md border bg-background p-2 sm:grid-cols-[1fr_1fr_auto_auto]"
                        >
                          <input
                            aria-label={t('downloadConfig.buttonName')}
                            className="neu-field h-9 w-full px-2 py-1 text-sm"
                            placeholder={t('downloadConfig.buttonName')}
                            value={b.name}
                            onChange={(e) => setPlatformButton(key, index, { name: e.target.value })}
                          />
                          <input
                            aria-label={t('downloadConfig.buttonUrl')}
                            className="neu-field h-9 w-full px-2 py-1 text-sm font-mono"
                            placeholder={t('downloadConfig.buttonUrl')}
                            dir="ltr"
                            value={b.url}
                            onChange={(e) => setPlatformButton(key, index, { url: e.target.value })}
                          />
                          <label
                            className="flex items-center gap-1.5 text-sm text-muted-foreground"
                            title={t('downloadConfig.showOnPage')}
                          >
                            <input
                              type="checkbox"
                              className="accent-primary h-4 w-4"
                              checked={b.enabled}
                              onChange={(e) => setPlatformButton(key, index, { enabled: e.target.checked })}
                            />
                            {t('downloadConfig.showOnPage')}
                          </label>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive"
                            title={t('downloadConfig.delete')}
                            onClick={() => removePlatformButton(key, index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ListOrdered className="h-5 w-5 text-primary" />
            <CardTitle>{t('downloadConfig.instructionsTitle')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('downloadConfig.instructionsDesc')}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dp-instructions-title">
              {t('downloadConfig.instructionsSectionTitle')}
            </label>
            <input
              id="dp-instructions-title"
              className="neu-field h-10 w-full px-3 py-2 text-sm"
              placeholder={t('download.instructionsTitle')}
              value={langValue(cfg.instructionsTitle) || ''}
              onChange={(e) => updateLangString('instructionsTitle', e.target.value)}
            />
          </div>
          <Button variant="outline" onClick={openCreateDialog}>
            <Plus className="me-2 h-4 w-4" />
            {t('downloadConfig.createInstruction')}
          </Button>

          {currentInstructions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('downloadConfig.noInstructions')}</p>
          ) : (
            <div className="space-y-3">
              {currentInstructions.map((instruction, index) => {
                const expanded = expandedId === instruction.id
                return (
                  <div key={instruction.id} className="rounded-lg border p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : instruction.id)}
                        title={expanded ? t('downloadConfig.collapse') : t('downloadConfig.expand')}
                        className="raw-focus flex min-w-0 flex-1 select-none items-center gap-2 text-start"
                      >
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                            !expanded && '-rotate-90',
                          )}
                        />
                        <span className="truncate text-sm font-medium text-muted-foreground">
                          {instruction.title || t('downloadConfig.instructionLabel', { n: index + 1 })}
                        </span>
                      </button>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={index === 0}
                          onClick={() => moveInstruction(index, -1)}
                          title={t('downloadConfig.moveUp')}
                        >
                          <ChevronUp className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={index === currentInstructions.length - 1}
                          onClick={() => moveInstruction(index, 1)}
                          title={t('downloadConfig.moveDown')}
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          title={t('downloadConfig.delete')}
                          onClick={() => removeInstruction(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {expanded && (
                      <InstructionEditor
                        instruction={instruction}
                        onChange={(next) => setInstruction(index, () => next)}
                        library={cfg.screenshots}
                        uploadImage={uploadScreenshotUrl}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5 text-primary" />
            <CardTitle>{t('downloadConfig.libraryTitle')}</CardTitle>
          </div>
          <p className="text-muted-foreground">{t('downloadConfig.libraryDesc')}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          {cfg.screenshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('downloadConfig.noScreenshots')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cfg.screenshots.map((s) => (
                <div key={s.id} className="space-y-2 rounded-lg border p-3">
                  <a href={s.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md bg-muted/40">
                    <img src={s.url} alt="" className="h-40 w-full object-cover" loading="lazy" />
                  </a>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-muted-foreground">{fileBase(s.url)}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      title={t('downloadConfig.delete')}
                      onClick={() => onDelete(s)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {cfg.screenshots.length >= 20 ? (
            <p className="text-xs text-muted-foreground">{t('downloadConfig.libraryFull')}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{t('downloadConfig.uploadHint')}</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('downloadConfig.createInstruction')}</DialogTitle>
            <DialogDescription>{t('downloadConfig.dialogDesc')}</DialogDescription>
          </DialogHeader>
          {draft && (
            <InstructionEditor
              instruction={draft}
              onChange={setDraft}
              library={cfg.screenshots}
              uploadImage={uploadScreenshotUrl}
            />
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={commitDraft} disabled={!draft}>
              {t('downloadConfig.addInstructionConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function InstructionEditor({
  instruction,
  onChange,
  library,
  uploadImage,
}: {
  instruction: Instruction
  onChange: (next: Instruction) => void
  library: ScreenshotEntry[]
  uploadImage: (file: File) => Promise<string>
}) {
  const { t } = useTranslation()

  const [customColorText, setCustomColorText] = useState(
    instruction.color && isHexColor(instruction.color) ? instruction.color : '',
  )

  useEffect(() => {
    if (!isHexColor(instruction.color)) setCustomColorText('')
  }, [instruction.color])

  const currentColorHex = instructionColorSwatch(instruction.color) || '#2563eb'

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`ins-title-${instruction.id}`}>
          {t('downloadConfig.instructionTitle')}
        </label>
        <input
          id={`ins-title-${instruction.id}`}
          className="neu-field h-10 w-full px-3 py-2 text-sm"
          placeholder={t('downloadConfig.instructionTitlePh')}
          value={instruction.title || ''}
          onChange={(e) => onChange({ ...instruction, title: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`ins-target-${instruction.id}`}>
            {t('downloadConfig.instructionTarget')}
          </label>
          <select
            id={`ins-target-${instruction.id}`}
            className="neu-field h-10 w-full max-w-xs px-3 py-2 text-sm"
            value={instruction.target || ''}
            onChange={(e) => onChange({ ...instruction, target: e.target.value })}
          >
            <option value="">{t('downloadConfig.instructionTargetNone')}</option>
            {(Object.keys(PLATFORM_ICONS) as PlatformKey[]).map((key) => (
              <option key={key} value={key}>
                {t(`download.platforms.${key}.name`)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('downloadConfig.buttonColor')}</label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={cn(
                'raw-focus h-9 rounded-md border px-3 text-xs font-medium transition-shadow',
                instruction.color === '' ? 'ring-2 ring-ring ring-offset-1' : 'text-muted-foreground',
              )}
              onClick={() => onChange({ ...instruction, color: '' })}
            >
              {t('downloadConfig.colorDefault')}
            </button>
            {INSTRUCTION_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={t(`downloadConfig.color_${c.key}`)}
                title={t(`downloadConfig.color_${c.key}`)}
                className={cn(
                  'raw-focus h-9 w-9 rounded-md border transition-transform hover:scale-105',
                  instruction.color === c.key && 'ring-2 ring-ring ring-offset-2',
                )}
                style={{ backgroundColor: c.swatch }}
                onClick={() => onChange({ ...instruction, color: c.key })}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              aria-label={t('downloadConfig.customColor')}
              className="h-9 w-12 cursor-pointer rounded-md border bg-background"
              value={currentColorHex}
              onChange={(e) => {
                const hex = normalizeHexColor(e.target.value)
                setCustomColorText(hex)
                onChange({ ...instruction, color: hex })
              }}
            />
            <input
              aria-label={t('downloadConfig.customColor')}
              className="neu-field h-9 w-36 px-3 py-1 text-xs font-mono"
              placeholder="#4e79f1"
              dir="ltr"
              value={customColorText}
              onChange={(e) => setCustomColorText(e.target.value)}
              onBlur={(e) => {
                const hex = normalizeHexColor(e.target.value)
                if (hex) {
                  setCustomColorText(hex)
                  onChange({ ...instruction, color: hex })
                } else {
                  setCustomColorText('')
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const hex = normalizeHexColor(e.currentTarget.value)
                  if (hex) {
                    setCustomColorText(hex)
                    onChange({ ...instruction, color: hex })
                  }
                }
              }}
            />
          </div>
          <Button
            size="sm"
            className="pointer-events-none w-full sm:w-auto"
            style={instructionColorStyle(instruction.color)}
          >
            {t('downloadConfig.colorPreview')}
          </Button>
        </div>
      </div>

      {instruction.target && (
        <p className="text-xs text-muted-foreground">
          {t('downloadConfig.instructionTargetHint')}
        </p>
      )}

      {instruction.steps.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('downloadConfig.noSteps')}</p>
      )}

      {instruction.steps.map((step, si) => (
        <div key={si} className="rounded-lg border bg-muted/20 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('downloadConfig.stepLabel', { n: si + 1 })}</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={si === 0}
                onClick={() => {
                  const j = si - 1
                  const steps = [...instruction.steps]
                  ;[steps[si], steps[j]] = [steps[j], steps[si]]
                  onChange({ ...instruction, steps })
                }}
                title={t('downloadConfig.moveUp')}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={si === instruction.steps.length - 1}
                onClick={() => {
                  const j = si + 1
                  const steps = [...instruction.steps]
                  ;[steps[si], steps[j]] = [steps[j], steps[si]]
                  onChange({ ...instruction, steps })
                }}
                title={t('downloadConfig.moveDown')}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                title={t('downloadConfig.delete')}
                onClick={() => onChange({ ...instruction, steps: instruction.steps.filter((_, i) => i !== si) })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <textarea
            aria-label={t('downloadConfig.stepText')}
            className="neu-field min-h-20 w-full max-w-2xl resize-y px-3 py-2 text-sm"
            placeholder={t('downloadConfig.stepTextPh')}
            value={step.text || ''}
            onChange={(e) =>
              onChange({
                ...instruction,
                steps: instruction.steps.map((s, i) =>
                  i === si ? { ...s, text: e.target.value } : s,
                ),
              })
            }
          />

          <div className="space-y-3">
            <ThemePhotoField
              title={t('downloadConfig.photosLight')}
              images={step.imagesLight || []}
              hint={t('downloadConfig.photosHint')}
              limitLabel={t('downloadConfig.photosPerThemeLimit')}
              library={library}
              uploadImage={uploadImage}
              onAdd={(urls) => patchStepImages(instruction, onChange, si, 'light', (list) => [...list, ...urls])}
              onRemove={(k) => patchStepImages(instruction, onChange, si, 'light', (list) => list.filter((_, i2) => i2 !== k))}
            />
            <ThemePhotoField
              title={t('downloadConfig.photosDark')}
              images={step.imagesDark || []}
              hint={t('downloadConfig.photosHint')}
              limitLabel={t('downloadConfig.photosPerThemeLimit')}
              library={library}
              uploadImage={uploadImage}
              onAdd={(urls) => patchStepImages(instruction, onChange, si, 'dark', (list) => [...list, ...urls])}
              onRemove={(k) => patchStepImages(instruction, onChange, si, 'dark', (list) => list.filter((_, i2) => i2 !== k))}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('downloadConfig.stepButtons')}</label>
            {step.buttons.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('downloadConfig.noStepButtons')}</p>
            )}
            {step.buttons.map((btn, k) => (
              <div key={k} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  aria-label={t('downloadConfig.buttonName')}
                  className="neu-field h-9 w-full px-2 py-1 text-sm"
                  placeholder={t('downloadConfig.buttonName')}
                  value={btn.text || ''}
                  onChange={(e) =>
                    onChange({
                      ...instruction,
                      steps: instruction.steps.map((s, i) =>
                        i === si
                          ? {
                              ...s,
                              buttons: s.buttons.map((b, i2) =>
                                i2 === k ? { ...b, text: e.target.value } : b,
                              ),
                            }
                          : s,
                      ),
                    })
                  }
                />
                <input
                  aria-label={t('downloadConfig.buttonUrl')}
                  className="neu-field h-9 w-full px-2 py-1 text-sm font-mono"
                  placeholder={t('downloadConfig.buttonUrl')}
                  dir="ltr"
                  value={btn.url}
                  onChange={(e) =>
                    onChange({
                      ...instruction,
                      steps: instruction.steps.map((s, i) =>
                        i === si
                          ? {
                              ...s,
                              buttons: s.buttons.map((b, i2) => (i2 === k ? { ...b, url: e.target.value } : b)),
                            }
                          : s,
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-destructive"
                  title={t('downloadConfig.delete')}
                  onClick={() =>
                    onChange({
                      ...instruction,
                      steps: instruction.steps.map((s, i) =>
                        i === si ? { ...s, buttons: s.buttons.filter((_, i2) => i2 !== k) } : s,
                      ),
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => addStepButtonOf(instruction, onChange, si)}>
              <Plus className="me-2 h-4 w-4" />
              {t('downloadConfig.addStepButton')}
            </Button>
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange({ ...instruction, steps: [...instruction.steps, emptyStep()] })}
      >
        <Plus className="me-2 h-4 w-4" />
        {t('downloadConfig.addStep')}
      </Button>
    </div>
  )
}

function addStepButtonOf(instruction: Instruction, onChange: (n: Instruction) => void, step: number) {
  onChange({
    ...instruction,
    steps: instruction.steps.map((s, i) =>
      i === step ? { ...s, buttons: [...s.buttons, { text: '', url: '' }] } : s,
    ),
  })
}

type ThemeSlot = 'light' | 'dark'

function patchStepImages(
  instruction: Instruction,
  onChange: (n: Instruction) => void,
  step: number,
  theme: ThemeSlot,
  patch: (list: string[]) => string[],
) {
  const key = theme === 'light' ? 'imagesLight' : 'imagesDark'
  onChange({
    ...instruction,
    steps: instruction.steps.map((s, i) =>
      i === step ? { ...s, [key]: patch(s[key] || []) } : s,
    ),
  })
}

function ThemePhotoField({
  title,
  images,
  hint,
  limitLabel,
  library,
  uploadImage,
  onAdd,
  onRemove,
}: {
  title: string
  images: string[]
  hint: string
  limitLabel: string
  library: ScreenshotEntry[]
  uploadImage: (file: File) => Promise<string>
  onAdd: (urls: string[]) => void
  onRemove: (index: number) => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const full = images.length >= 3

  const uploadFiles = async (files: File[]) => {
    const accepted = files.filter((f) => IMAGE_ACCEPT.split(',').includes(f.type))
    if (accepted.length === 0) return
    const remaining = 3 - images.length
    if (files.length > remaining || accepted.length > remaining) {
      toast({ title: limitLabel, variant: 'destructive' })
    }
    const picked = accepted.slice(0, remaining)
    if (picked.length === 0) return
    try {
      const urls = await Promise.all(picked.map((f) => uploadImage(f)))
      onAdd(urls)
    } catch (error) {
      toast({
        title: t('downloadConfig.uploadFailed'),
        description: apiErrorText(error),
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-medium">{title}</label>
        <select
          aria-label={t('downloadConfig.fromLibrary')}
          className="neu-field h-8 w-auto max-w-[14rem] px-2 py-1 text-xs"
          value=""
          disabled={full}
          onChange={(e) => {
            const url = e.target.value
            e.target.value = ''
            if (!url) return
            if (full) {
              toast({ title: t('downloadConfig.photosLimit'), variant: 'destructive' })
              return
            }
            onAdd([url])
          }}
        >
          <option value="">{t('downloadConfig.fromLibrary')}</option>
          {library.map((ent) => (
            <option key={ent.id} value={ent.url}>
              {fileBase(ent.url)}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {images.map((url, k) => (
          <div key={k} className="relative h-20 w-24 overflow-hidden rounded-md border bg-muted/40">
            <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
            <button
              type="button"
              aria-label={t('downloadConfig.delete')}
              className="raw-focus absolute end-1 top-1 rounded bg-black/60 p-0.5 text-white hover:bg-black/80"
              onClick={() => onRemove(k)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {!full && (
          <button
            type="button"
            className={cn(
              'raw-focus flex h-20 w-full max-w-[16rem] flex-col items-center justify-center gap-1 rounded-md border border-dashed p-2 text-xs text-muted-foreground transition-colors sm:w-auto sm:min-w-[10rem]',
              dragging ? 'border-primary bg-muted/40 text-primary' : 'hover:bg-muted/40',
            )}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              void uploadFiles(Array.from(e.dataTransfer.files))
            }}
          >
            <ImagePlus className="h-5 w-5" />
            {t('downloadConfig.addPhoto')}
            <span className="text-xs opacity-80">{t('downloadConfig.dragDropHint')}</span>
          </button>
        )}
        {full && <p className="text-xs text-muted-foreground">{limitLabel}</p>}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          e.target.value = ''
          void uploadFiles(files)
        }}
      />
    </div>
  )
}