import api from './client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface PanelCheck {
  checked_at: string
  source: string
  current: string
  latest?: string
  update_available: boolean
  enabled: boolean
  asset_url?: string
}

export interface PanelStatus {
  phase: string
  current?: string
  latest?: string
  started_at?: string
  finished_at?: string
  error?: string
}

export const panelKeys = {
  all: ['panel'] as const,
  version: () => [...panelKeys.all, 'version'] as const,
  check: () => [...panelKeys.all, 'check'] as const,
  status: () => [...panelKeys.all, 'status'] as const,
}

// Phases reported by the update runner while work is in progress.
export const PANEL_ACTIVE_PHASES = ['verifying', 'backup', 'extracting', 'building', 'health', 'rollback']

export const usePanelVersion = () => {
  return useQuery({
    queryKey: panelKeys.version(),
    queryFn: async () => {
      const { data } = await api.get<{ version: string }>('/panel/version')
      return data
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export const usePanelUpdateCheck = (enabled = true) => {
  return useQuery({
    queryKey: panelKeys.check(),
    queryFn: async () => {
      const { data } = await api.get<PanelCheck>('/panel-updates/check')
      return data
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

export const usePanelUpdateStatus = (forcePoll = false) => {
  return useQuery({
    queryKey: panelKeys.status(),
    queryFn: async () => {
      const { data } = await api.get<PanelStatus>('/panel-updates/status')
      return data
    },
    refetchInterval: (query) => {
      if (forcePoll) return 3000
      const phase = query.state.data?.phase
      return phase && PANEL_ACTIVE_PHASES.includes(phase) ? 3000 : false
    },
    retry: false,
  })
}

export const useApplyPanelUpdate = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ status: string; target: string }>('/panel-updates/apply')
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: panelKeys.all })
    },
  })
}