import type { DatabaseSync } from 'node:sqlite'
import type { DegreeLevel, JobFunction } from '../../core/classify'

/** Everything user-configurable, with the defaults a fresh install starts on. */
export interface Settings {
  locations: string[]
  remoteOk: boolean
  topics: string[]
  wantIntern: boolean
  wantNewGrad: boolean
  wantProgram: boolean
  /** Empty means every function passes. */
  functions: JobFunction[]
  /** Highest degree held or being pursued; null disables the filter. */
  degreeLevel: DegreeLevel | null
  scheduleTimes: string[]
  gmailAddress: string | null
  monthlyCapUsd: number
  models: { scout: string; scoutEscalation: string; triage: string; medic: string }
  lastSuccessfulRun: string | null
  lastOpenedAt: string | null
  onboarded: boolean
  launchAtLogin: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  locations: [],
  remoteOk: true,
  topics: [],
  wantIntern: true,
  wantNewGrad: true,
  wantProgram: true,
  functions: ['engineering', 'data'],
  degreeLevel: 'bachelors',
  scheduleTimes: ['09:00', '18:00'],
  gmailAddress: null,
  monthlyCapUsd: 10,
  models: {
    scout: 'claude-haiku-4-5',
    scoutEscalation: 'claude-opus-5',
    triage: 'claude-haiku-4-5',
    medic: 'claude-opus-5'
  },
  lastSuccessfulRun: null,
  lastOpenedAt: null,
  onboarded: false,
  launchAtLogin: false
}

/** Reads the whole settings row, falling back to defaults per missing key. */
export function getSettings(db: DatabaseSync): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]

  const out = { ...DEFAULT_SETTINGS }
  for (const { key, value } of rows) {
    if (!(key in DEFAULT_SETTINGS)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(out as any)[key] = JSON.parse(value)
    } catch {
      // A corrupt value falls back to the default rather than crashing startup.
    }
  }
  return out
}

export function setSetting<K extends keyof Settings>(
  db: DatabaseSync,
  key: K,
  value: Settings[K]
): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value))
}

export function setSettings(db: DatabaseSync, patch: Partial<Settings>): void {
  for (const [k, v] of Object.entries(patch)) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(k, JSON.stringify(v))
  }
}
