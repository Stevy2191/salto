import { NavLink, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'

const links = [
  { to: '/', label: 'Home' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/events', label: 'Events' },
  { to: '/programs', label: 'Programs' },
  { to: '/classes', label: 'Classes' },
  { to: '/coaches', label: 'Coaches' },
]

export function Layout() {
  const { user, setupNeeded, loading, logout } = useAuth()

  if (loading) return null
  if (setupNeeded) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace />

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-900">
      <header className="bg-white shadow-sm dark:bg-slate-800 print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <span className="py-2 text-lg font-extrabold tracking-tight text-indigo-600 dark:text-indigo-400">
            Salto
          </span>
          <nav className="flex flex-1 flex-wrap gap-1">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === '/'}
                className={({ isActive }) =>
                  `min-h-11 rounded-lg px-3 py-2.5 text-sm font-medium ${
                    isActive
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <ThemeToggle />
          <button
            onClick={() => void logout()}
            className="min-h-11 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4">
        <Outlet />
      </main>
    </div>
  )
}
