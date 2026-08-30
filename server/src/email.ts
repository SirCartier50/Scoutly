import type { PendingNotification } from '../../src/shared/notification'
import { renderDigestHtml, renderDigestText } from '../../src/core/digest-render'

/**
 * Email via Resend's HTTP API.
 *
 * Cloudflare Workers has no raw TCP, so SMTP - and therefore the Gmail app
 * password approach - is impossible here. An HTTP mail API is the only option,
 * and it is the safer one: a leaked key can send mail but never read an inbox.
 */
export interface SendResult {
  sent: boolean
  count: number
  reason?: string
}

export async function sendDigest(
  rows: PendingNotification[],
  opts: { apiKey?: string; to?: string; from?: string }
): Promise<SendResult> {
  if (rows.length === 0) return { sent: false, count: 0, reason: 'nothing new' }
  if (!opts.apiKey) return { sent: false, count: rows.length, reason: 'RESEND_API_KEY not set' }
  if (!opts.to) return { sent: false, count: rows.length, reason: 'DIGEST_TO not set' }

  const interns = rows.filter((r) => r.roleType === 'intern').length
  const n = rows.length
  const subject =
    interns > 0
      ? `${interns} new internship${interns === 1 ? '' : 's'}${n > interns ? ` (+${n - interns} more)` : ''}`
      : `${n} new early-career opening${n === 1 ? '' : 's'}`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      // onboarding@resend.dev needs no domain verification, but can only
      // deliver to the address that owns the Resend account.
      from: opts.from ?? 'Career Watch <onboarding@resend.dev>',
      to: [opts.to],
      subject,
      html: renderDigestHtml(rows),
      text: renderDigestText(rows)
    })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { sent: false, count: n, reason: `resend HTTP ${res.status}: ${body.slice(0, 200)}` }
  }

  return { sent: true, count: n }
}
