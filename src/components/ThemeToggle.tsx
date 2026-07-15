import { useState } from 'react'
import { applyTheme, currentTheme } from '../lib/theme.ts'
import type { Theme } from '../lib/theme.ts'

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4.25" />
      <path d="M12 2.5v2.25M12 19.25v2.25M4.72 4.72l1.6 1.6M17.68 17.68l1.6 1.6M2.5 12h2.25M19.25 12h2.25M4.72 19.28l1.6-1.6M17.68 6.32l1.6-1.6" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="currentColor">
      <path d="M21.75 15.91A9.75 9.75 0 1 1 8.09 2.25a.75.75 0 0 1 .98.98 8.25 8.25 0 0 0 11.7 11.7.75.75 0 0 1 .98.98Z" />
    </svg>
  )
}

/**
 * Light/dark switch. The icon shows the mode you are in — sun for light,
 * half moon for dark — while the label says what a click will do.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme())
  const next: Theme = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      onClick={() => {
        applyTheme(next)
        setTheme(next)
      }}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="min-h-11 rounded-lg px-3 py-2.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
    >
      {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  )
}
