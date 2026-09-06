/** Domain types shared between main, preload, and renderer. */

export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workday'
  | 'oraclehcm'
  | 'careerpage'
  // Dedicated connectors for specific large employers whose custom in-house
  // systems have a real, reverse-engineered JSON endpoint. Unlike the generic
  // ATS types, these are hand-verified against one company's own site, not a
  // platform used by many companies.
  | 'amazonjobs'
  | 'microsoftjobs'
  | 'googlejobs'
  | 'applejobs'
  | 'unknown'

export type RoleType = 'intern' | 'newgrad' | 'program' | 'other'

export type Health = 'ok' | 'stale' | 'broken'

export interface Company {
  id: number
  name: string
  /** Required: the company-hosted career page the user actually applies from. */
  careersUrl: string
  atsType: AtsType
  boardToken: string | null
  topics: string[]
  watched: boolean
  source: 'seed' | 'search' | 'csv' | 'manual'
  lastOkAt: string | null
  lastYield: number | null
  health: Health
}

export interface Posting {
  id: number
  companyId: number
  companyName: string
  externalId: string
  title: string
  location: string | null
  roleType: RoleType
  applyUrl: string
  /** Real posted date when the feed provides one; null on custom pages. */
  postedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  description: string | null
  notified: boolean
}

export interface Program {
  id: number
  companyId: number
  companyName: string
  name: string
  url: string
  applyUrl: string | null
  eligibility: string | null
  deadline: string | null
  status: string | null
  lastChangedAt: string
  notified: boolean
}

export interface RunSummary {
  id: number
  startedAt: string
  finishedAt: string | null
  companiesChecked: number
  newPostings: number
  errors: number
}

export interface AppStatus {
  version: string
  watchedCompanies: number
  newSinceLastOpen: number
  lastRun: RunSummary | null
  nextRunAt: string | null
  /** Rolling month-to-date agent spend and the hard cap from settings. */
  spendUsd: number
  spendCapUsd: number
  health: { ok: number; stale: number; broken: number }
}
