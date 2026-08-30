import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'

/**
 * Auth.js handles the browser-facing OAuth dance with Google. On first
 * sign-in we trade the Google ID token for a Career Watch bearer token by
 * calling the Worker's own /api/auth/google (which re-verifies the ID token
 * server-side via JWKS - the Worker never trusts this app's say-so about who
 * signed in, only Google's signature).
 *
 * The resulting Career Watch token lives ONLY in the encrypted JWT cookie
 * (via the `jwt` callback below), never in the `session` object returned to
 * client components - `useSession()` on the client can see the user's name/
 * email/picture but never the bearer token. Server-side API routes read it
 * back out with `getToken()` (see api/cw/[...path]/route.ts), so the raw
 * per-user Worker token never reaches client-side JS.
 */

const WORKER_URL = process.env.CAREER_WATCH_WORKER_URL ?? 'http://127.0.0.1:8787'

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, account }) {
      // account is only present on the initial sign-in request, not on
      // subsequent session reads - that's what makes this a one-time exchange
      // rather than a re-verification on every request.
      if (account?.id_token) {
        try {
          const res = await fetch(`${WORKER_URL}/api/auth/google`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ idToken: account.id_token })
          })
          if (res.ok) {
            const body = (await res.json()) as { token: string; user: { id: number } }
            token.cwToken = body.token
            token.cwUserId = body.user.id
          } else {
            token.cwError = `worker auth failed: HTTP ${res.status}`
          }
        } catch (err) {
          token.cwError = `worker unreachable: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      return token
    },
    async session({ session, token }) {
      // Deliberately NOT copying token.cwToken here - see the note above.
      if (token.cwError) session.cwError = token.cwError as string
      return session
    }
  }
})
