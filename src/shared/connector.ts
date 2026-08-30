import type { AtsType, RoleType } from './types'

/** One job as returned by a connector, before classification or storage. */
export interface RawPosting {
  externalId: string
  title: string
  location: string | null
  /** Absolute URL of the real application page on the company's board. */
  applyUrl: string
  /** Only set when the feed provides a trustworthy date; never fabricated. */
  postedAt: string | null
  description: string | null
  department: string | null
}

/** Everything a connector needs to fetch one company. */
export interface ConnectorTarget {
  id: number
  name: string
  careersUrl: string
  atsType: AtsType
  boardToken: string | null
  parseConfig: ParseConfig | null
}

/**
 * Emitted by Scout for custom career pages. Preference order is deliberate:
 * an internal JSON endpoint behaves like a public ATS API and survives
 * redesigns; HTML selectors are the last resort.
 */
export interface ParseConfig {
  kind: 'json-endpoint' | 'html' | 'rendered-html'
  url: string
  /** json-endpoint: dotted path to the array of jobs, e.g. "data.jobs". */
  itemsPath?: string
  /** json-endpoint: field mapping, dotted paths relative to each item. */
  fields?: {
    externalId?: string
    title?: string
    location?: string
    applyUrl?: string
    postedAt?: string
    description?: string
  }
  /** html / rendered-html: CSS selectors. */
  selectors?: {
    item: string
    title: string
    location?: string
    link?: string
  }
  /** Prefix for relative apply links. */
  baseUrl?: string
}

export interface FetchOutcome {
  ok: boolean
  postings: RawPosting[]
  error?: string
  /** True when the failure looks transient (timeout, 5xx) rather than structural. */
  transient?: boolean
}

export interface ClassifiedPosting extends RawPosting {
  roleType: RoleType
  /** Set when the title is ambiguous enough to warrant the Triage agent. */
  needsTriage: boolean
}
