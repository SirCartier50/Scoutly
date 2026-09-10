'use client'

import { useState } from 'react'

/**
 * The desktop app has no OAuth flow of its own - Settings just takes a
 * bearer token pasted in, same as it always did (see src/main/serverClient.ts,
 * which needed zero code changes for the multi-user model). This is where
 * that token comes from: /api/token deliberately breaks the "never send the
 * token to client JS" rule this app otherwise holds to everywhere else,
 * because the account owner copying their own key out for their own other
 * client is exactly the case that rule isn't protecting against.
 */
export default function TokenBox() {
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const reveal = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/token')
      const body = (await res.json()) as { token?: string; error?: string }
      if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`)
      setToken(body.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!token) return
    await navigator.clipboard.writeText(token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="w-full max-w-md rounded-md border border-neutral-800 p-4 text-left">
      <h2 className="text-sm font-semibold text-neutral-200">Desktop app token</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Paste this into the desktop app&apos;s Settings → Server URL/Token fields.
        Treat it like a password - anyone with it can read your watch list and settings.
      </p>

      {!token ? (
        <button
          onClick={reveal}
          disabled={busy}
          className="mt-3 rounded-md border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-900 disabled:opacity-50"
        >
          {busy ? 'Loading…' : 'Reveal token'}
        </button>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs">
            {token}
          </code>
          <button
            onClick={copy}
            className="shrink-0 rounded-md border border-neutral-700 px-3 py-2 text-xs hover:bg-neutral-900"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  )
}
