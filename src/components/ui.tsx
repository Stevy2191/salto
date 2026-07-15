import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

const buttonStyles = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 disabled:bg-slate-300 dark:disabled:bg-slate-600 dark:disabled:text-slate-400',
  secondary:
    'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 active:bg-slate-100 disabled:text-slate-400 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-600 dark:active:bg-slate-500 dark:disabled:text-slate-500',
  danger:
    'bg-white text-red-600 ring-1 ring-red-200 hover:bg-red-50 active:bg-red-100 dark:bg-slate-700 dark:text-red-400 dark:ring-red-900 dark:hover:bg-red-950 dark:active:bg-red-900',
} as const

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonStyles }) {
  return (
    <button
      className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${buttonStyles[variant]} ${className}`}
      {...props}
    />
  )
}

export function TextInput({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:placeholder:text-slate-400 ${className}`}
      {...props}
    />
  )
}

export function Select({
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 ${className}`}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  /** Optional note under the control, e.g. a date read back in words. */
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  )
}

/**
 * Like Field, but for groups of controls (chip pickers, editors) — a
 * <label> wrapper would steal their accessible names and forward label
 * clicks to the first button.
 */
export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
      </span>
      {children}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700 ${className}`}
    >
      {children}
    </div>
  )
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{title}</h1>
      {children}
    </div>
  )
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p
      className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
    >
      {message}
    </p>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">{children}</p>
}

/** Toggleable set of checkboxes rendered as tap-friendly chips. */
export function ChipPicker({
  options,
  selected,
  onChange,
  tone = 'indigo',
}: {
  options: { id: number; label: string }[]
  selected: number[]
  onChange: (ids: number[]) => void
  /** amber reads as "marked out" (day-of changes) rather than "included". */
  tone?: 'indigo' | 'amber'
}) {
  const activeClass =
    tone === 'amber' ? 'bg-amber-500 text-white' : 'bg-indigo-600 text-white'
  return (
    <div className="flex flex-wrap gap-2">
      {options.length === 0 && (
        <span className="text-sm text-slate-400 dark:text-slate-500">none available yet</span>
      )}
      {options.map((opt) => {
        const active = selected.includes(opt.id)
        return (
          <button
            type="button"
            key={opt.id}
            aria-pressed={active}
            onClick={() =>
              onChange(active ? selected.filter((id) => id !== opt.id) : [...selected, opt.id])
            }
            className={`min-h-10 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? activeClass
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'
            }`}
          >
            {tone === 'amber' && active ? '⚠ ' : ''}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
