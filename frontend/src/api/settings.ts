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

export interface Settings {
  [STATUS_REFRESH_INTERVAL_KEY]: number
  [STATUS_UPDATE_MODE_KEY]: StatusUpdateMode
  [ACCESS_TOKEN_TTL_KEY]: number
  [REFRESH_TOKEN_TTL_KEY]: number
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