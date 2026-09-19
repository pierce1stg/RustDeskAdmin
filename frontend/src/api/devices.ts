import api from './client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { useAuthStore } from '@/stores/auth'

export interface Device {
  id: string
  peer_id: string
  alias: string | null
  pinned: boolean
  deleted_at: string | null
  last_seen: string | null
  online: boolean
  password_saved: boolean
  created_at: string
  updated_at: string
  // Last-known PeerInfo snapshot (NULL until the first panel connect).
  hostname: string | null
  username: string | null
  platform: string | null
  host_version: string | null
  displays: string | null // JSON: [{name,x,y,width,height}, ...]
  peerinfo_updated_at: string | null
}

export interface ListDevicesParams {
  page?: number
  limit?: number
  search?: string
  pinned?: boolean
  online?: boolean
}

export interface ListDevicesResponse {
  items: Device[]
  total: number
  page: number
  limit: number
}

export interface UpdateDeviceRequest {
  alias?: string
  pinned?: boolean
}

export const deviceKeys = {
  all: ['devices'] as const,
  lists: () => [...deviceKeys.all, 'list'] as const,
  list: (params: ListDevicesParams) => [...deviceKeys.lists(), params] as const,
}

export const useDevices = (params: ListDevicesParams = {}, options?: { refetchInterval?: number }) => {
  return useQuery({
    queryKey: deviceKeys.list(params),
    queryFn: async () => {
      const { data } = await api.get<ListDevicesResponse>('/devices', { params })
      return data
    },
    placeholderData: (previousData) => previousData,
    refetchInterval: options?.refetchInterval ?? 15000,
  })
}

export const useUpdateDevice = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateDeviceRequest }) => {
      const { data: response } = await api.patch<Device>(`/devices/${id}`, data)
      return response
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all })
    },
  })
}

export const useDeleteDevice = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/devices/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all })
    },
  })
}

// ---------- saved passwords ----------

export const useSaveDevicePassword = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      await api.put(`/devices/${id}/password`, { password })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all })
    },
  })
}

export const useDeleteDevicePassword = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/devices/${id}/password`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all })
    },
  })
}

/** Fetch the saved password for a user-facing (decimal) peer id, or null. */
export async function fetchSavedPeerPassword(peerId: string): Promise<string | null> {
  try {
    const { data } = await api.get<{ password: string }>(`/devices/peer/${encodeURIComponent(peerId)}/password`)
    return data.password || null
  } catch {
    return null
  }
}

/** Save (or replace) the remembered password for a peer id. */
export async function savePeerPassword(peerId: string, password: string): Promise<boolean> {
  try {
    await api.put(`/devices/peer/${encodeURIComponent(peerId)}/password`, { password })
    return true
  } catch {
    return false
  }
}

export type { PeerInfoDisplay, PeerInfoSnapshot } from '@/lib/rustdesk/peerinfo'
import type { PeerInfoSnapshot } from '@/lib/rustdesk/peerinfo'
export { formatDisplays, describeDisplays } from '@/lib/rustdesk/peerinfo'

/** Store the last-known PeerInfo snapshot for a peer id. Best-effort. */
export async function savePeerInfoSnapshot(peerId: string, snap: PeerInfoSnapshot): Promise<boolean> {
  try {
    await api.patch(`/devices/peer/${encodeURIComponent(peerId)}/peerinfo`, snap)
    return true
  } catch {
    return false
  }
}

export interface OnlineStatusSnapshot {
  ts: string
  online: string[]
  online_count: number
}

function hexToPeerId(hex: string): string {
  let out = ''
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
  }
  return out
}

export interface OnlineStatusStream {
  online: Set<string>
  onlineCount: number | null
  streamActive: boolean
}

/**
 * The status stream is a module-level singleton: multiple mounted consumers
 * (Dashboard, Devices) share a single fetch connection instead of opening one
 * SSE stream per subscriber. Consumers subscribe through useSyncExternalStore.
 */

let streamSnapshot: OnlineStatusStream = { online: new Set(), onlineCount: null, streamActive: false }
const streamListeners = new Set<() => void>()

function setStreamSnapshot(next: OnlineStatusStream) {
  streamSnapshot = next
  for (const listener of streamListeners) listener()
}

function subscribeStream(listener: () => void) {
  streamListeners.add(listener)
  return () => {
    streamListeners.delete(listener)
  }
}

function getStreamSnapshot() {
  return streamSnapshot
}

let streamWanted = 0
let streamConnected = false
let streamController: AbortController | null = null
let streamRetryTimer: ReturnType<typeof setTimeout> | null = null
let streamRetries = 0

function startStream() {
  if (streamConnected) return
  streamConnected = true
  streamRetries = 0
  connectStream()
}

function stopStream() {
  streamConnected = false
  if (streamController) streamController.abort()
  if (streamRetryTimer) clearTimeout(streamRetryTimer)
  streamController = null
  streamRetryTimer = null
  setStreamSnapshot({ online: new Set(), onlineCount: null, streamActive: false })
}

/**
 * Consumes the SSE status stream (GET /api/devices/stream) with a fetch-based
 * reader so the Authorization header is sent from the store (EventSource cannot
 * set headers). Auto-reconnects with backoff. Runs while at least one consumer
 * has `enabled` set, i.e. when the status update mode is "push".
 */
async function connectStream() {
  if (!streamConnected) return
  streamController = new AbortController()
  const base = import.meta.env.VITE_API_URL || '/api'
  const token = useAuthStore.getState().accessToken
  try {
    const res = await fetch(`${base}/devices/stream`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: streamController.signal,
    })
    if (!res.ok || !res.body) throw new Error('stream failed')
    streamRetries = 0
    setStreamSnapshot({ ...streamSnapshot, streamActive: true })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let newline = buf.indexOf('\n')
      while (newline >= 0) {
        const line = buf.slice(0, newline).trim()
        buf = buf.slice(newline + 1)
        if (line.startsWith('data:')) {
          try {
            const ev = JSON.parse(line.slice(5).trim()) as OnlineStatusSnapshot
            setStreamSnapshot({
              online: new Set((ev.online ?? []).map(hexToPeerId)),
              onlineCount: ev.online_count ?? (ev.online ?? []).length,
              streamActive: true,
            })
          } catch {
            // ignore malformed frames
          }
        }
        newline = buf.indexOf('\n')
      }
    }
  } catch {
    // stream closed / network error -> backoff and reconnect
  } finally {
    if (streamConnected) {
      setStreamSnapshot({ ...streamSnapshot, streamActive: false })
      if (streamRetryTimer) clearTimeout(streamRetryTimer)
      streamRetryTimer = setTimeout(connectStream, Math.min(1000 * 2 ** streamRetries, 15000))
      streamRetries += 1
    }
  }
}

export function useDeviceOnlineStream(enabled: boolean): OnlineStatusStream {
  useEffect(() => {
    if (!enabled) return
    streamWanted += 1
    startStream()
    return () => {
      streamWanted -= 1
      if (streamWanted <= 0) stopStream()
    }
  }, [enabled])

  return useSyncExternalStore(subscribeStream, getStreamSnapshot)
}