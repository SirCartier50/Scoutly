import Link from 'next/link'

// Matches electron-builder.yml's `artifactName` - kept version-free so this
// link never breaks across releases. GitHub serves /releases/latest/download/
// as a redirect to whatever asset with this exact name is on the newest
// published release.
const REPO = 'SirCartier50/Scoutly'
const INSTALLER_URL = `https://github.com/${REPO}/releases/latest/download/Career-Watch-Setup.exe`
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

export default function DownloadPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 px-4 text-center text-neutral-50">
      <div className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Career Watch for Windows</h1>
        <p className="mt-2 text-sm text-neutral-400">
          The desktop app watches career pages in the background and puts a native
          notification on your screen the moment something new opens. Sign in on the{' '}
          <Link href="/" className="underline hover:text-neutral-200">web dashboard</Link>{' '}
          first to get your personal access token, then paste it into the desktop
          app&apos;s Settings.
        </p>
      </div>

      <a
        href={INSTALLER_URL}
        className="rounded-full bg-white px-6 py-3 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200"
      >
        Download for Windows (.exe)
      </a>

      <p className="text-xs text-neutral-500">
        Windows only for now.{' '}
        <a href={RELEASES_URL} className="underline hover:text-neutral-300">
          See all releases
        </a>{' '}
        for release notes or older versions.
      </p>
    </main>
  )
}
