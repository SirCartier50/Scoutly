'use client'

import { useCallback, useEffect, useState } from 'react'

/* ------------------------------------------------------------------ types */
// Mirrors server/src/check.ts's UserSettings and server/src/d1.ts's row shapes.
// Kept as a small local copy rather than a shared import - this app only ever
// talks to the Worker over HTTP, so there is no build-time dependency to wire up.

interface StatusResponse {
  watchedCompanies: number
  openPostings: number
  applicationsSent: number
  lastRun: { started_at: string; finished_at: string | null; new_postings: number } | null
  health: { ok: number; stale: number; broken: number }
}

interface CompanyRow {
  id: number
  name: string
  careers_url: string
  ats_type: string
  health: string
  last_checked_at: string | null
  last_yield: number | null
  last_error: string | null
}

type RoleType = 'intern' | 'newgrad' | 'program' | 'other'
type AppStatus = 'none' | 'interested' | 'applied' | 'interviewing' | 'rejected' | 'offer'

interface PostingRow {
  id: number
  companyId: number
  companyName: string
  title: string
  location: string | null
  roleType: RoleType
  applyUrl: string
  postedAt: string | null
  firstSeenAt: string
  appStatus: AppStatus
  appNote: string | null
}

interface Settings {
  locations: string[]
  remoteOk: boolean
  wantIntern: boolean
  wantNewGrad: boolean
  wantProgram: boolean
  functions: string[]
  degreeLevel: 'bachelors' | 'masters' | 'phd' | null
  digestEmail: string | null
  maxPostingAgeDays: number
}

const ROLE_LABEL: Record<RoleType, string> = {
  intern: 'Internship', newgrad: 'New grad', program: 'Program', other: 'Other'
}
const STATUS_OPTIONS: AppStatus[] = ['none', 'interested', 'applied', 'interviewing', 'rejected', 'offer']

async function cw<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/cw${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers }
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

/* --------------------------------------------------------------- component */

export default function Dashboard() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [postings, setPostings] = useState<PostingRow[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [roleFilter, setRoleFilter] = useState<RoleType[]>([])
  const [search, setSearch] = useState('')
  const [newCompanyName, setNewCompanyName] = useState('')
  const [newCompanyUrl, setNewCompanyUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [checkResult, setCheckResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const [s, c, p, st] = await Promise.all([
        cw<StatusResponse>('/status'),
        cw<CompanyRow[]>('/companies'),
        cw<PostingRow[]>(`/postings?${new URLSearchParams({
          ...(roleFilter.length ? { roleTypes: roleFilter.join(',') } : {}),
          ...(search ? { search } : {})
        })}`),
        cw<Settings>('/settings')
      ])
      setStatus(s); setCompanies(c); setPostings(p); setSettings(st); setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [roleFilter, search])

  useEffect(() => {
    // Fetch-on-mount/filter-change against the Worker via the server-side
    // proxy - there's no framework data-fetching layer wired up here, so this
    // is the plain client-component escape hatch the lint rule warns about.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll()
  }, [loadAll])

  const addCompany = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newCompanyName.trim()) return
    setBusy(true)
    try {
      await cw('/companies/add', {
        method: 'POST',
        body: JSON.stringify({ name: newCompanyName.trim(), careersUrl: newCompanyUrl.trim() || undefined })
      })
      setNewCompanyName(''); setNewCompanyUrl('')
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeCompany = async (id: number) => {
    setBusy(true)
    try {
      await cw(`/companies/${id}`, { method: 'DELETE' })
      await loadAll()
    } finally {
      setBusy(false)
    }
  }

  const setPostingStatus = async (id: number, status: AppStatus) => {
    setPostings((prev) => prev.map((p) => (p.id === id ? { ...p, appStatus: status } : p)))
    await cw(`/postings/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) })
  }

  const saveSettings = async () => {
    if (!settings) return
    setBusy(true)
    try {
      await cw('/settings', { method: 'PUT', body: JSON.stringify(settings) })
      await loadAll()
    } finally {
      setBusy(false)
    }
  }

  const runCheck = async () => {
    setBusy(true)
    setCheckResult(null)
    try {
      const res = await cw<{ checked: number; newPostings: number; usersNotified: number }>('/check', { method: 'POST' })
      setCheckResult(`Checked ${res.checked} compan${res.checked === 1 ? 'y' : 'ies'}, ${res.newPostings} new posting(s).`)
      await loadAll()
    } catch (err) {
      setCheckResult(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleRole = (r: RoleType) =>
    setRoleFilter((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      {error && (
        <p className="rounded-md border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-200">{error}</p>
      )}

      {/* -------------------------------------------------------- status */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Watched companies" value={status?.watchedCompanies} />
        <StatCard label="Open postings" value={status?.openPostings} />
        <StatCard label="Applications sent" value={status?.applicationsSent} />
        <StatCard
          label="Health"
          value={status ? `${status.health.ok} ok · ${status.health.stale} stale · ${status.health.broken} broken` : undefined}
        />
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={runCheck}
          disabled={busy}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
        >
          Check now
        </button>
        {checkResult && <span className="text-sm text-neutral-400">{checkResult}</span>}
      </div>

      {/* ----------------------------------------------------- companies */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">Companies</h2>
        <form onSubmit={addCompany} className="mb-4 flex flex-wrap gap-2">
          <input
            value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
            placeholder="Company name"
            className="flex-1 min-w-[160px] rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          <input
            value={newCompanyUrl}
            onChange={(e) => setNewCompanyUrl(e.target.value)}
            placeholder="Careers URL (optional)"
            className="flex-1 min-w-[200px] rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900 disabled:opacity-50"
          >
            Add
          </button>
        </form>
        <ul className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800">
          {companies.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <div
                className="min-w-0 flex-1 truncate"
                title={`${c.name} · ${c.ats_type} · ${c.health}${c.last_error ? ` · ${c.last_error}` : ''}`}
              >
                <span className="font-medium">{c.name}</span>{' '}
                <span className="text-neutral-500">
                  · {c.ats_type} · <HealthDot health={c.health} /> {c.health}
                  {c.last_error ? ` · ${c.last_error}` : ''}
                </span>
              </div>
              <button onClick={() => removeCompany(c.id)} className="shrink-0 text-neutral-500 hover:text-red-400">
                Remove
              </button>
            </li>
          ))}
          {companies.length === 0 && <li className="px-4 py-6 text-center text-sm text-neutral-500">No companies watched yet.</li>}
        </ul>
      </section>

      {/* ------------------------------------------------------ postings */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">Postings</h2>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(['intern', 'newgrad', 'program'] as RoleType[]).map((r) => (
            <button
              key={r}
              onClick={() => toggleRole(r)}
              className={`rounded-full border px-3 py-1 text-xs ${
                roleFilter.includes(r) ? 'border-white bg-white text-neutral-900' : 'border-neutral-700 text-neutral-300'
              }`}
            >
              {ROLE_LABEL[r]}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, company, location…"
            className="ml-auto min-w-[220px] rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm"
          />
        </div>
        <ul className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800">
          {postings.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <a
                  href={p.applyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-medium hover:underline"
                  title={p.title}
                >
                  {p.title}
                </a>
                <div className="truncate text-neutral-500" title={`${p.companyName} · ${ROLE_LABEL[p.roleType]}${p.location ? ` · ${p.location}` : ''}`}>
                  {p.companyName} · {ROLE_LABEL[p.roleType]}
                  {p.location ? ` · ${p.location}` : ''}
                </div>
              </div>
              <select
                value={p.appStatus}
                onChange={(e) => setPostingStatus(p.id, e.target.value as AppStatus)}
                className="shrink-0 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </li>
          ))}
          {postings.length === 0 && <li className="px-4 py-6 text-center text-sm text-neutral-500">No postings match.</li>}
        </ul>
      </section>

      {/* ----------------------------------------------------- settings */}
      {settings && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">Settings</h2>
          <div className="grid gap-4 rounded-md border border-neutral-800 p-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              Locations (comma-separated)
              <input
                value={settings.locations.join(', ')}
                onChange={(e) =>
                  setSettings({ ...settings, locations: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                }
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Digest email override (optional)
              <input
                value={settings.digestEmail ?? ''}
                onChange={(e) => setSettings({ ...settings, digestEmail: e.target.value.trim() || null })}
                placeholder="defaults to your Google account email"
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Max posting age before auto-close (days)
              <input
                type="number"
                min={1}
                value={settings.maxPostingAgeDays}
                onChange={(e) => setSettings({ ...settings, maxPostingAgeDays: Number(e.target.value) })}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Highest degree
              <select
                value={settings.degreeLevel ?? ''}
                onChange={(e) => setSettings({ ...settings, degreeLevel: (e.target.value || null) as Settings['degreeLevel'] })}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
              >
                <option value="">No preference</option>
                <option value="bachelors">Bachelor&apos;s</option>
                <option value="masters">Master&apos;s</option>
                <option value="phd">PhD</option>
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
              {([
                ['wantIntern', 'Internships'],
                ['wantNewGrad', 'New grad'],
                ['wantProgram', 'Programs'],
                ['remoteOk', 'Remote OK']
              ] as [keyof Settings, string][]).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(settings[key])}
                    onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <button
            onClick={saveSettings}
            disabled={busy}
            className="mt-3 rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
          >
            Save settings
          </button>
        </section>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div className="rounded-md border border-neutral-800 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value ?? '—'}</div>
    </div>
  )
}

function HealthDot({ health }: { health: string }) {
  const color = health === 'ok' ? 'bg-green-500' : health === 'stale' ? 'bg-yellow-500' : 'bg-red-500'
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
}
