import api from './client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface ServerField {
  value: string
  source: string
}

export interface ServerInfo {
  address: ServerField
  relay_address: ServerField
  api_server: ServerField
  id_port: ServerField
  relay_port: ServerField
  ws_port: ServerField
  public_key: ServerField
}

export const serverInfoKeys = {
  all: ['server-info'] as const,
}

export const useServerInfo = () => {
  return useQuery({
    queryKey: serverInfoKeys.all,
    queryFn: async () => {
      const { data } = await api.get<ServerInfo>('/server-info')
      return data
    },
    staleTime: 60_000,
  })
}

export const useUpdateServerInfo = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { data } = await api.put<Record<string, ServerField>>(`/server-info/${key}`, { value })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serverInfoKeys.all })
    },
  })
}

export interface ConnectCode {
  json: string
  raw: string
  comma: string
  host: string
  key: string
  relay: string
  api: string
  format: string
}

export const useConnectCode = () => {
  return useQuery({
    queryKey: [...serverInfoKeys.all, 'connect-code'] as const,
    queryFn: async () => {
      const { data } = await api.get<ConnectCode>('/server-info/connect-code')
      return data
    },
    staleTime: 60_000,
  })
}