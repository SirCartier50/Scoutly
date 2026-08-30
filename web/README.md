# Career Watch — web

Browser client for [Career Watch](../). Next.js (App Router) + Auth.js, talking to
the Cloudflare Worker backend in [`../server`](../server) over HTTP.

## Architecture

- Sign-in is Google OAuth via Auth.js. On first sign-in, the Google ID token is
  traded for a Career Watch bearer token by calling the Worker's
  `POST /api/auth/google` (which independently re-verifies the ID token via
  Google's JWKS - this app's say-so is never trusted on its own).
- That bearer token lives **only** in the encrypted session JWT, server-side.
  It is never included in the `Session` object handed to client components, so
  it's never visible to browser JS.
- Every `/api/cw/*` request from the browser is proxied through
  `src/app/api/cw/[...path]/route.ts`, which reads the token back out
  server-side (via `getToken()`) and attaches it as the `Authorization` header
  on the real request to the Worker.

## Local dev

```bash
cp .env.example .env.local
# fill in AUTH_SECRET (npx auth secret), AUTH_GOOGLE_ID/SECRET from
# https://console.cloud.google.com/apis/credentials, and CAREER_WATCH_WORKER_URL
npm install
npm run dev
```

Run the Worker locally alongside it (from the repo root):

```bash
npm run server:dev
```

Google OAuth redirect URI for local dev: `http://localhost:3000/api/auth/callback/google`.

## Deploying (Vercel)

1. Import this repo into Vercel, set the **root directory** to `web/`.
2. Set the same env vars as `.env.example` as Vercel project env vars
   (`AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
   `CAREER_WATCH_WORKER_URL` pointing at the deployed Worker).
3. Add the production callback URL in Google Cloud Console:
   `https://<your-vercel-domain>/api/auth/callback/google`.
4. Set `GOOGLE_CLIENT_ID` as a Worker secret too
   (`wrangler secret put GOOGLE_CLIENT_ID --config ../server/wrangler.toml`) -
   it verifies the token's audience independently of this app.
