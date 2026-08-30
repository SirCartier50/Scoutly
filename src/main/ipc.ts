import { app, dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { CHANNELS } from '@shared/ipc'
import type { ImportResult, SeedSuggestion, UiSettings } from '@shared/ipc'
import type { AppStatus } from '@shared/types'
import { api, getServerToken, getServerUrl, isConfigured, setServerConfig, testConnection, ServerError } from './serverClient'
import { getSettings as getLocalSettings, setSetting as setLocalSetting } from './db/settings'
import { getDb } from './db/index'

/**
 * Every handler here is a thin proxy to the server - the desktop app owns no
 * schedule and no watch data of its own. `lastOpenedAt` is the one thing that
 * stays purely local: it is about this window's viewing state, not anything
 * the server needs to know.
 */

interface ServerCompany {
  id: number
  name: string
  careers_url: string
  ats_type: string
  board_token: string | null
  topics: string
  watched: number
  health: string
  last_ok_at: string | null
  last_yield: number | null
}

interface ServerPosting {
  id: number
  companyId: number
  companyName: string
  title: string
  location: string | null
  roleType: string
  applyUrl: string
  postedAt: string | null
  firstSeenAt: string
  closedAt: string | null
  description: string | null
  appStatus?: string
  appNote?: string | null
  deadline?: string | null
}

interface ServerStatus {
  watchedCompanies: number
  openPostings: number
  applicationsSent: number
  lastRun: {
    id: number
    kind: string
    started_at: string
    finished_at: string | null
    companies_checked: number
    new_postings: number
    errors: number
  } | null
  health: { ok: number; stale: number; broken: number }
}

/** Rewrites the once-a-day "next run" concept: the server checks hourly. */
function nextHourlyRun(): string {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.toISOString()
}

export function registerIpc(): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, async (_e, ...args) => fn(...(args as never[])))
  }

  /* ------------------------------------------------------------------ app */

  handle(CHANNELS.getStatus, async (): Promise<AppStatus> => {
    if (!isConfigured()) {
      return {
        version: app.getVersion(),
        watchedCompanies: 0,
        newSinceLastOpen: 0,
        lastRun: null,
        nextRunAt: null,
        spendUsd: 0,
        spendCapUsd: 0,
        health: { ok: 0, stale: 0, broken: 0 }
      }
    }

    const s = await api.get<ServerStatus>('/api/status')
    const lastOpenedAt = getLocalSettings(getDb()).lastOpenedAt
    let newSinceLastOpen = 0
    if (lastOpenedAt) {
      const fresh = await api.get<ServerPosting[]>('/api/postings')
      newSinceLastOpen = fresh.filter((p) => p.firstSeenAt > lastOpenedAt).length
    }

    return {
      version: app.getVersion(),
      watchedCompanies: s.watchedCompanies,
      newSinceLastOpen,
      lastRun: s.lastRun
        ? {
            id: s.lastRun.id, startedAt: s.lastRun.started_at, finishedAt: s.lastRun.finished_at,
            companiesChecked: s.lastRun.companies_checked, newPostings: s.lastRun.new_postings,
            errors: s.lastRun.errors
          }
        : null,
      nextRunAt: nextHourlyRun(),
      spendUsd: 0, // Agent spend now happens server-side; not yet surfaced here.
      spendCapUsd: 0,
      health: s.health
    }
  })

  handle(CHANNELS.runCheckNow, async () => {
    if (!isConfigured()) return { started: false, reason: 'server not configured yet' }
    try {
      await api.post('/api/check')
      return { started: true }
    } catch (err) {
      return { started: false, reason: err instanceof ServerError ? err.message : String(err) }
    }
  })

  handle(CHANNELS.openExternal, async (url: string) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    await shell.openExternal(parsed.toString())
  })

  /* ------------------------------------------------------------ companies */

  handle(CHANNELS.listCompanies, async () => {
    if (!isConfigured()) return []
    const rows = await api.get<ServerCompany[]>('/api/companies')
    return rows.map((c) => ({
      id: c.id, name: c.name, careersUrl: c.careers_url, atsType: c.ats_type as never,
      boardToken: c.board_token, topics: JSON.parse(c.topics) as string[],
      watched: c.watched === 1, source: 'manual' as const,
      lastOkAt: c.last_ok_at, lastYield: c.last_yield, health: c.health as never
    }))
  })

  handle(CHANNELS.setWatched, (id: number, watched: boolean) =>
    api.post('/api/companies/watch', { id, watched })
  )

  handle(CHANNELS.removeCompany, (id: number) => api.del(`/api/companies/${id}`))

  handle(CHANNELS.addCompany, async (name: string, careersUrl: string) => {
    try {
      const res = await api.post<{ ok: boolean; id: number; via: string }>('/api/companies/add', {
        name, careersUrl: careersUrl || undefined
      })
      return { ok: res.ok, id: res.id }
    } catch (err) {
      return { ok: false, error: err instanceof ServerError ? err.message : String(err) }
    }
  })

  /**
   * D1 stores `topics` as a JSON-encoded TEXT column, so every row the server
   * returns from `/api/directory` carries it as a raw string, not an array -
   * same shape as the `companies` table. Parsed here so the renderer never has
   * to guess the wire type; an unparsable value fails safe to an empty list
   * rather than crashing the whole render tree on a bad row.
   */
  interface DirectoryRow {
    name: string
    careersUrl: string
    atsType: string
    topics: string
    jobCount: number
  }
  const parseDirectoryRow = (r: DirectoryRow): SeedSuggestion => {
    let topics: string[] = []
    try {
      const parsed: unknown = JSON.parse(r.topics)
      if (Array.isArray(parsed)) topics = parsed as string[]
    } catch {
      // Malformed topics on one row should not break the whole list.
    }
    return { name: r.name, careersUrl: r.careersUrl, atsType: r.atsType, topics, alreadyAdded: false }
  }

  handle(CHANNELS.searchSeed, (query: string): Promise<SeedSuggestion[]> =>
    api.get<DirectoryRow[]>(`/api/directory?q=${encodeURIComponent(query ?? '')}`)
      .then((rows) => rows.map(parseDirectoryRow))
  )

  handle(CHANNELS.suggestByTopics, async (topics: string[]): Promise<SeedSuggestion[]> => {
    if (!topics || topics.length === 0) return []
    const results = await Promise.all(
      topics.map((t) => api.get<DirectoryRow[]>(`/api/directory?topic=${encodeURIComponent(t)}`))
    )
    const byName = new Map<string, SeedSuggestion>()
    for (const list of results) for (const r of list) byName.set(r.name, parseDirectoryRow(r))
    return [...byName.values()].slice(0, 16)
  })

  /** Reads a local CSV and adds each row through the server's directory-aware endpoint. */
  handle(CHANNELS.importCsv, async (): Promise<ImportResult> => {
    const res = await dialog.showOpenDialog({
      title: 'Import companies from CSV',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return { added: 0, skipped: 0, errors: [] }

    let text: string
    try {
      text = readFileSync(res.filePaths[0], 'utf8')
    } catch (err) {
      return { added: 0, skipped: 0, errors: [err instanceof Error ? err.message : String(err)] }
    }

    const out: ImportResult = { added: 0, skipped: 0, errors: [] }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')

    for (const [i, line] of lines.entries()) {
      const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      const name = cells[0] ?? ''
      if (!name) continue
      if (i === 0 && /^(company|name)$/i.test(name)) continue

      try {
        await api.post('/api/companies/add', { name, careersUrl: cells[1] || undefined })
        out.added++
      } catch (err) {
        out.skipped++
        out.errors.push(`${name}: ${err instanceof ServerError ? err.message : String(err)}`)
      }
    }
    return out
  })

  /* ------------------------------------------------------------- postings */

  handle(
    CHANNELS.listPostings,
    async (q: { roleTypes?: string[]; search?: string; companyId?: number; includeClosed?: boolean }) => {
      if (!isConfigured()) return []
      const params = new URLSearchParams()
      if (q?.roleTypes?.length) params.set('roleTypes', q.roleTypes.join(','))
      if (q?.search) params.set('search', q.search)
      // Filtered and ranked server-side now (relevance when searching, most
      // recent otherwise) rather than fetched-then-filtered here, so the
      // 500-row cap can't silently drop a company's postings before this
      // ever sees them.
      if (q?.companyId !== undefined) params.set('companyId', String(q.companyId))
      return await api.get<ServerPosting[]>(`/api/postings?${params.toString()}`)
    }
  )

  handle(CHANNELS.listNewSinceLastOpen, async () => {
    if (!isConfigured()) return []
    const lastOpenedAt = getLocalSettings(getDb()).lastOpenedAt
    const rows = await api.get<ServerPosting[]>('/api/postings')
    return lastOpenedAt ? rows.filter((r) => r.firstSeenAt > lastOpenedAt) : rows.slice(0, 20)
  })

  handle(CHANNELS.listPrograms, async () => {
    if (!isConfigured()) return []
    const rows = await api.get<ServerPosting[]>('/api/postings?roleTypes=program')
    return rows.map((p) => ({
      id: p.id, companyId: p.companyId, companyName: p.companyName, name: p.title,
      url: p.applyUrl, applyUrl: p.applyUrl, eligibility: null, deadline: p.deadline ?? null,
      status: null
    }))
  })

  /** The Maybe list: postings the classifier could not confidently place. */
  handle('postings:maybe', async () => {
    if (!isConfigured()) return []
    return api.get<ServerPosting[]>('/api/postings?maybe=1')
  })

  handle('postings:setStatus', (id: number, status: string, note?: string) =>
    api.post(`/api/postings/${id}/status`, { status, note })
  )

  /* ------------------------------------------------------------- settings */

  handle(CHANNELS.getSettings, async (): Promise<UiSettings> => {
    const configured = isConfigured()
    const server: Record<string, unknown> = configured
      ? await api.get<Record<string, unknown>>('/api/settings').catch(() => ({}))
      : {}

    return {
      locations: (server.locations as string[]) ?? [],
      remoteOk: (server.remoteOk as boolean) ?? true,
      topics: (server.topics as string[]) ?? [],
      wantIntern: (server.wantIntern as boolean) ?? true,
      wantNewGrad: (server.wantNewGrad as boolean) ?? true,
      wantProgram: (server.wantProgram as boolean) ?? true,
      functions: (server.functions as string[]) ?? ['engineering', 'data'],
      degreeLevel: (server.degreeLevel as string | null) ?? 'bachelors',
      scheduleTimes: ['hourly'], // the server checks hourly; not user-editable here
      gmailAddress: null,
      monthlyCapUsd: 0,
      launchAtLogin: app.getLoginItemSettings().openAtLogin,
      hasGmailPassword: false,
      hasApiKey: false,
      encryptionAvailable: true,
      serverUrl: getServerUrl() ?? '',
      serverConfigured: configured
    } as UiSettings & { serverUrl: string; serverConfigured: boolean }
  })

  handle(CHANNELS.saveSettings, async (patch: Partial<UiSettings> & { launchAtLogin?: boolean }) => {
    if ('launchAtLogin' in patch) {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin === true, args: ['--hidden'] })
    }
    const serverKeys = ['locations', 'remoteOk', 'topics', 'wantIntern', 'wantNewGrad', 'wantProgram', 'functions', 'degreeLevel']
    const clean: Record<string, unknown> = {}
    for (const k of serverKeys) if (k in patch) clean[k] = (patch as Record<string, unknown>)[k]
    if (Object.keys(clean).length > 0 && isConfigured()) await api.put('/api/settings', clean)
  })

  handle('server:configure', async (url: string, token: string) => {
    setServerConfig(url, token)
    return await testConnection(url, token)
  })

  handle('server:test', async () => {
    const url = getServerUrl()
    const token = getServerToken()
    if (!url || !token) return { ok: false, error: 'not configured' }
    return await testConnection(url, token)
  })

  // Gmail/API-key secrets and local digest sending are obsolete: the server
  // owns email via Resend now. Kept as no-ops so an older renderer bundle
  // doesn't hard-crash on a removed channel during the transition.
  handle(CHANNELS.saveSecret, () => undefined)
  handle(CHANNELS.verifyMail, () => ({ ok: false, error: 'email is now sent by the server automatically' }))
  handle(CHANNELS.sendTestDigest, () => ({ sent: false, count: 0, reason: 'email is now sent by the server automatically' }))
}

/** Records that the user has seen the dashboard - purely local viewing state. */
export function markOpened(): void {
  setLocalSetting(getDb(), 'lastOpenedAt', new Date().toISOString())
}
