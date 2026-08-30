import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AppStatus } from '@shared/types'
import { Admin, Companies, Dashboard, Postings, Programs, Settings } from './tabs'

const TABS = ['Dashboard', 'Postings', 'Programs', 'Companies', 'Admin', 'Settings'] as const
type Tab = (typeof TABS)[number]

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('Dashboard')
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)

  /**
   * Surfaces failures instead of sitting on "Loading…" forever. An IPC error
   * with no handling is indistinguishable from a slow load, which hides
   * exactly the bugs worth seeing.
   */
  const refresh = useCallback(async () => {
    try {
      if (typeof window.api === 'undefined') {
        throw new Error('preload bridge unavailable (window.api is undefined)')
      }
      setStatus(await window.api.getStatus())
      setFatal(null)
    } catch (err) {
      setFatal(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.api.onRunFinished(() => void refresh())
    return off
  }, [refresh])

  const notConfigured = status !== null && status.watchedCompanies === 0 && status.lastRun === null

  return (
    <div className="mesh-bg flex h-full flex-col text-on-surface">
      <header className="flex flex-wrap items-center gap-4 px-7 pt-6 pb-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Career Watch</h1>
          <p className="truncate text-sm text-on-surface-variant">
            {status
              ? `${status.watchedCompanies} companies watched`
              : 'Loading…'}
          </p>
        </div>
      </header>

      {fatal && (
        <div className="mx-7 mb-2 rounded-panel bg-danger/15 px-4 py-3 text-sm text-danger">
          <div className="font-medium">Could not talk to the app backend</div>
          <div className="mt-1 font-mono text-xs opacity-80">{fatal}</div>
        </div>
      )}

      {!fatal && notConfigured && tab !== 'Settings' && (
        <div className="mx-7 mb-2 rounded-panel bg-warning/15 px-4 py-2 text-sm text-warning">
          Not connected to a server yet — set it up in Settings.
        </div>
      )}

      <nav className="glass mx-7 flex gap-1 rounded-pill p-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-pill px-4 py-2 text-sm font-medium transition-all ${
              tab === t
                ? 'bg-primary-container text-on-primary-container'
                : 'text-on-surface-variant hover:bg-surface-container-high'
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-7">
        {tab === 'Dashboard' && <Dashboard onGoto={(t) => setTab(t as Tab)} />}
        {tab === 'Postings' && <Postings />}
        {tab === 'Programs' && <Programs />}
        {tab === 'Companies' && <Companies onChanged={() => void refresh()} />}
        {tab === 'Admin' && <Admin status={status} onChecked={() => void refresh()} />}
        {tab === 'Settings' && <Settings onSaved={() => void refresh()} />}
      </main>
    </div>
  )
}
