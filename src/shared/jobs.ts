import type { ConnectorTarget, RawPosting } from './connector'
import type { RoleType } from './types'

/**
 * Message protocol between main and the forked utilityProcess.
 *
 * The worker performs network I/O and parsing only; it never touches SQLite.
 * Main stays the single writer, which sidesteps WAL write contention and keeps
 * all persistence decisions in one place.
 */

export type JobType =
  | 'fetch_company'
  | 'scout_company'
  | 'heal_connector'
  | 'hunt_programs'
  | 'triage_titles'

export interface FetchJob {
  jobId: number
  type: 'fetch_company'
  target: ConnectorTarget
}

export interface ScoutJob {
  jobId: number
  type: 'scout_company'
  companyId: number
  name: string
  careersUrl: string
}

export type WorkerJob = FetchJob | ScoutJob

/* ----------------------------------------------------- main -> worker */

export interface StartRunMsg {
  kind: 'run'
  runId: number
  jobs: WorkerJob[]
  concurrency: number
}

export interface ConfigureMsg {
  kind: 'configure'
  apiKey: string | null
  models: Record<string, string>
  spendRemainingUsd: number
}

export interface CancelMsg {
  kind: 'cancel'
}

export type ToWorker = StartRunMsg | ConfigureMsg | CancelMsg

/* ----------------------------------------------------- worker -> main */

export interface ClassifiedResult extends RawPosting {
  roleType: RoleType
  needsTriage: boolean
}

export interface JobDoneMsg {
  kind: 'job-done'
  jobId: number
  companyId: number
  ok: boolean
  /** Full open list for the company; main diffs it against stored state. */
  postings: ClassifiedResult[]
  error?: string
  transient?: boolean
  durationMs: number
}

export interface ScoutDoneMsg {
  kind: 'scout-done'
  jobId: number
  companyId: number
  ok: boolean
  atsType?: string
  boardToken?: string | null
  parseConfig?: unknown
  costUsd?: number
  tier?: 'probe' | 'cheap' | 'strong'
  error?: string
}

export interface RunDoneMsg {
  kind: 'run-done'
  runId: number
  completed: number
  failed: number
}

export interface LogMsg {
  kind: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

export type FromWorker = JobDoneMsg | ScoutDoneMsg | RunDoneMsg | LogMsg
