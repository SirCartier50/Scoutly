'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

/* ------------------------------------------------------------------ types */
// Mirrors server/src/check.ts's UserSettings and server/src/d1.ts's row shapes.
// Kept as a small local copy rather than a shared import - this app only ever
// talks to the Worker over HTTP, so there is no build-time dependency to wire up.
//
// Layout mirrors the desktop app's tabs (src/renderer/src/tabs.tsx) so the two
// clients offer the same things. Both are thin clients over the same Worker
// routes; nothing here needs a server change.

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
  description: string | null
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
  // Optional: a Worker that predates keyword filtering doesn't return them.
  includeKeywords?: string[]
  excludeKeywords?: string[]
}

const ROLE_LABEL: Record<RoleType, string> = {
  intern: 'Internship', newgrad: 'New grad', program: 'Program', other: 'Other'
}
const APP_STATUSES: [AppStatus, string][] = [
  ['none', 'None'], ['interested', 'Saved'], ['applied', 'Applied'],
  ['interviewing', 'Interviewing'], ['rejected', 'Rejected'], ['offer', 'Offer']
]

// Ids match src/core/classify.ts's JobFunction. `engineering` is software
// engineering specifically - non-software disciplines are `hardware`.
const FUNCTION_OPTIONS: [string, string][] = [
  ['engineering', 'Software engineering'],
  ['data', 'Data / ML'],
  ['hardware', 'Hardware & other engineering'],
  ['product', 'Product'],
  ['design', 'Design'],
  ['business', 'Business & ops']
]

const TABS = ['Overview', 'Postings', 'Programs', 'Companies', 'Settings'] as const
type Tab = (typeof TABS)[number]

async function cw<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/cw${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers }
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

/** localStorage throws in some contexts (blocked site data, previews) - never let that break the page. */
const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value) } catch { /* per-browser convenience only */ }
  }
}

/** Same rule as the desktop app: a real posted date if the feed has one, never a fabricated one. */
function postedLabel(postedAt: string | null, firstSeenAt: string): string {
  const days = (iso: string): number => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
  if (postedAt) {
    const d = days(postedAt)
    return d === 0 ? 'posted today' : `posted ${d}d ago`
  }
  const d = days(firstSeenAt)
  return d === 0 ? 'detected today' : `detected ${d}d ago`
}

/* --------------------------------------------------------------- component */

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>('Overview')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const saved = store.get('cw.tab') as Tab | null
    // Restoring a remembered tab after hydration, not during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && (TABS as readonly string[]).includes(saved)) setTab(saved)
  }, [])

  const goto = (t: Tab) => {
    setTab(t)
    store.set('cw.tab', t)
  }

  const loadShared = useCallback(async () => {
    try {
      const [s, c, st] = await Promise.all([
        cw<StatusResponse>('/status'),
        cw<CompanyRow[]>('/companies'),
        cw<Settings>('/settings')
      ])
      setStatus(s); setCompanies(c); setSettings(st); setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadShared()
  }, [loadShared])

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <nav className="flex gap-1 overflow-x-auto rounded-full border border-neutral-800 p-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => goto(t)}
            className={`flex-1 whitespace-nowrap rounded-full px-4 py-1.5 text-sm ${
              tab === t ? 'bg-white font-medium text-neutral-900' : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {error && (
        <p className="rounded-md border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-200">{error}</p>
      )}

      {tab === 'Overview' && <OverviewTab status={status} onGoto={goto} />}
      {tab === 'Postings' && <PostingsTab companies={companies} />}
      {tab === 'Programs' && <ProgramsTab />}
      {tab === 'Companies' && <CompaniesTab companies={companies} />}
      {tab === 'Settings' && settings && (
        <SettingsTab settings={settings} setSettings={setSettings} onSaved={loadShared} />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- overview */

// Deliberately user-facing only: no watcher health, ATS types, fetch errors,
// or Check now / Send digest buttons. That's operator information, and the
// two buttons are global actions that spend the shared free-tier budget -
// not something every signed-in job seeker should see or be able to fire.
function OverviewTab({ status, onGoto }: { status: StatusResponse | null; onGoto: (t: Tab) => void }) {
  const [all, setAll] = useState<PostingRow[] | null>(null)

  const [fresh, setFresh] = useState<PostingRow[]>([])

  // The desktop app tracks "last opened" locally for the same reason: it's
  // this viewer's reading state, not anything the server needs. The previous
  // timestamp is read BEFORE it's overwritten, so "new" means new since the
  // last visit, not since a second ago.
  useEffect(() => {
    const since = store.get('cw.lastOpenedAt')
    cw<PostingRow[]>('/postings')
      .then((rows) => {
        setAll(rows)
        setFresh(since ? rows.filter((p) => p.firstSeenAt > since) : rows.slice(0, 20))
        store.set('cw.lastOpenedAt', new Date().toISOString())
      })
      .catch(() => setAll([]))
  }, [])

  const byCompany = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const p of all ?? []) grouped.set(p.companyName, (grouped.get(p.companyName) ?? 0) + 1)
    return [...grouped.entries()].map(([name, open]) => ({ name, open })).sort((a, b) => b.open - a.open).slice(0, 8)
  }, [all])

  const saved = (all ?? []).filter((p) => p.appStatus === 'interested').length

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Open postings" value={all?.length} hint={status ? `across ${status.watchedCompanies} companies` : undefined} />
        <StatCard label="New since you last looked" value={all ? fresh.length : undefined} />
        <StatCard label="Applications" value={status?.applicationsSent} hint={all ? `${saved} saved` : undefined} />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Panel title="Newest openings" action={fresh.length > 0 ? { label: 'View all', onClick: () => onGoto('Postings') } : undefined}>
          {all === null ? (
            <Empty title="Loading…" />
          ) : fresh.length === 0 ? (
            <Empty title="Nothing new right now" hint="Most companies post summer internships between August and December, so a quiet stretch is expected." />
          ) : (
            <PostingList postings={fresh.slice(0, 10)} />
          )}
        </Panel>

        <Panel title="Where the openings are">
          {byCompany.length === 0 ? (
            <Empty title={all === null ? 'Loading…' : 'No open postings yet'} />
          ) : (
            <ul className="space-y-2">
              {byCompany.map((c) => (
                <li key={c.name} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate" title={c.name}>{c.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-800">
                    <div className="h-full rounded-full bg-white" style={{ width: `${(c.open / byCompany[0]!.open) * 100}%` }} />
                  </div>
                  <span className="w-8 shrink-0 text-right text-neutral-400">{c.open}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- postings */

function PostingsTab({ companies }: { companies: CompanyRow[] }) {
  const [roles, setRoles] = useState<RoleType[]>(['intern', 'newgrad', 'program'])
  const [search, setSearch] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [showMaybe, setShowMaybe] = useState(false)
  const [rows, setRows] = useState<PostingRow[] | null>(null)
  const [selected, setSelected] = useState<PostingRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (showMaybe) params.set('maybe', '1')
    else if (roles.length) params.set('roleTypes', roles.join(','))
    if (search) params.set('search', search)
    if (companyId) params.set('companyId', companyId)
    try {
      setRows(await cw<PostingRow[]>(`/postings?${params}`))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [roles, search, companyId, showMaybe])

  useEffect(() => {
    // Debounced so typing in search doesn't fire a request per keystroke.
    const t = setTimeout(() => void load(), 250)
    return () => clearTimeout(t)
  }, [load])

  const toggleRole = (r: RoleType) =>
    setRoles((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))

  const setPostingStatus = async (id: number, status: AppStatus) => {
    setRows((prev) => prev?.map((p) => (p.id === id ? { ...p, appStatus: status } : p)) ?? prev)
    setSelected((prev) => (prev?.id === id ? { ...prev, appStatus: status } : prev))
    await cw(`/postings/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) })
  }

  const sortedCompanies = useMemo(() => [...companies].sort((a, b) => a.name.localeCompare(b.name)), [companies])

  return (
    // minmax(0,1fr) + min-w-0 so a long title can never prop the column open.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
      <Panel>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {!showMaybe &&
            (['intern', 'newgrad', 'program'] as RoleType[]).map((r) => (
              <Chip key={r} active={roles.includes(r)} onClick={() => toggleRole(r)}>{ROLE_LABEL[r]}</Chip>
            ))}
          <Chip active={showMaybe} onClick={() => setShowMaybe((v) => !v)}>Maybe</Chip>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="max-w-[180px] rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs"
          >
            <option value="">All companies</option>
            {sortedCompanies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, company, location…"
            className="min-w-[200px] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm"
          />
        </div>

        {showMaybe && (
          <p className="mb-3 text-xs text-neutral-500">
            Titles the classifier couldn&apos;t confidently place (PhD-tagged, year-tagged research roles). Reviewed
            here rather than guessed.
          </p>
        )}
        {error && <p className="mb-3 text-sm text-red-300">{error}</p>}

        {rows === null ? (
          <Empty title="Loading…" />
        ) : rows.length === 0 ? (
          <Empty title="No matching postings" hint="Try fewer filters, or check your job-function settings." />
        ) : (
          <PostingList postings={rows} selectedId={selected?.id} onSelect={setSelected} />
        )}
      </Panel>

      <Panel title={selected ? 'Details' : undefined} className="h-fit lg:sticky lg:top-6">
        {selected ? (
          <div>
            <h3 className="break-words text-base font-semibold leading-snug">{selected.title}</h3>
            <p className="mt-1 break-words text-sm text-neutral-400">
              {selected.companyName}
              {selected.location ? ` · ${selected.location}` : ''}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <RoleBadge role={selected.roleType} />
              <span className="text-xs text-neutral-500">{postedLabel(selected.postedAt, selected.firstSeenAt)}</span>
            </div>

            <a
              href={selected.applyUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 block w-full rounded-md bg-white px-4 py-2 text-center text-sm font-medium text-neutral-900 hover:bg-neutral-200"
            >
              Open career page
            </a>

            <div className="mt-4">
              <span className="mb-1 block text-xs text-neutral-500">Application status</span>
              <div className="flex flex-wrap gap-1.5">
                {APP_STATUSES.map(([s, label]) => (
                  <Chip key={s} active={selected.appStatus === s} onClick={() => void setPostingStatus(selected.id, s)}>
                    {label}
                  </Chip>
                ))}
              </div>
            </div>

            {selected.description ? (
              <div className="mt-5 max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-400">
                {selected.description.slice(0, 6000)}
              </div>
            ) : (
              <p className="mt-5 text-xs text-neutral-500">
                No description was included in this feed - open the career page for the full posting.
              </p>
            )}
          </div>
        ) : (
          <Empty title="Select a posting" hint="Details, a link, and application tracking appear here." />
        )}
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------------- programs */

function ProgramsTab() {
  const [rows, setRows] = useState<PostingRow[] | null>(null)

  useEffect(() => {
    cw<PostingRow[]>('/postings?roleTypes=program').then(setRows).catch(() => setRows([]))
  }, [])

  return (
    <Panel title="Fellowships & programs found in job feeds">
      {rows === null ? (
        <Empty title="Loading…" />
      ) : rows.length === 0 ? (
        <Empty title="No programs found yet" hint="Fellowships, residencies and apprenticeships are picked out of company job feeds automatically." />
      ) : (
        <PostingList postings={rows} />
      )}
    </Panel>
  )
}

/* --------------------------------------------------------------- companies */

function CompaniesTab({ companies }: { companies: CompanyRow[] }) {
  const [search, setSearch] = useState('')
  const [requestName, setRequestName] = useState('')
  const [requestUrl, setRequestUrl] = useState('')
  const [requestResult, setRequestResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Every user gets every approved company automatically - there's no
  // "add to my list" anymore. A missing company becomes a request that gets
  // verified before it's ever added for everyone.
  const requestCompanyTicket = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!requestName.trim()) return
    setBusy(true); setRequestResult(null)
    try {
      await cw('/companies/request', {
        method: 'POST',
        body: JSON.stringify({ name: requestName.trim(), careersUrl: requestUrl.trim() || undefined })
      })
      setRequestResult(`Requested "${requestName.trim()}" - we'll verify it and add it for everyone.`)
      setRequestName(''); setRequestUrl('')
    } catch (err) {
      setRequestResult(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const q = search.trim().toLowerCase()
  const matches = companies.filter((c) => c.name.toLowerCase().includes(q))

  return (
    <div className="space-y-6">
      <Panel title="Request a company">
        <p className="mb-3 text-sm text-neutral-400">
          Every company here is fetched for you automatically. Don&apos;t see one you&apos;re expecting? Request it and
          we&apos;ll verify and add it for everyone.
        </p>
        <form onSubmit={requestCompanyTicket} className="flex flex-wrap gap-2">
          <input
            value={requestName}
            onChange={(e) => setRequestName(e.target.value)}
            placeholder="Company name"
            className="min-w-[160px] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          <input
            value={requestUrl}
            onChange={(e) => setRequestUrl(e.target.value)}
            placeholder="Careers URL (optional)"
            className="min-w-[200px] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          <button type="submit" disabled={busy} className="rounded-md border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900 disabled:opacity-50">
            Request
          </button>
        </form>
        {requestResult && <p className="mt-3 text-sm text-neutral-400">{requestResult}</p>}
      </Panel>

      <Panel title={`Watched companies (${companies.length})`}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${companies.length} companies…`}
          className="mb-3 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm"
        />
        <ul className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800">
          {matches.slice(0, 200).map((c) => (
            <li key={c.id} className="min-w-0 px-4 py-2.5 text-sm">
              <a href={c.careers_url} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline" title={c.name}>
                {c.name}
              </a>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-neutral-500">
              {companies.length === 0 ? 'Loading…' : 'No companies match.'}
            </li>
          )}
        </ul>
        {matches.length > 200 && (
          <p className="mt-2 text-xs text-neutral-500">Showing the first 200 matches - narrow your search to see more.</p>
        )}
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------------- settings */

function SettingsTab({
  settings, setSettings, onSaved
}: { settings: Settings; setSettings: (s: Settings) => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const save = async () => {
    setBusy(true); setResult(null)
    try {
      await cw('/settings', { method: 'PUT', body: JSON.stringify(settings) })
      await onSaved()
      setResult('Saved.')
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-6">
      <Panel title="What to look for">
        <div className="flex flex-wrap items-center gap-2">
          {([
            ['wantIntern', 'Internships'],
            ['wantNewGrad', 'New grad'],
            ['wantProgram', 'Programs'],
            ['remoteOk', 'Remote OK']
          ] as [keyof Settings, string][]).map(([key, label]) => (
            <Chip key={key} active={Boolean(settings[key])} onClick={() => setSettings({ ...settings, [key]: !settings[key] })}>
              {label}
            </Chip>
          ))}
        </div>
        <label className="mt-4 flex flex-col gap-1 text-sm">
          Locations (comma-separated)
          <input
            value={settings.locations.join(', ')}
            onChange={(e) => setSettings({ ...settings, locations: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder="e.g. New York, San Francisco, United States"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>
      </Panel>

      <Panel title="Job function">
        <div className="flex flex-wrap gap-2">
          {FUNCTION_OPTIONS.map(([id, label]) => {
            const active = settings.functions.includes(id)
            return (
              <Chip
                key={id}
                active={active}
                onClick={() =>
                  setSettings({ ...settings, functions: active ? settings.functions.filter((f) => f !== id) : [...settings.functions, id] })
                }
              >
                {label}
              </Chip>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Applies to Postings and the digest email. None selected = every function. A title with no function keywords
          is judged by its description. Fellowships are never filtered.
        </p>
      </Panel>

      <Panel title="Title keywords">
        <div className="grid gap-4 sm:grid-cols-2">
          <KeywordField
            label="Only titles containing (any of)"
            placeholder="e.g. software, swe, developer"
            value={settings.includeKeywords ?? []}
            onChange={(v) => setSettings({ ...settings, includeKeywords: v })}
          />
          <KeywordField
            label="Never titles containing"
            placeholder="e.g. mechanical, sales, hardware"
            value={settings.excludeKeywords ?? []}
            onChange={(v) => setSettings({ ...settings, excludeKeywords: v })}
          />
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          The exact control over what reaches your email (and Postings). Comma-separated, not case-sensitive. Leave
          &quot;only&quot; empty to allow everything that passes the other filters; &quot;never&quot; always wins.
        </p>
      </Panel>

      <Panel title="Degree level">
        <div className="flex flex-wrap gap-2">
          {([['bachelors', "Bachelor's"], ['masters', "Master's"], ['phd', 'PhD']] as const).map(([d, label]) => (
            <Chip key={d} active={settings.degreeLevel === d} onClick={() => setSettings({ ...settings, degreeLevel: settings.degreeLevel === d ? null : d })}>
              {label}
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          A role stating it needs a higher degree than this is filtered out. Unstated requirements always pass.
        </p>
      </Panel>

      <Panel title="Email & cleanup">
        <div className="grid gap-4 sm:grid-cols-2">
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
        </div>
      </Panel>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50">
          Save settings
        </button>
        {result && <span className="text-sm text-neutral-400">{result}</span>}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- primitives */

/**
 * Keeps its own raw text so typing "software," doesn't have the trailing comma
 * eaten mid-keystroke (which parsing on every change would do), while still
 * pushing the parsed list up immediately.
 */
function KeywordField({
  label, placeholder, value, onChange
}: { label: string; placeholder: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '))
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))
        }}
        placeholder={placeholder}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
      />
    </label>
  )
}

function PostingList({
  postings, onSelect, selectedId
}: { postings: PostingRow[]; onSelect?: (p: PostingRow) => void; selectedId?: number }) {
  return (
    <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
      {postings.map((p) => {
        const body = (
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={p.title}>{p.title}</div>
              <div className="mt-0.5 truncate text-xs text-neutral-500">
                {p.companyName}
                {p.location ? ` · ${p.location}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <RoleBadge role={p.roleType} />
              <span className="text-[11px] text-neutral-500">{postedLabel(p.postedAt, p.firstSeenAt)}</span>
            </div>
          </div>
        )
        const cls = `block w-full rounded-md px-3 py-2.5 text-left ${
          selectedId === p.id ? 'bg-neutral-800' : 'hover:bg-neutral-900'
        }`
        return (
          <li key={p.id} className="min-w-0">
            {onSelect ? (
              <button onClick={() => onSelect(p)} className={cls}>{body}</button>
            ) : (
              <a href={p.applyUrl} target="_blank" rel="noreferrer" className={cls}>{body}</a>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Panel({
  title, action, className = '', children
}: {
  title?: string
  action?: { label: string; onClick: () => void }
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`min-w-0 rounded-lg border border-neutral-800 p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-center gap-3">
          {title && <h2 className="flex-1 text-sm font-semibold uppercase tracking-wide text-neutral-400">{title}</h2>}
          {action && (
            <button onClick={action.onClick} className="text-xs text-neutral-300 hover:underline">{action.label}</button>
          )}
        </div>
      )}
      {children}
    </section>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs ${
        active ? 'border-white bg-white text-neutral-900' : 'border-neutral-700 text-neutral-300 hover:border-neutral-500'
      }`}
    >
      {children}
    </button>
  )
}

function RoleBadge({ role }: { role: RoleType }) {
  return (
    <span className="whitespace-nowrap rounded-full border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300">
      {ROLE_LABEL[role]}
    </span>
  )
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-sm text-neutral-300">{title}</p>
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string | number | undefined; hint?: string }) {
  return (
    <div className="rounded-md border border-neutral-800 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value ?? '—'}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-500">{hint}</div>}
    </div>
  )
}
