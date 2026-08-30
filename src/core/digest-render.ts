import type { PendingNotification } from '../shared/notification'

/**
 * Digest rendering, deliberately free of SMTP and secrets so it can be tested
 * without electron or credentials.
 */

const ROLE_LABEL: Record<string, string> = {
  intern: 'Internship',
  program: 'Program / Fellowship',
  newgrad: 'New Grad',
  other: 'Role'
}

export interface DigestResult {
  sent: boolean
  count: number
  reason?: string
}

function groupByCompany(rows: PendingNotification[]): Map<string, PendingNotification[]> {
  const out = new Map<string, PendingNotification[]>()
  for (const r of rows) {
    const list = out.get(r.companyName) ?? []
    list.push(r)
    out.set(r.companyName, list)
  }
  return out
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderDigestHtml(rows: PendingNotification[]): string {
  const groups = groupByCompany(rows)
  const sections: string[] = []

  for (const [company, items] of groups) {
    const lis = items
      .map((p) => {
        const badge = ROLE_LABEL[p.roleType] ?? 'Role'
        const loc = p.location ? ` &middot; ${esc(p.location)}` : ''
        return `<li style="margin:0 0 10px 0;line-height:1.45">
          <a href="${esc(p.applyUrl)}" style="color:#5b3df5;text-decoration:none;font-weight:600">${esc(p.title)}</a>
          <div style="font-size:13px;color:#666">${esc(badge)}${loc}</div>
        </li>`
      })
      .join('')

    sections.push(
      `<div style="margin:0 0 26px 0">
        <h2 style="font-size:15px;margin:0 0 10px 0;color:#111">${esc(company)}</h2>
        <ul style="margin:0;padding-left:18px">${lis}</ul>
      </div>`
    )
  }

  const n = rows.length
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5fb;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">
      <h1 style="font-size:19px;margin:0 0 4px 0">${n} new ${n === 1 ? 'opening' : 'openings'}</h1>
      <p style="font-size:13px;color:#666;margin:0 0 24px 0">Career Watch &middot; every link goes to the company's own career page</p>
      ${sections.join('')}
      <p style="font-size:12px;color:#999;margin:24px 0 0 0;border-top:1px solid #eee;padding-top:14px">
        Sent by Career Watch running on your PC. Adjust companies and filters in the app.
      </p>
    </div>
  </body></html>`
}

export function renderDigestText(rows: PendingNotification[]): string {
  const groups = groupByCompany(rows)
  const parts: string[] = [`${rows.length} new opening(s)\n`]
  for (const [company, items] of groups) {
    parts.push(`\n${company}`)
    for (const p of items) {
      const badge = ROLE_LABEL[p.roleType] ?? 'Role'
      parts.push(`  - ${p.title} [${badge}]${p.location ? ` - ${p.location}` : ''}\n    ${p.applyUrl}`)
    }
  }
  return parts.join('\n')
}

