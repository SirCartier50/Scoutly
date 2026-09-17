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
  includeKeywords: string[]
  excludeKeywords: string[]
  degreeLevel: string | null
  scheduleTimes: string[]
  gmailAddress: string | null
  monthlyCapUsd: number
  launchAtLogin: boolean
  hasGmailPassword: boolean
  hasApiKey: boolean
  encryptionAvailable: boolean
}

/* ------------------------------------------------------------------ updates */

export interface UpdateStatus {
  /**
   * disabled: running from source, where only git pull + rebuild can update.
   * downloading/ready: an update was found; ready means restart to install.
   */
  state: 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error'
  currentVersion: string
  availableVersion?: string
  /** 0-100 while downloading. */
  progress?: number
  checkedAt?: string
  error?: string
  reason?: string
}

/* ------------------------------------------------- resume + profile (local) */

/** Answers to the long tail of application questions, reused across applications. */
export interface SavedAnswer {
  question: string
  answer: string
  updatedAt: string
}

export interface UiProfile {
  /** Keyed by the field names in main/db/profile.ts's PROFILE_FIELDS. */
  fields: Record<string, string>
  answers: SavedAnswer[]
  llmBaseUrl: string
  llmModel: string
  /** The key itself never crosses this boundary - only whether one is set. */
  hasLlmKey: boolean
}

export interface UiResume {
  id: number
  label: string
  kind: string
  isDefault: boolean
  createdAt: string
  textLength: number
}

export interface UiTailored {
  id: number
  resumeId: number
  postingId: number | null
  companyName: string
  jobTitle: string
  jobUrl: string | null
  markdown: string
  /** What the model changed, and what the job wants that the resume lacks. */
  changes: string[]
  gaps: string[]
  pdfPath: string | null
  docxPath: string | null
  createdAt: string
}

export interface TailorRequest {
  postingId?: number | null
  companyName: string
  jobTitle: string
  jobUrl?: string | null
  jobDescription: string
  /** Defaults to the resume marked default. */
  resumeId?: number | null
}

export interface TailorSummary {
  ok: boolean
  tailored?: UiTailored
  error?: string
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
    /** Applied on this machine - see main/ipc.ts. Empty/omitted means no filter. */
    functions?: string[]
    includeKeywords?: string[]
    excludeKeywords?: string[]
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

  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>

  getProfile(): Promise<UiProfile>
  saveProfile(patch: Record<string, string>): Promise<void>
  saveAnswer(question: string, answer: string): Promise<void>
  deleteAnswer(question: string): Promise<void>
  saveTailorConfig(cfg: { baseUrl?: string; model?: string; apiKey?: string }): Promise<void>

  listResumes(): Promise<UiResume[]>
  importResume(): Promise<{ ok: boolean; id?: number; error?: string }>
  setDefaultResume(id: number): Promise<void>
  deleteResume(id: number): Promise<void>

  listTailored(): Promise<UiTailored[]>
  tailorResume(req: TailorRequest): Promise<TailorSummary>
  deleteTailored(id: number): Promise<void>
  exportTailored(
    id: number,
    formats: ('pdf' | 'docx')[]
  ): Promise<{ ok: boolean; paths?: string[]; error?: string }>
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
  setPostingStatus: 'postings:setStatus',

  getUpdateStatus: 'updates:status',
  checkForUpdates: 'updates:check',
  installUpdate: 'updates:install',

  getProfile: 'profile:get',
  saveProfile: 'profile:save',
  saveAnswer: 'profile:saveAnswer',
  deleteAnswer: 'profile:deleteAnswer',
  saveTailorConfig: 'profile:saveTailorConfig',

  listResumes: 'resumes:list',
  importResume: 'resumes:import',
  setDefaultResume: 'resumes:setDefault',
  deleteResume: 'resumes:delete',

  listTailored: 'tailored:list',
  tailorResume: 'tailored:create',
  deleteTailored: 'tailored:delete',
  exportTailored: 'tailored:export'
} as const

export const EVENTS = {
  runFinished: 'checks:finished',
  runStarted: 'checks:started',
  updateStatus: 'updates:status-changed'
} as const
