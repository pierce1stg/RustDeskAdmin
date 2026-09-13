import axios from 'axios'
import { useAuthStore } from '@/stores/auth'
import type { TokenResponse } from './auth'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Single in-flight refresh. When the access token expires, several requests
// hit 401 at once (dashboard polls, device lists, ...). Instead of each one
// rotating the same refresh token — which makes every subsequent refresh fail
// and log the admin out — they all wait on one shared refresh and reuse its
// result.
let refreshPromise: Promise<TokenResponse> | null = null

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      const refreshToken = useAuthStore.getState().refreshToken
      if (!refreshToken) {
        useAuthStore.getState().logout()
        window.location.href = '/login'
        return Promise.reject(error)
      }

      try {
        if (!refreshPromise) {
          refreshPromise = axios
            .post<TokenResponse>(`${import.meta.env.VITE_API_URL || '/api'}/auth/refresh`, {
              refresh_token: refreshToken,
            })
            .then(({ data }) => {
              useAuthStore.getState().setTokens(data.access_token, data.refresh_token)
              return data
            })
            .finally(() => {
              refreshPromise = null
            })
        }

        const tokens = await refreshPromise
        originalRequest.headers.Authorization = `Bearer ${tokens.access_token}`
        return api(originalRequest)
      } catch (refreshError) {
        useAuthStore.getState().logout()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

export default api

// Best-effort human-readable message for an error raised by an api call:
// the backend "error" field when present, otherwise the HTTP error message.
export function apiErrorText(error: unknown, fallback?: string): string | undefined {
  if (axios.isAxiosError<{ error?: string }>(error)) {
    return error.response?.data?.error || error.message || fallback
  }
  if (error instanceof Error) {
    return error.message || fallback
  }
  return fallback
}