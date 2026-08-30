import { getToken } from 'next-auth/jwt'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxies every /api/cw/* request to the Cloudflare Worker, attaching the
 * signed-in user's Career Watch bearer token server-side. This is the only
 * place that token is ever read or sent - it lives in the encrypted session
 * JWT (see auth.ts) and never reaches the browser as plain JS-visible state.
 */
const WORKER_URL = process.env.CAREER_WATCH_WORKER_URL ?? 'http://127.0.0.1:8787'

async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  const token = await getToken({ req, secret: process.env.AUTH_SECRET })
  if (!token?.cwToken) {
    return NextResponse.json({ error: token?.cwError ?? 'not signed in' }, { status: 401 })
  }

  const target = new URL(`/api/${path.join('/')}`, WORKER_URL)
  target.search = req.nextUrl.search

  const init: RequestInit = {
    method: req.method,
    headers: {
      authorization: `Bearer ${token.cwToken}`,
      'content-type': req.headers.get('content-type') ?? 'application/json'
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text()
  }

  const res = await fetch(target, init)
  const body = await res.text()
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }
  })
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params).path)
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params).path)
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params).path)
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params).path)
}
