import api from './client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { isFailedRollback } from '../lib/panelStatus'

export { isFailedRollback }

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
  log: () => [...panelKeys.all, 'log'] as const,
  backups: () => [...panelKeys.all, 'backups'] as const,
  preflight: () => [...panelKeys.all, 'preflight'] as const,
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
      // Active runs and stuck errors keep polling so the card follows the
      // runner without a page reload; terminal ok/rolled_back stay quiet.
      if (phase && (PANEL_ACTIVE_PHASES.includes(phase) || phase === 'error')) return 3000
      return false
    },
    refetchOnWindowFocus: true,
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

// Live runner log tail. Polls only while a run is active; otherwise a single
// fetch (stale runs keep their tail visible until reset).
export const usePanelUpdateLog = (active = false) => {
  return useQuery({
    queryKey: panelKeys.log(),
    queryFn: async () => {
      const { data } = await api.get<{ lines: string[] }>('/panel-updates/log?tail=200')
      return data
    },
    refetchInterval: active ? 3000 : false,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

// Clears a stuck update state (frozen phase with no runner). The backend
// refuses with 409 while a runner container exists.
export const useResetPanelUpdate = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ status: string }>('/panel-updates/reset')
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: panelKeys.all })
    },
  })
}

export interface PanelBackup {
  name: string
  size_bytes: number
  created_at: string
}

export interface PanelPreflight {
  tag: string
  asset_url?: string
  asset_reachable: boolean
  asset_bytes: number
  disk_free_bytes: number
  disk_ok: boolean
  runner_free: boolean
}

export const usePanelBackups = (enabled = true) => {
  return useQuery({
    queryKey: panelKeys.backups(),
    queryFn: async () => {
      const { data } = await api.get<{ backups: PanelBackup[] }>('/panel-updates/backups')
      return data
    },
    enabled,
    staleTime: 30000,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

export const useRollbackPanel = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (name: string) => {
      const { data } = await api.post<{ status: string; target: string }>(`/panel-updates/rollback`, { name })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: panelKeys.all })
    },
  })
}

export const useDeleteBackup = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (name: string) => {
      const { data } = await api.delete<{ status: string }>(
        `/panel-updates/backups/${encodeURIComponent(name)}`,
      )
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: panelKeys.backups() })
    },
  })
}

// Manual snapshot of the running tree (pre-vX.Y.Z-manual-<ts>.tar.gz).
// Runs in a throwaway runner; the UI learns the result by re-listing.
export const useCreateBackup = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ status: string; backup: string }>('/panel-updates/backups')
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: panelKeys.backups() })
    },
  })
}

export const usePanelPreflight = (enabled = false) => {
  return useQuery({
    queryKey: panelKeys.preflight(),
    queryFn: async () => {
      const { data } = await api.get<PanelPreflight>('/panel-updates/preflight')
      return data
    },
    enabled,
    staleTime: 60000,
    retry: false,
  })
}