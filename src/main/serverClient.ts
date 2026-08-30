import { getSecret, setSecret } from './secrets'

/**
 * The desktop app's only path to data. Per the architecture decision, the
 * client is an interface: it owns no schedule, no SQLite database of its own,
 * and no fetch pipeline - the server does all of that, hourly, whether or not
 * this app is even running. The client's job is to read what the server
 * collected and let the user manage settings and the watchlist.
 */

export function getServerUrl(): string | null {
  return getSecret('serverUrl')
}

export function getServerToken(): string | null {
  return getSecret('serverToken')
}

export function setServerConfig(url: string, token: string): void {
  setSecret('serverUrl', url.replace(/\/+$/, ''))
  setSecret('serverToken', token)
}

export function isConfigured(): boolean {
  return !!getServerUrl() && !!getServerToken()
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ServerError'
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = getServerUrl()
  const token = getServerToken()
  if (!base || !token) {
    throw new ServerError('Server not configured - set it in Settings', 0)
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)

  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers
      }
    })
  } catch (err) {
    throw new ServerError(
      `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      0
    )
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ServerError(`Server returned ${res.status}: ${body.slice(0, 300)}`, res.status)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string): Promise<T> => call<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    call<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    call<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  del: <T>(path: string): Promise<T> => call<T>(path, { method: 'DELETE' })
}

/** A cheap reachability probe for the Settings "Test connection" button. */
export async function testConnection(url: string, token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (res.status === 401) return { ok: false, error: 'wrong token' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
