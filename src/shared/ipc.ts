import type { AppStatus, Company } from './types'

/** Rows the UI renders. Kept structural so main can return query results directly. */
export interface UiPosting {
  id: number
  companyId: number
  companyName: string
  title: string
  location: string | null
  roleType: 'intern' | 'newgrad' | 'program' | 'other'
  applyUrl: string
  /** Real feed date when available; null means we only know when WE saw it. */
  postedAt: string | null
  firstSeenAt: string
  closedAt: string | null
  description: string | null
  appStatus?: string
  appNote?: string | null
  deadline?: string | null
}

export interface UiProgram {
  id: number
  companyId: number
  companyName: string
  name: string
  url: string
  applyUrl: string | null
  eligibility: string | null
  deadline: string | null
  status: string | null
}

export interface UiSettings {
  serverUrl: string
  serverConfigured: boolean
  locations: string[]
  remoteOk: boolean
  topics: string[]
  wantIntern: boolean
  wantNewGrad: boolean
  wantProgram: boolean
  functions: string[]
  degreeLevel: string | null
  scheduleTimes: string[]
  gmailAddress: string | null
  monthlyCapUsd: number
  launchAtLogin: boolean
  hasGmailPassword: boolean
  hasApiKey: boolean
  encryptionAvailable: boolean
}

export interface SeedSuggestion {
  name: string
  careersUrl: string
  atsType: string
  topics: string[]
  alreadyAdded: boolean
}

export interface ImportResult {
  added: number
  skipped: number
  errors: string[]
}

/** The full renderer -> main surface; every call is invoke/handle. */
export interface IpcApi {
  getStatus(): Promise<AppStatus>
  runCheckNow(): Promise<{ started: boolean; reason?: string }>
  openExternal(url: string): Promise<void>

  listCompanies(): Promise<Company[]>
  setWatched(id: number, watched: boolean): Promise<void>
  addCompany(name: string, careersUrl: string): Promise<{ ok: boolean; id?: number; error?: string }>
  removeCompany(id: number): Promise<void>
  searchSeed(query: string): Promise<SeedSuggestion[]>
  suggestByTopics(topics: string[]): Promise<SeedSuggestion[]>
  importCsv(): Promise<ImportResult>

  listPostings(q: {
    roleTypes?: string[]
    search?: string
    companyId?: number
    includeClosed?: boolean
  }): Promise<UiPosting[]>
  listNewSinceLastOpen(): Promise<UiPosting[]>
  listPrograms(): Promise<UiProgram[]>

  getSettings(): Promise<UiSettings>
  saveSettings(patch: Partial<UiSettings>): Promise<void>
  saveSecret(key: 'gmailAppPassword' | 'anthropicApiKey', value: string): Promise<void>
  verifyMail(): Promise<{ ok: boolean; error?: string }>
  sendTestDigest(): Promise<{ sent: boolean; count: number; reason?: string }>

  configureServer(url: string, token: string): Promise<{ ok: boolean; error?: string }>
  testServerConnection(): Promise<{ ok: boolean; error?: string }>
  listMaybePostings(): Promise<UiPosting[]>
  setPostingStatus(id: number, status: string, note?: string): Promise<void>
}

export const CHANNELS = {
  getStatus: 'app:getStatus',
  runCheckNow: 'checks:runNow',
  openExternal: 'shell:openExternal',

  listCompanies: 'companies:list',
  setWatched: 'companies:setWatched',
  addCompany: 'companies:add',
  removeCompany: 'companies:remove',
  searchSeed: 'companies:searchSeed',
  suggestByTopics: 'companies:suggest',
  importCsv: 'companies:importCsv',

  listPostings: 'postings:list',
  listNewSinceLastOpen: 'postings:newSinceLastOpen',
  listPrograms: 'programs:list',

  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  saveSecret: 'secrets:save',
  verifyMail: 'mail:verify',
  sendTestDigest: 'mail:sendTest',

  configureServer: 'server:configure',
  testServerConnection: 'server:test',
  listMaybePostings: 'postings:maybe',
  setPostingStatus: 'postings:setStatus'
} as const

export const EVENTS = {
  runFinished: 'checks:finished',
  runStarted: 'checks:started'
} as const
