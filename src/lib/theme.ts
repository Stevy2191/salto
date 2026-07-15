// Light/dark theme, stored as an explicit user choice and falling back to
// the OS setting. The `dark` class on <html> drives Tailwind's dark:
// variant (see src/index.css).
//
// The no-flash inline script in index.html mirrors this logic — keep the
// two in sync.

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'salto-theme'

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** The saved choice, or null when the user has never picked one. */
export function savedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === 'light' || saved === 'dark' ? saved : null
  } catch {
    // Private browsing / storage disabled — fall back to the OS setting.
    return null
  }
}

export function currentTheme(): Theme {
  return savedTheme() ?? (systemPrefersDark() ? 'dark' : 'light')
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  // Lets the browser theme native UI too: scrollbars, and the date/time
  // pickers the session form relies on.
  document.documentElement.style.colorScheme = theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Not persisting is survivable; the theme still applies this session.
  }
}
