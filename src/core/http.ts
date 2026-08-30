/** Shared HTTP behaviour for every connector: timeouts, retries, honest UA. */

export const USER_AGENT =
  'career-watch/0.1 (personal job-posting tracker; contact via app owner)'

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly transient: boolean
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface FetchOpts {
  timeoutMs?: number
  retries?: number
  accept?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Retries only what is worth retrying: network faults, timeouts, 429 and 5xx.
 * A 404 is a structural answer, so it fails immediately and lets Medic decide.
 */
export async function httpGet(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 20000, retries = 2, accept = 'application/json' } = opts
  let lastErr: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 4000))

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept },
        signal: ctl.signal,
        redirect: 'follow'
      })

      if (res.ok) return res

      const transient = res.status === 429 || res.status >= 500
      lastErr = new HttpError(`HTTP ${res.status} for ${url}`, res.status, transient)
      if (!transient) throw lastErr
    } catch (err) {
      if (err instanceof HttpError && !err.transient) throw err
      const msg = err instanceof Error ? err.message : String(err)
      lastErr = new HttpError(`${msg} for ${url}`, null, true)
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastErr ?? new HttpError(`failed to fetch ${url}`, null, true)
}

export async function getJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await httpGet(url, opts)
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('json')) {
    // An HTML error page served with 200 would otherwise parse as garbage.
    throw new HttpError(`expected JSON, got "${ct}" from ${url}`, res.status, false)
  }
  return (await res.json()) as T
}

export async function getText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await httpGet(url, { accept: 'text/html,application/xhtml+xml', ...opts })
  return await res.text()
}

/** Resolves a possibly-relative href against a base, returning null if unusable. */
export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

/** Strips HTML to readable text for description fields and hashing. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
