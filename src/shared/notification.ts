import type { RoleType } from './types'

/** One posting awaiting notification. Shared by the desktop app and the server. */
export interface PendingNotification {
  id: number
  title: string
  location: string | null
  applyUrl: string
  postedAt: string | null
  roleType: RoleType
  companyName: string
}
