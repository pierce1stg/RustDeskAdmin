import api from './client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export type UpdateComponent = 'hbbs' | 'hbbr'

export interface CheckedComponent {
  component: UpdateComponent
  current: string
  latest: string
  update_available: boolean
  unknown?: boolean
}

export interface UpdatesCheck {
  checked_at: string
  source: string
  components: CheckedComponent[]
}

export const updatesKeys = {
  all: ['updates'] as const,
  list: () => [...updatesKeys.all, 'list'] as const,
}

export const useServerUpdates = (enabled = true) => {
  return useQuery({
    queryKey: updatesKeys.list(),
    queryFn: async () => {
      const { data } = await api.get<UpdatesCheck>('/updates')
      return data
    },
    enabled,
    staleTime: 60_000,
  })
}

export const useApplyUpdate = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (component: UpdateComponent) => {
      const { data } = await api.post('/updates/apply', { component })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server-status'] })
    },
  })
}