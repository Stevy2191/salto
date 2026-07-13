import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { MeResponse, User } from '../../shared/types.ts'
import { apiGet, apiPost } from '../lib/api.ts'

interface AuthState {
  loading: boolean
  setupNeeded: boolean
  user: User | null
  setup: (username: string, password: string) => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    apiGet<MeResponse>('/api/me')
      .then((me) => {
        setSetupNeeded(me.setupNeeded)
        setUser(me.user)
      })
      .catch(() => {
        // Server unreachable; the login screen will surface errors on submit.
      })
      .finally(() => setLoading(false))
  }, [])

  const setup = useCallback(async (username: string, password: string) => {
    const res = await apiPost<{ user: User }>('/api/setup', { username, password })
    setUser(res.user)
    setSetupNeeded(false)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiPost<{ user: User }>('/api/login', { username, password })
    setUser(res.user)
  }, [])

  const logout = useCallback(async () => {
    await apiPost('/api/logout')
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ loading, setupNeeded, user, setup, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
