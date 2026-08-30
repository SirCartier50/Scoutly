import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * Verifies a Google Sign-In ID token server-side, so the web app's client-side
 * JS is never trusted to assert who the user is - only Google's own signature
 * over the token is. `jose`'s remote JWKS set caches Google's public keys and
 * re-fetches them only on a `kid` miss, which is what keeps this fast on the
 * hot path without hammering Google on every login.
 */
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

export interface GoogleIdentity {
  sub: string
  email: string
  name: string | null
  picture: string | null
}

export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId
  })

  const sub = payload.sub
  const email = payload.email as string | undefined
  if (!sub || !email) throw new Error('Google token missing sub/email')

  return {
    sub,
    email,
    name: (payload.name as string | undefined) ?? null,
    picture: (payload.picture as string | undefined) ?? null
  }
}
