import api from './client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export type DownloadLang = 'en' | 'ru' | 'zh' | 'ar'

export interface LangStrings {
  en: string
  ru: string
  zh: string
  ar: string
}

export type PlatformKey = 'windows' | 'macos' | 'linux' | 'android' | 'ios'

export interface DownloadButton {
  name: string
  url: string
  enabled: boolean
}

export interface PlatformPageConfig {
  enabled: boolean
  instructions: LangStrings
  buttons: Partial<Record<DownloadLang, DownloadButton[]>>
  order?: number
}

export interface ScreenshotEntry {
  id: string
  url: string
}

export interface StepButton {
  text: string
  url: string
}

export interface InstructionStep {
  text: string
  imagesLight: string[]
  imagesDark: string[]
  buttons: StepButton[]
}

export interface Instruction {
  id: string
  target: string
  color: string
  title: string
  steps: InstructionStep[]
}

export interface DownloadPageConfig {
  title: LangStrings
  subtitle: LangStrings
  intro: LangStrings
  instructionsTitle: LangStrings
  platforms: Record<PlatformKey, PlatformPageConfig>
  screenshots: ScreenshotEntry[]
  instructions: Partial<Record<DownloadLang, Instruction[]>>
  localized: boolean
  lang: string
  showConnectionDetails: boolean
}

export interface PublicClientInfo {
  host: string
  relay: string
  key: string
  api: string
  id_port: string
  relay_port: string
  ws_port: string
  connect: {
    json: string
    raw: string
    comma: string
    host: string
    key: string
    relay: string
    api: string
    format: string
  }
}

export const downloadPageKeys = {
  admin: ['download-config'] as const,
  public: ['client-download'] as const,
}

const publicClientInfoKeys = ['client-info'] as const

export const usePublicClientInfo = () => {
  return useQuery({
    queryKey: publicClientInfoKeys,
    queryFn: async () => {
      const { data } = await api.get<PublicClientInfo>('/client/info')
      return data
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export const usePublicDownloadConfig = () => {
  return useQuery({
    queryKey: downloadPageKeys.public,
    queryFn: async () => {
      const { data } = await api.get<DownloadPageConfig>('/client/download')
      return data
    },
    staleTime: 5 * 60_000,
  })
}

export const useDownloadPageConfig = () => {
  return useQuery({
    queryKey: downloadPageKeys.admin,
    queryFn: async () => {
      const { data } = await api.get<DownloadPageConfig>('/download-config')
      return data
    },
    staleTime: 30_000,
  })
}

export const useSaveDownloadPageConfig = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (cfg: DownloadPageConfig) => {
      const { data } = await api.put<DownloadPageConfig>('/download-config', cfg)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: downloadPageKeys.admin })
      queryClient.invalidateQueries({ queryKey: downloadPageKeys.public })
    },
  })
}

export const useUploadScreenshot = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      const { data } = await api.post<ScreenshotEntry>('/download-config/screenshots', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: downloadPageKeys.admin })
      queryClient.invalidateQueries({ queryKey: downloadPageKeys.public })
    },
  })
}

export const useDeleteScreenshot = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (file: string) => {
      const { data } = await api.delete(`/download-config/screenshots/${encodeURIComponent(file)}`)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: downloadPageKeys.admin })
      queryClient.invalidateQueries({ queryKey: downloadPageKeys.public })
    },
  })
}