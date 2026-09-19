import api from './client'
import { useMutation } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth'

export interface LoginRequest {
  username: string
  password: string
}

export interface ChangeCredentialsRequest {
  current_password: string
  new_username?: string
  new_password?: string
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
}

export const useLogin = () => {
  const setTokens = useAuthStore((state) => state.setTokens)

  return useMutation({
    mutationFn: async (data: LoginRequest) => {
      const { data: response } = await api.post<TokenResponse>('/auth/login', data)
      return response
    },
    onSuccess: (data) => {
      setTokens(data.access_token, data.refresh_token)
    },
  })
}

export const useChangeCredentials = () => {
  return useMutation({
    mutationFn: async (data: ChangeCredentialsRequest) => {
      const { data: response } = await api.put<{ message: string }>('/auth/password', data)
      return response
    },
  })
}

// Best-effort server-side session revoke. Clearing local tokens always
// happens; a failed revoke never blocks signing out.
export async function logoutRemote(): Promise<void> {
  const refreshToken = useAuthStore.getState().refreshToken
  try {
    if (refreshToken) {
      await api.post('/auth/logout', { refresh_token: refreshToken })
    }
  } catch {
    // ignore — local logout below is what matters
  } finally {
    useAuthStore.getState().logout()
  }
}