import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { SUPPORTED_LANGS, LANGUAGE_LABELS, changeAppLanguage } from '@/i18n'
import {
  Monitor,
  Laptop,
  Terminal,
  Smartphone,
  Tablet,
  Copy,
  Link2,
  Key as KeyIcon,
  BookOpen,
  Server,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListOrdered,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { instructionColorStyle } from '@/lib/instructionColors'
import { useIsDark } from '@/lib/useIsDark'
import {
  usePublicClientInfo,
  usePublicDownloadConfig,
  type PlatformKey,
  type Instruction,
  type InstructionStep,
  type DownloadLang,
  type LangStrings,
} from '@/api/downloadPage'

const DEFAULT_PLATFORM_LINK = 'https://rustdesk.com/download'

const PLATFORM_ICONS: Record<PlatformKey, LucideIcon> = {
  windows: Monitor,
  macos: Laptop,
  linux: Terminal,
  android: Smartphone,
  ios: Tablet,
}

export function DownloadPage() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const infoQuery = usePublicClientInfo()
  const configQuery = usePublicDownloadConfig()

  const info = infoQuery.data
  const config = configQuery.data

  const currentLang = i18n.resolvedLanguage || 'en'

  const lang: DownloadLang = (() => {
    if (config && config.localized === false) {
      const pinned = config.lang
      return (SUPPORTED_LANGS as readonly string[]).includes(pinned) ? (pinned as DownloadLang) : 'en'
    }
    return (SUPPORTED_LANGS as readonly string[]).includes(currentLang) ? (currentLang as DownloadLang) : 'en'
  })()

  useEffect(() => {
    if (config && config.localized === false && config.lang) {
      const pinned = (SUPPORTED_LANGS as readonly string[]).includes(config.lang) ? config.lang : 'en'
      if (pinned !== i18n.resolvedLanguage) changeAppLanguage(pinned)
    }
  }, [config])

  const tCfg = (ls?: LangStrings | null) => {
    return (ls && ls[lang as keyof typeof ls]) || ''
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: t('download.copied'), variant: 'success' })
    } catch {
      toast({ title: t('download.copyFailed'), variant: 'destructive' })
    }
  }

  const prettyRaw = (() => {
    if (!info?.connect?.raw) return ''
    try {
      return JSON.stringify(JSON.parse(info.connect.raw), null, 2)
    } catch {
      return info.connect.raw
    }
  })()

  const langInstructions = config?.instructions?.[lang]
  const instructions = (langInstructions && langInstructions.length > 0 ? langInstructions : config?.instructions?.en) || []

  const knownPlatformOrder = Object.keys(PLATFORM_ICONS) as PlatformKey[]
  const orderedPlatforms = knownPlatformOrder
    .slice()
    .sort(
      (a, b) =>
        (config?.platforms?.[a]?.order ?? knownPlatformOrder.indexOf(a)) -
        (config?.platforms?.[b]?.order ?? knownPlatformOrder.indexOf(b)),
    )

  const [openId, setOpenId] = useState<string | null>(null)

  const openInstruction = (id: string) => {
    setOpenId(id)
    requestAnimationFrame(() => {
      document.getElementById(`instruction-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const instructionTitle = (instruction: Instruction, position: number) => {
    return instruction.title || t('download.instructionUntitled', { n: position })
  }

  return (
    <div className="min-h-screen bg-muted/50 px-4">
      <div className="fixed top-4 end-4 z-50 flex items-center gap-2">
        {config?.localized !== false && (
          <select
            aria-label={t('download.language')}
            className="neu-field h-9 w-auto px-2 py-1 text-sm"
            value={lang}
            onChange={(e) => changeAppLanguage(e.target.value)}
          >
            {(SUPPORTED_LANGS as readonly string[]).map((code) => (
              <option key={code} value={code} dir={code === 'ar' ? 'rtl' : 'ltr'}>
                {LANGUAGE_LABELS[code as keyof typeof LANGUAGE_LABELS]}
              </option>
            ))}
          </select>
        )}
        <ThemeToggle />
      </div>

      <main className="mx-auto max-w-5xl py-16">
        <section className="mb-10">
          <h1 className="mb-2 text-3xl font-bold sm:text-4xl">
            {tCfg(config?.title) || t('download.title')}
          </h1>
          <p className="mb-4 text-lg text-muted-foreground">
            {tCfg(config?.subtitle) || t('download.subtitle', { host: info?.host || '' })}
          </p>
          <p className="max-w-3xl text-muted-foreground">
            {tCfg(config?.intro) || t('download.intro')}
          </p>
        </section>

        <Card className="mb-10">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" />
              <CardTitle>{t('download.configTitle')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {infoQuery.isLoading && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('download.loading')}
              </div>
            )}

            {infoQuery.isError && <p className="text-muted-foreground">{t('download.serverNotReady')}</p>}

            {info && (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/40 p-4">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <KeyIcon className="h-3.5 w-3.5" />
                    {t('download.configCode')}
                  </p>
                  <div className="flex items-start gap-2">
                    <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
                      {info.connect.json}
                    </pre>
                    <Button variant="outline" size="sm" className="shrink-0" onClick={() => copy(info.connect.json)}>
                      <Copy className="me-2 h-4 w-4" />
                      {t('download.copyConfig')}
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{t('download.configCodeHint')}</p>
                </div>

                <dl className="space-y-2 rounded-lg border p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('download.idServer')}</dt>
                    <dd className="font-mono font-semibold" data-testid="info-host">
                      {info.host}
                    </dd>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('download.relayServer')}</dt>
                    <dd className="font-mono font-semibold">{info.relay}</dd>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('download.key')}</dt>
                    <dd className="max-w-full truncate font-mono" title={info.key}>
                      {info.key}
                    </dd>
                  </div>
                </dl>

                {config?.showConnectionDetails && (
                  <>
                    <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed">
                      {prettyRaw}
                    </pre>

                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => copy(info.connect.raw)}>
                        <Copy className="me-2 h-4 w-4" />
                        {t('download.copyJson')}
                      </Button>
                      <Button variant="outline" onClick={() => copy(info.connect.comma)}>
                        <Copy className="me-2 h-4 w-4" />
                        {t('download.copyCli')}
                      </Button>
                    </div>

                    <p className="text-sm text-muted-foreground">{t('download.importHint')}</p>
                  </>
                )}
            </div>
          )}
          </CardContent>
        </Card>

        <section className="mb-10">
          <div className="mb-4 flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-bold">{t('download.platformsTitle')}</h2>
          </div>
          {orderedPlatforms.filter((key) => {
            const platform = config?.platforms?.[key]
            return !platform || platform.enabled
          }).length === 0 ? (
            <p className="text-muted-foreground">{t('download.noPlatforms')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {orderedPlatforms
                .filter((key) => {
                  const platform = config?.platforms?.[key]
                  return !platform || platform.enabled
                })
                .map((key) => {
                  const Icon = PLATFORM_ICONS[key]
                  const platform = config?.platforms?.[key]
                  const instructionsText = tCfg(platform?.instructions)
                  const langButtons = platform?.buttons?.[lang]
                  const buttons = (langButtons && langButtons.length > 0 ? langButtons : platform?.buttons?.en || []).filter(
                    (b) => b.enabled,
                  )
                  const linked = instructions.filter((ins) => ins.target === key)
                  return (
                    <Card key={key} className="flex h-full flex-col">
                      <CardHeader>
                        <div className="flex items-center gap-3">
                          <Icon className="h-6 w-6 text-primary" />
                          <CardTitle className="text-base">{t(`download.platforms.${key}.name`)}</CardTitle>
                        </div>
                      </CardHeader>
                      <CardContent className="flex flex-1 flex-col space-y-3">
                        {buttons.length > 0 ? (
                          <div className="space-y-2">
                            {buttons.map((b, i) => (
                              <Button asChild key={i} variant="outline" className="w-full">
                                <a href={b.url} target="_blank" rel="noreferrer">
                                  {b.name || t('download.downloadNow')}
                                </a>
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <Button asChild variant="outline" className="w-full">
                            <a href={DEFAULT_PLATFORM_LINK} target="_blank" rel="noreferrer">
                              {t('download.downloadNow')}
                            </a>
                          </Button>
                        )}
                        {instructionsText && <p className="text-sm text-muted-foreground">{instructionsText}</p>}
                        {linked.length > 0 && (
                          <div className="mt-auto space-y-2 pt-2">
                            {linked.map((ins) => (
                              <Button
                                key={ins.id}
                                className="w-full"
                                style={instructionColorStyle(ins.color)}
                                onClick={() => openInstruction(ins.id)}
                              >
                                {instructionTitle(ins, instructions.indexOf(ins) + 1)}
                              </Button>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
            </div>
          )}
        </section>

        {instructions.length > 0 && (
          <section className="mb-10">
            <div className="mb-4 flex items-center gap-2">
              <ListOrdered className="h-5 w-5 text-primary" />
              <h2 className="text-xl font-bold">{tCfg(config?.instructionsTitle) || t('download.instructionsTitle')}</h2>
            </div>
            <div className="space-y-3">
              {instructions.map((instruction, index) => (
                <InstructionCard
                  key={instruction.id}
                  instruction={instruction}
                  position={index + 1}
                  open={openId === instruction.id}
                  onToggle={() => setOpenId(openId === instruction.id ? null : instruction.id)}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function InstructionCard({
  instruction,
  position,
  open,
  onToggle,
}: {
  instruction: Instruction
  position: number
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()

  const title = instruction.title || t('download.instructionUntitled', { n: position })

  return (
    <Card id={`instruction-${instruction.id}`} className="scroll-mt-24">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="raw-focus flex w-full select-none items-center justify-between gap-3 px-5 py-4 text-start"
      >
        <span className="flex min-w-0 items-center gap-2">
          <BookOpen className="h-5 w-5 shrink-0 text-primary" />
          <span className="font-medium">{title}</span>
        </span>
        <ChevronDown className={cn('h-5 w-5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <CardContent className="space-y-5 pt-0">
          {instruction.steps.length === 0 && <p className="text-sm text-muted-foreground">{t('download.noSteps')}</p>}
          {instruction.steps.map((step, i) => (
            <StepBlock key={i} step={step} position={i + 1} />
          ))}
        </CardContent>
      )}
    </Card>
  )
}

function StepBlock({ step, position }: { step: InstructionStep; position: number }) {
  const { t } = useTranslation()
  const isDark = useIsDark()
  const text = step.text || ''
  const buttons = (step.buttons || []).filter((b) => b.url)
  const images = isDark ? step.imagesDark || [] : step.imagesLight || []
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
          {position}
        </span>
        <span className="text-sm font-semibold text-muted-foreground">{t('download.stepLabel', { n: position })}</span>
      </div>
      {text && <p className="whitespace-pre-wrap text-sm">{text}</p>}
      {images.length > 0 && <ImageCarousel images={images} />}
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {buttons.map((b, i) => (
            <Button asChild key={i} variant="outline" size="sm">
              <a href={b.url} target="_blank" rel="noreferrer">
                {b.text || t('download.openLink')}
              </a>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function ImageCarousel({ images }: { images: string[] }) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)

  if (images.length === 0) return null

  const prev = () => setIndex((i) => (i - 1 + images.length) % images.length)
  const next = () => setIndex((i) => (i + 1) % images.length)

  return (
    <div className="relative overflow-hidden rounded-lg border bg-muted/40">
      <div className="relative aspect-video w-full">
        <img
          src={images[index]}
          alt=""
          className="h-full w-full object-contain"
          loading="lazy"
          onClick={() => images.length > 1 && next()}
        />
      </div>
      {images.length > 1 && (
        <>
          <button
            type="button"
            aria-label={t('download.prevImage')}
            onClick={prev}
            className="raw-focus absolute inset-y-0 start-0 flex w-10 items-center justify-center bg-gradient-to-r from-black/40 to-transparent text-white transition-opacity hover:opacity-80"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            aria-label={t('download.nextImage')}
            onClick={next}
            className="raw-focus absolute inset-y-0 end-0 flex w-10 items-center justify-center bg-gradient-to-l from-black/40 to-transparent text-white transition-opacity hover:opacity-80"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
          <span className="absolute bottom-2 start-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
            {index + 1} / {images.length}
          </span>
        </>
      )}
    </div>
  )
}