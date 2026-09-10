import { getToken } from 'next-auth/jwt'
import { NextRequest, NextResponse } from 'next/server'

/**
 * The one deliberate exception to "the bearer token never reaches client-side
 * JS": the desktop app has no OAuth flow of its own, so the only way to get
 * a personal token into it is for the account owner to copy one out of here
 * themselves. Every /api/cw/* route reads this exact token server-side on
 * every request already (see that route's comment) - this just shows it to
 * the one person who's allowed to see it, on demand, rather than never.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.AUTH_SECRET })
  if (!token?.cwToken) {
    return NextResponse.json({ error: token?.cwError ?? 'not signed in' }, { status: 401 })
  }
  return NextResponse.json({ token: token.cwToken })
}
