import type { JSX, ReactNode } from 'react'

/** Shared Material 3 Expressive primitives used across the tabs. */

export function Card({
  title,
  action,
  children,
  className = ''
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={`glass rounded-card p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-center gap-3">
          {title && <h2 className="flex-1 text-sm font-medium text-on-surface-variant">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Button({
  children,
  onClick,
  variant = 'filled',
  disabled,
  className = ''
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'filled' | 'tonal' | 'text' | 'danger'
  disabled?: boolean
  className?: string
}): JSX.Element {
  const styles = {
    filled: 'bg-primary text-on-primary hover:brightness-110',
    tonal: 'bg-primary-container text-on-primary-container hover:brightness-105',
    text: 'text-primary hover:bg-surface-container-high',
    danger: 'bg-surface-container-high text-danger hover:brightness-105'
  }[variant]

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-pill px-4 py-2 text-sm font-medium transition-all active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

export function Chip({
  children,
  selected,
  onClick
}: {
  children: ReactNode
  selected?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`rounded-pill border px-3 py-1 text-xs font-medium transition-all active:scale-95 ${
        selected
          ? 'border-transparent bg-primary text-on-primary'
          : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {children}
    </button>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  onEnter
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  onEnter?: () => void
}): JSX.Element {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-xs text-on-surface-variant">{label}</span>}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter()
        }}
        className="w-full rounded-panel border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/60 focus:border-primary"
      />
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}): JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-panel px-1 py-2 text-left transition-colors hover:bg-surface-container-high"
    >
      <span
        className={`relative h-6 w-11 shrink-0 rounded-pill transition-colors ${
          checked ? 'bg-primary' : 'bg-outline-variant'
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-pill bg-surface transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </span>
      <span className="text-sm">{label}</span>
    </button>
  )
}

const HEALTH_STYLE: Record<string, string> = {
  ok: 'bg-positive/15 text-positive',
  stale: 'bg-warning/15 text-warning',
  broken: 'bg-danger/15 text-danger'
}

export function HealthDot({ health }: { health: string }): JSX.Element {
  return (
    <span className={`rounded-pill px-2 py-0.5 text-[11px] font-medium ${HEALTH_STYLE[health] ?? ''}`}>
      {health}
    </span>
  )
}

const ROLE_STYLE: Record<string, string> = {
  intern: 'bg-primary/15 text-primary',
  program: 'bg-tertiary/20 text-tertiary',
  newgrad: 'bg-secondary/20 text-secondary',
  other: 'bg-surface-container-high text-on-surface-variant'
}

const ROLE_LABEL: Record<string, string> = {
  intern: 'Internship',
  program: 'Program',
  newgrad: 'New Grad',
  other: 'Role'
}

export function RoleBadge({ role }: { role: string }): JSX.Element {
  return (
    <span className={`rounded-pill px-2 py-0.5 text-[11px] font-medium ${ROLE_STYLE[role] ?? ''}`}>
      {ROLE_LABEL[role] ?? role}
    </span>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-sm font-medium text-on-surface">{title}</p>
      {hint && <p className="max-w-md text-xs text-on-surface-variant">{hint}</p>}
    </div>
  )
}

/**
 * Custom career pages rarely expose a trustworthy post date, so the UI says
 * "detected" for those rather than inventing one.
 */
export function relativeTime(iso: string | null, prefix = ''): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return `${prefix}just now`
  if (mins < 60) return `${prefix}${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${prefix}${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${prefix}${days}d ago`
  return `${prefix}${Math.floor(days / 30)}mo ago`
}

export function postedLabel(postedAt: string | null, firstSeenAt: string): string {
  return postedAt ? relativeTime(postedAt, 'posted ') : relativeTime(firstSeenAt, 'detected ')
}
