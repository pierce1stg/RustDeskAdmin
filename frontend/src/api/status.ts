import api from './client'
import { useQuery } from '@tanstack/react-query'

export interface ServerStatusConn {
  ip: string
  port?: number
  peer_id?: string
  alias?: string
  stale?: boolean
}

export interface ServerStatus {
  hbbs_listening: boolean
  hbbr_listening: boolean
  relay_active: boolean
  relay_clients: string[]
  hbbs_clients: string[]
  hbbs_version?: string
  hbbr_version?: string
  hbbs_devices?: number
  hbbr_devices?: number
  hbbs_conns?: ServerStatusConn[]
  hbbr_conns?: ServerStatusConn[]
  updated_at: string
}

export const useServerStatus = () => {
  return useQuery({
    queryKey: ['server-status'],
    queryFn: async () => {
      const { data } = await api.get<ServerStatus>('/status')
      return data
    },
    refetchInterval: 15000,
  })
}