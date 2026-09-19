import api from './client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export const STATUS_REFRESH_INTERVAL_KEY = 'device_status_refresh_interval'
export const DEFAULT_STATUS_REFRESH_INTERVAL = 30
export const MIN_STATUS_REFRESH_INTERVAL = 10
export const MAX_STATUS_REFRESH_INTERVAL = 300

export const STATUS_UPDATE_MODE_KEY = 'status_update_mode'
export const STATUS_UPDATE_MODE_PUSH = 'push'
export const STATUS_UPDATE_MODE_POLL = 'poll'
export const DEFAULT_STATUS_UPDATE_MODE = STATUS_UPDATE_MODE_PUSH
export type StatusUpdateMode = typeof STATUS_UPDATE_MODE_PUSH | typeof STATUS_UPDATE_MODE_POLL

export const ACCESS_TOKEN_TTL_KEY = 'auth_access_token_ttl_minutes'
export const DEFAULT_ACCESS_TOKEN_TTL = 60
export const MIN_ACCESS_TOKEN_TTL = 5
export const MAX_ACCESS_TOKEN_TTL = 10080

export const REFRESH_TOKEN_TTL_KEY = 'auth_refresh_token_ttl_days'
export const DEFAULT_REFRESH_TOKEN_TTL = 7
export const MIN_REFRESH_TOKEN_TTL = 1
export const MAX_REFRESH_TOKEN_TTL = 365

// Web client connection defaults (admin panel -> browser sessions).
export const WEB_CLIENT_QUALITY_KEY = 'web_client_quality'
export const DEFAULT_WEB_CLIENT_QUALITY = 3
export const WEB_CLIENT_FPS_KEY = 'web_client_fps'
export const DEFAULT_WEB_CLIENT_FPS = 30
export const MIN_WEB_CLIENT_FPS = 1
export const MAX_WEB_CLIENT_FPS = 240
export const WEB_CLIENT_CODEC_KEY = 'web_client_codec'
export const DEFAULT_WEB_CLIENT_CODEC = 'auto'
export const WEB_CLIENT_CODECS = ['auto', 'vp8', 'vp9', 'av1'] as const
export type WebClientCodec = (typeof WEB_CLIENT_CODECS)[number]
export const WEB_CLIENT_CHAT_GREETING_KEY = 'web_client_chat_greeting'
export const WEB_CLIENT_CHAT_GREETING_ENABLED_KEY = 'web_client_chat_greeting_enabled'
export const WEB_CLIENT_CHAT_CLOSE_KEY = 'web_client_chat_close'
export const WEB_CLIENT_CHAT_CLOSE_ENABLED_KEY = 'web_client_chat_close_enabled'
export const DEFAULT_WEB_CLIENT_CHAT_GREETING = 'Hello! How can I help you?'
export const DEFAULT_WEB_CLIENT_CHAT_CLOSE = 'The operator has closed the chat.'
export const MAX_WEB_CLIENT_CHAT_TEXT = 2000
export const WEB_CLIENT_RENDER_SCALE_KEY = 'web_client_render_scale'
export const DEFAULT_WEB_CLIENT_RENDER_SCALE = 'auto'
export const WEB_CLIENT_RENDER_SCALES = ['auto', 'original', '144p', '240p', '360p', '480p', '720p', '1080p', '1440p'] as const
export type WebClientRenderScale = (typeof WEB_CLIENT_RENDER_SCALES)[number]
export const WEB_CLIENT_CURSOR_KEY = 'web_client_cursor'
export const DEFAULT_WEB_CLIENT_CURSOR = false
export const WEB_CLIENT_INPUT_MODE_KEY = 'web_client_input_mode'
export const DEFAULT_WEB_CLIENT_INPUT_MODE = 'auto'
export const WEB_CLIENT_INPUT_MODES = ['auto', 'touch', 'pointer'] as const
export type WebClientInputMode = (typeof WEB_CLIENT_INPUT_MODES)[number]
export const WEB_CLIENT_NAME_KEY = 'web_client_name'
export const DEFAULT_WEB_CLIENT_NAME = 'Web Browser'
export const MAX_WEB_CLIENT_NAME = 64

export interface Settings {
  [STATUS_REFRESH_INTERVAL_KEY]: number
  [STATUS_UPDATE_MODE_KEY]: StatusUpdateMode
  [ACCESS_TOKEN_TTL_KEY]: number
  [REFRESH_TOKEN_TTL_KEY]: number
  [WEB_CLIENT_QUALITY_KEY]: number
  [WEB_CLIENT_FPS_KEY]: number
  [WEB_CLIENT_CODEC_KEY]: WebClientCodec
  [WEB_CLIENT_CHAT_GREETING_KEY]: string
  [WEB_CLIENT_CHAT_GREETING_ENABLED_KEY]: boolean
  [WEB_CLIENT_CHAT_CLOSE_KEY]: string
  [WEB_CLIENT_CHAT_CLOSE_ENABLED_KEY]: boolean
  [WEB_CLIENT_RENDER_SCALE_KEY]: WebClientRenderScale
  [WEB_CLIENT_CURSOR_KEY]: boolean
  [WEB_CLIENT_INPUT_MODE_KEY]: WebClientInputMode
  [WEB_CLIENT_NAME_KEY]: string
}

export const settingsKeys = {
  all: ['settings'] as const,
  list: () => [...settingsKeys.all, 'list'] as const,
}

export const useSettings = () => {
  return useQuery({
    queryKey: settingsKeys.list(),
    queryFn: async () => {
      const { data } = await api.get<Settings>('/settings')
      return data
    },
    staleTime: 30000,
  })
}

export const useUpdateSetting = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { data } = await api.put<Settings>(`/settings/${key}`, { value })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.all })
    },
  })
}