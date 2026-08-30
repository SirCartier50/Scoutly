import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { SeedSuggestion, UiPosting, UiProgram, UiSettings } from '@shared/ipc'
import type { AppStatus, Company } from '@shared/types'
import {
  Button, Card, Chip, Empty, HealthDot, RoleBadge, TextField, Toggle,
  postedLabel, relativeTime
} from './ui'

/* ============================================================== Dashboard */

/**
 * Data only, per explicit feedback: no watcher health, no spend meter, no
 * "Check now" - those live in Admin now. This tab answers "what's new and
 * where do I stand", nothing about the plumbing that produced it.
 */
export function Dashboard({ onGoto }: { onGoto: (tab: string) => void }): JSX.Element {
  const [fresh, setFresh] = useState<UiPosting[] | null>(null)
  const [openCount, setOpenCount] = useState(0)
  const [appCounts, setAppCounts] = useState({ interested: 0, totalApplied: 0 })
  const [closingSoon, setClosingSoon] = useState<UiPosting[]>([])
  const [byCompany, setByCompany] = useState<{ name: string; open: number }[]>([])
  const [watchedCount, setWatchedCount] = useState<number | null>(null)

  const load = useCallback(async () => {
    const [newOnes, all, companies] = await Promise.all([
      window.api.listNewSinceLastOpen(),
      window.api.listPostings({}),
      window.api.listCompanies()
    ])
    setFresh(newOnes)
    setOpenCount(all.length)
    setWatchedCount(companies.filter((c) => c.watched).length)

    const applied = all.filter((p) => p.appStatus && p.appStatus !== 'none')
    setAppCounts({
      interested: applied.filter((p) => p.appStatus === 'interested').length,
      totalApplied: applied.filter((p) => p.appStatus && ['applied', 'interviewing', 'rejected', 'offer'].includes(p.appStatus)).length
    })

    setClosingSoon(
      all
        .filter((p) => p.deadline)
        .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''))
        .slice(0, 6)
    )

    const grouped = new Map<string, number>()
    for (const p of all) grouped.set(p.companyName, (grouped.get(p.companyName) ?? 0) + 1)
    setByCompany(
      [...grouped.entries()]
        .map(([name, open]) => ({ name, open }))
        .sort((a, b) => b.open - a.open)
        .slice(0, 8)
    )
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (fresh === null || watchedCount === null) return <Empty title="Loading…" />

  if (watchedCount === 0) {
    return (
      <Card className="border-primary/30">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1">
            <h2 className="text-base font-semibold">Pick companies to watch</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              Search the directory or import your own list to get started.
            </p>
          </div>
          <Button onClick={() => onGoto('Companies')}>Choose companies</Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 md:grid-cols-3">
        <Card title="Open postings">
          <span className="text-4xl font-semibold">{openCount}</span>
          <p className="mt-1 text-xs text-on-surface-variant">across {watchedCount} watched companies</p>
        </Card>

        <Card title="New since you last looked">
          <span className="text-4xl font-semibold">{fresh.length}</span>
          {fresh.length > 0 && (
            <button onClick={() => onGoto('Postings')} className="mt-2 block text-xs text-primary hover:underline">
              View all
            </button>
          )}
        </Card>

        <Card title="Applications">
          <div className="flex gap-6">
            <div>
              <div className="text-2xl font-semibold">{appCounts.totalApplied}</div>
              <div className="text-xs text-on-surface-variant">sent</div>
            </div>
            <div>
              <div className="text-2xl font-semibold text-on-surface-variant">{appCounts.interested}</div>
              <div className="text-xs text-on-surface-variant">saved</div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Newest openings">
          {fresh.length === 0 ? (
            <Empty
              title="Nothing new right now"
              hint="The server checks hourly. Most companies post summer internships between August and December, so a quiet stretch here is expected."
            />
          ) : (
            <PostingList postings={fresh.slice(0, 10)} />
          )}
        </Card>

        <Card title="Where the openings are">
          {byCompany.length === 0 ? (
            <Empty title="No open postings yet" />
          ) : (
            <ul className="grid gap-1">
              {byCompany.map((c) => (
                <li key={c.name} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate">{c.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-pill bg-surface-container-high">
                    <div
                      className="h-full rounded-pill bg-primary"
                      style={{ width: `${(c.open / byCompany[0]!.open) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-on-surface-variant">{c.open}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {closingSoon.length > 0 && (
        <Card title="Closing soon">
          <PostingList postings={closingSoon} showDeadline />
        </Card>
      )}
    </div>
  )
}

/* =============================================================== Postings */

const ROLE_FILTERS = [
  { key: 'intern', label: 'Internships' },
  { key: 'program', label: 'Programs' },
  { key: 'newgrad', label: 'New Grad' }
]

const APP_STATUSES = [
  { key: 'none', label: 'Not tracked' },
  { key: 'interested', label: 'Interested' },
  { key: 'applied', label: 'Applied' },
  { key: 'interviewing', label: 'Interviewing' },
  { key: 'offer', label: 'Offer' },
  { key: 'rejected', label: 'Rejected' }
]

export function Postings(): JSX.Element {
  const [roles, setRoles] = useState<string[]>(['intern', 'program', 'newgrad'])
  const [search, setSearch] = useState('')
  const [companyId, setCompanyId] = useState<number | ''>('')
  const [companies, setCompanies] = useState<Company[]>([])
  const [showMaybe, setShowMaybe] = useState(false)
  const [rows, setRows] = useState<UiPosting[]>([])
  const [selected, setSelected] = useState<UiPosting | null>(null)

  useEffect(() => {
    void window.api.listCompanies().then((all) => setCompanies(all.filter((c) => c.watched)))
  }, [])

  const load = useCallback(() => {
    // Sorted most-recent-first by default; a search re-ranks by closeness of
    // match (exact/starts-with/title-contains beats company/location, beats
    // only-the-description matching), both handled server-side now.
    const fetcher = showMaybe
      ? window.api.listMaybePostings()
      : window.api.listPostings({
          roleTypes: roles,
          search: search || undefined,
          companyId: companyId === '' ? undefined : companyId
        })
    void fetcher.then(setRows)
  }, [roles, search, showMaybe, companyId])

  useEffect(load, [load])

  const toggle = (key: string): void =>
    setRoles((r) => (r.includes(key) ? r.filter((x) => x !== key) : [...r, key]))

  const setStatus = async (status: string): Promise<void> => {
    if (!selected) return
    await window.api.setPostingStatus(selected.id, status)
    setSelected({ ...selected, appStatus: status })
    load()
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {!showMaybe &&
            ROLE_FILTERS.map((f) => (
              <Chip key={f.key} selected={roles.includes(f.key)} onClick={() => toggle(f.key)}>
                {f.label}
              </Chip>
            ))}
          <Chip selected={showMaybe} onClick={() => setShowMaybe((v) => !v)}>
            Maybe
          </Chip>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value === '' ? '' : Number(e.target.value))}
            className="rounded-pill border border-outline-variant bg-surface-container-low px-3 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
          >
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="ml-auto w-56">
            <TextField value={search} onChange={setSearch} placeholder="Search title or company…" />
          </div>
        </div>

        {showMaybe && (
          <p className="mb-3 text-xs text-on-surface-variant">
            Titles the classifier couldn&apos;t confidently place (PhD-tagged, year-tagged research
            roles). Reviewed here rather than guessed.
          </p>
        )}

        {rows.length === 0 ? (
          <Empty
            title="No matching postings"
            hint="Add companies in the Companies tab. The server checks hourly once you do."
          />
        ) : (
          <PostingList postings={rows} onSelect={setSelected} selectedId={selected?.id} />
        )}
      </Card>

      <Card title={selected ? 'Details' : undefined} className="h-fit lg:sticky lg:top-0">
        {selected ? (
          <div>
            <h3 className="text-base font-semibold leading-snug">{selected.title}</h3>
            <p className="mt-1 text-sm text-on-surface-variant">
              {selected.companyName}
              {selected.location ? ` · ${selected.location}` : ''}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <RoleBadge role={selected.roleType} />
              <span className="text-xs text-on-surface-variant">
                {postedLabel(selected.postedAt, selected.firstSeenAt)}
              </span>
            </div>

            <Button className="mt-4 w-full" onClick={() => void window.api.openExternal(selected.applyUrl)}>
              Open career page
            </Button>

            <div className="mt-4">
              <span className="mb-1 block text-xs text-on-surface-variant">Application status</span>
              <div className="flex flex-wrap gap-1.5">
                {APP_STATUSES.map((s) => (
                  <Chip
                    key={s.key}
                    selected={(selected.appStatus ?? 'none') === s.key}
                    onClick={() => void setStatus(s.key)}
                  >
                    {s.label}
                  </Chip>
                ))}
              </div>
            </div>

            {selected.description ? (
              <div className="mt-5 max-h-[36vh] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-on-surface-variant">
                {selected.description.slice(0, 6000)}
              </div>
            ) : (
              <p className="mt-5 text-xs text-on-surface-variant">
                No description was included in this feed — open the career page for the full posting.
              </p>
            )}
          </div>
        ) : (
          <Empty title="Select a posting" hint="Details, a link, and application tracking appear here." />
        )}
      </Card>
    </div>
  )
}

function PostingList({
  postings,
  onSelect,
  selectedId,
  showDeadline
}: {
  postings: UiPosting[]
  onSelect?: (p: UiPosting) => void
  selectedId?: number
  showDeadline?: boolean
}): JSX.Element {
  return (
    <ul className="grid gap-2">
      {postings.map((p) => (
        <li key={p.id}>
          <button
            onClick={() => (onSelect ? onSelect(p) : void window.api.openExternal(p.applyUrl))}
            className={`w-full rounded-panel px-3 py-2.5 text-left transition-colors ${
              selectedId === p.id ? 'bg-primary-container text-on-primary-container' : 'hover:bg-surface-container-high'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.title}</div>
                <div className="mt-0.5 truncate text-xs text-on-surface-variant">
                  {p.companyName}
                  {p.location ? ` · ${p.location}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <RoleBadge role={p.roleType} />
                <span className="text-[11px] text-on-surface-variant">
                  {showDeadline && p.deadline ? `due ${p.deadline}` : postedLabel(p.postedAt, p.firstSeenAt)}
                </span>
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

/* =============================================================== Programs */

export function Programs(): JSX.Element {
  const [postings, setPostings] = useState<UiPosting[]>([])
  const [rows, setRows] = useState<UiProgram[]>([])

  useEffect(() => {
    void window.api.listPostings({ roleTypes: ['program'] }).then(setPostings)
    void window.api.listPrograms().then(setRows)
  }, [])

  return (
    <div className="grid gap-5">
      <Card title="Fellowships & programs found in job feeds">
        {postings.length === 0 ? (
          <Empty
            title="No programs found yet"
            hint="Fellowships, residencies and apprenticeships are picked out of company job feeds automatically."
          />
        ) : (
          <PostingList postings={postings} />
        )}
      </Card>

      {rows.length > 0 && (
        <Card title="Tracked program pages">
          <ul className="grid gap-3">
            {rows.map((p) => (
              <li key={p.id} className="rounded-panel bg-surface-container-low p-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-on-surface-variant">{p.companyName}</div>
                  </div>
                  <Button variant="text" onClick={() => void window.api.openExternal(p.applyUrl ?? p.url)}>
                    Open
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/* ============================================================== Companies */

const TOPIC_CHIPS = [
  'fintech', 'ai-ml', 'devtools', 'infra', 'security', 'healthtech',
  'consumer', 'gaming', 'crypto', 'enterprise', 'ecommerce', 'data'
]

export function Companies({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [companies, setCompanies] = useState<Company[]>([])
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState<string | null>(null)
  const [results, setResults] = useState<SeedSuggestion[]>([])
  const [manualName, setManualName] = useState('')
  const [manualUrl, setManualUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const reload = useCallback(async () => {
    setCompanies(await window.api.listCompanies())
    const found = topic
      ? await window.api.suggestByTopics([topic])
      : await window.api.searchSeed(query)
    setResults(found)
    onChangedRef.current()
  }, [query, topic])

  useEffect(() => {
    void reload()
  }, [reload])

  const watched = useMemo(() => companies.filter((c) => c.watched), [companies])

  const add = async (s: SeedSuggestion): Promise<void> => {
    setBusy(true)
    try {
      await window.api.addCompany(s.name, s.careersUrl)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const addManual = async (): Promise<void> => {
    if (!manualName.trim()) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.api.addCompany(manualName, manualUrl)
      setNote(res.ok ? `Added ${manualName}.` : (res.error ?? 'Could not add company'))
      setManualName('')
      setManualUrl('')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const importCsv = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.importCsv()
      setNote(
        r.added === 0 && r.skipped === 0
          ? null
          : `Imported ${r.added}${r.skipped ? `, skipped ${r.skipped}` : ''}.` +
              (r.errors.length ? ` First issue: ${r.errors[0]}` : '')
      )
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card
        title={`Watching (${watched.length})`}
        action={
          <Button variant="tonal" onClick={() => void importCsv()} disabled={busy}>
            Import CSV
          </Button>
        }
      >
        {watched.length === 0 ? (
          <Empty title="No companies watched yet" hint="Add from the directory on the right." />
        ) : (
          <ul className="grid max-h-[52vh] gap-1 overflow-y-auto">
            {watched.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-panel px-3 py-2 hover:bg-surface-container-high">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="truncate text-xs text-on-surface-variant">
                    {c.atsType}
                    {c.lastYield !== null ? ` · ${c.lastYield} matching` : ''}
                    {c.lastOkAt ? ` · ${relativeTime(c.lastOkAt)}` : ' · never checked'}
                  </div>
                </div>
                <HealthDot health={c.health} />
                <Button variant="text" onClick={() => void window.api.setWatched(c.id, false).then(reload)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5">
        <Card title="Add companies">
          <TextField
            value={query}
            onChange={(v) => {
              setQuery(v)
              setTopic(null)
            }}
            placeholder="Search the company directory…"
          />
          <div className="mt-3 flex flex-wrap gap-1.5">
            {TOPIC_CHIPS.map((t) => (
              <Chip
                key={t}
                selected={topic === t}
                onClick={() => {
                  setTopic((cur) => (cur === t ? null : t))
                  setQuery('')
                }}
              >
                {t}
              </Chip>
            ))}
          </div>
          <ul className="mt-3 grid max-h-64 gap-1 overflow-y-auto">
            {results.map((s) => {
              const already = watched.some((w) => w.name === s.name)
              return (
                <li key={s.name} className="flex items-center gap-3 rounded-panel px-3 py-2 hover:bg-surface-container-high">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{s.name}</div>
                    <div className="truncate text-xs text-on-surface-variant">{s.topics.join(' · ')}</div>
                  </div>
                  {already ? (
                    <span className="text-xs text-on-surface-variant">added</span>
                  ) : (
                    <Button variant="tonal" onClick={() => void add(s)} disabled={busy}>
                      Add
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>

        <Card title="Add one manually">
          <div className="grid gap-2">
            <TextField label="Company name" value={manualName} onChange={setManualName} placeholder="Acme Corp" />
            <TextField
              label="Careers URL (optional)"
              value={manualUrl}
              onChange={setManualUrl}
              placeholder="acme.com/careers"
              onEnter={() => void addManual()}
            />
            <Button onClick={() => void addManual()} disabled={busy || !manualName.trim()}>
              {busy ? 'Looking up feed…' : 'Add company'}
            </Button>
            {note && <p className="text-xs text-on-surface-variant">{note}</p>}
            <p className="text-xs text-on-surface-variant">
              Resolved instantly if it&apos;s already in the server&apos;s directory; otherwise probed
              live and added if a public job feed is found.
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}

/* ================================================================== Admin */

/**
 * Everything that's about the plumbing rather than the postings themselves:
 * watcher health, manual check trigger, connection status. Moved off the
 * dashboard on purpose.
 */
export function Admin({ status, onChecked }: { status: AppStatus | null; onChecked: () => void }): JSX.Element {
  const [companies, setCompanies] = useState<Company[]>([])
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.api.listCompanies().then(setCompanies)
  }, [])

  useEffect(reload, [reload])

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    setNote(null)
    try {
      const res = await window.api.runCheckNow()
      setNote(res.started ? 'Check started on the server.' : (res.reason ?? 'Could not start'))
      onChecked()
      setTimeout(reload, 3000)
    } finally {
      setChecking(false)
    }
  }

  const watched = companies.filter((c) => c.watched)
  const broken = watched.filter((c) => c.health === 'broken')
  const stale = watched.filter((c) => c.health === 'stale')

  return (
    <div className="grid gap-5">
      <Card title="Server">
        <div className="flex items-center gap-4">
          <div className="flex-1 text-sm text-on-surface-variant">
            The server checks every hour on its own, whether or not this app is open.
          </div>
          <Button onClick={() => void checkNow()} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
        </div>
        {note && <p className="mt-2 text-xs text-on-surface-variant">{note}</p>}
        {status?.lastRun && (
          <p className="mt-2 text-xs text-on-surface-variant">
            Last run: {relativeTime(status.lastRun.startedAt)} · {status.lastRun.newPostings} new ·{' '}
            {status.lastRun.companiesChecked} checked
            {status.lastRun.errors > 0 && ` · ${status.lastRun.errors} errors`}
          </p>
        )}
      </Card>

      <Card title="Watcher health">
        <div className="flex gap-6 text-sm">
          <Health n={status?.health.ok ?? 0} label="ok" className="text-positive" />
          <Health n={status?.health.stale ?? 0} label="stale" className="text-warning" />
          <Health n={status?.health.broken ?? 0} label="broken" className="text-danger" />
        </div>

        {(broken.length > 0 || stale.length > 0) && (
          <ul className="mt-4 grid gap-1">
            {[...broken, ...stale].map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-panel px-3 py-2 hover:bg-surface-container-high">
                <div className="min-w-0 flex-1 truncate text-sm">{c.name}</div>
                <HealthDot health={c.health} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Health({ n, label, className }: { n: number; label: string; className: string }): JSX.Element {
  return (
    <div>
      <div className={`text-2xl font-semibold ${className}`}>{n}</div>
      <div className="text-xs text-on-surface-variant">{label}</div>
    </div>
  )
}

/* =============================================================== Settings */

export function Settings({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [s, setS] = useState<(UiSettings & { serverUrl: string; serverConfigured: boolean }) | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [serverToken, setServerToken] = useState('')
  const [locationsText, setLocationsText] = useState('')
  const [topicsText, setTopicsText] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const refresh = useCallback(async () => {
    const v = (await window.api.getSettings()) as UiSettings & { serverUrl: string; serverConfigured: boolean }
    setS(v)
    setServerUrl(v.serverUrl ?? '')
    setLocationsText(v.locations.join(', '))
    setTopicsText(v.topics.join(', '))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!s) return <Empty title="Loading…" />

  const save = async (patch: Partial<UiSettings>): Promise<void> => {
    setS({ ...s, ...patch })
    await window.api.saveSettings(patch)
    onSaved()
  }

  const commitLists = async (): Promise<void> => {
    await save({
      locations: locationsText.split(',').map((x) => x.trim()).filter(Boolean),
      topics: topicsText.split(',').map((x) => x.trim()).filter(Boolean)
    })
  }

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setNote(null)
    try {
      const res = await window.api.configureServer(serverUrl.trim(), serverToken.trim())
      setNote(res.ok ? 'Connected.' : `Failed: ${res.error}`)
      await refresh()
      onSaved()
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Server connection">
        <div className="grid gap-3">
          <TextField
            label="Server URL"
            value={serverUrl}
            onChange={setServerUrl}
            placeholder="https://career-watch.your-subdomain.workers.dev"
          />
          <TextField
            label="Access token"
            value={serverToken}
            onChange={setServerToken}
            type="password"
            placeholder="the CLIENT_TOKEN set on the server"
          />
          <Button onClick={() => void connect()} disabled={connecting || !serverUrl.trim() || !serverToken.trim()}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
          <p className="text-xs text-on-surface-variant">
            {s.serverConfigured ? '✓ Connected' : 'Not connected — nothing else will work until this is set.'}
          </p>
        </div>
      </Card>

      <Card title="What to look for">
        <div className="grid gap-1">
          <Toggle checked={s.wantIntern} onChange={(v) => void save({ wantIntern: v })} label="Internships" />
          <Toggle checked={s.wantProgram} onChange={(v) => void save({ wantProgram: v })} label="Fellowships & programs" />
          <Toggle checked={s.wantNewGrad} onChange={(v) => void save({ wantNewGrad: v })} label="New grad roles" />
          <Toggle checked={s.remoteOk} onChange={(v) => void save({ remoteOk: v })} label="Include remote" />
        </div>

        <div className="mt-4 grid gap-3">
          <TextField
            label="Locations (comma separated — empty means anywhere)"
            value={locationsText}
            onChange={setLocationsText}
            placeholder="New York, Boston, Seattle"
            onEnter={() => void commitLists()}
          />
          <TextField
            label="Topics you care about (drives company suggestions)"
            value={topicsText}
            onChange={setTopicsText}
            placeholder="ai-ml, fintech, devtools"
            onEnter={() => void commitLists()}
          />
          <Button variant="tonal" onClick={() => void commitLists()}>
            Save filters
          </Button>
        </div>
      </Card>

      <Card title="Degree level">
        <div className="flex flex-wrap gap-2">
          {(['bachelors', 'masters', 'phd'] as const).map((d) => (
            <Chip key={d} selected={s.degreeLevel === d} onClick={() => void save({ degreeLevel: d })}>
              {d === 'bachelors' ? "Bachelor's" : d === 'masters' ? "Master's" : 'PhD'}
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">
          A role stating it needs a higher degree than this is filtered out. Unstated requirements
          always pass.
        </p>
      </Card>

      <Card title="Job function">
        <div className="flex flex-wrap gap-2">
          {(['engineering', 'data', 'product', 'design'] as const).map((f) => {
            const active = s.functions.includes(f)
            return (
              <Chip
                key={f}
                selected={active}
                onClick={() =>
                  void save({ functions: active ? s.functions.filter((x) => x !== f) : [...s.functions, f] })
                }
              >
                {f}
              </Chip>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">
          Only postings confidently identified as non-technical are excluded — an oddly-titled
          technical role or a fellowship is never dropped just for lacking obvious keywords.
        </p>
      </Card>

      <Card title="Background behavior">
        <Toggle
          checked={s.launchAtLogin}
          onChange={(v) => void save({ launchAtLogin: v })}
          label="Start with Windows (minimised to tray)"
        />
        <p className="mt-1 px-1 text-xs text-on-surface-variant">
          The server checks hourly regardless. This only affects whether the app itself — and its
          tray notifications — are running.
        </p>
      </Card>

      {note && (
        <Card className="lg:col-span-2">
          <p className="text-sm">{note}</p>
        </Card>
      )}
    </div>
  )
}
