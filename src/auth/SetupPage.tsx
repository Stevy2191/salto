import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext.tsx'
import { Button, ErrorNote, Field, TextInput } from '../components/ui.tsx'

export function SetupPage() {
  const { user, setupNeeded, loading, setup } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return null
  if (!setupNeeded) return <Navigate to={user ? '/' : '/login'} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError('passwords do not match')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await setup(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'setup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl bg-white p-6 shadow">
        <h1 className="text-2xl font-bold text-slate-900">Welcome to Salto</h1>
        <p className="text-sm text-slate-600">
          Create the admin account for your gym. You'll use it to sign in from now on.
        </p>
        <ErrorNote message={error} />
        <Field label="Username">
          <TextInput
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label="Password (at least 8 characters)">
          <TextInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
        <Field label="Confirm password">
          <TextInput
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Creating…' : 'Create admin account'}
        </Button>
      </form>
    </main>
  )
}
