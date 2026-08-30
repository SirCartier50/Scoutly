import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth, signIn } from '@/auth'

export default async function Home() {
  const session = await auth()
  if (session?.user) redirect('/dashboard')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 px-4 text-neutral-50">
      <div className="max-w-sm text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Career Watch</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Watches company career pages for internships, new-grad roles, and fellowships -
          straight from the source, not a job board.
        </p>
      </div>
      <form
        action={async () => {
          'use server'
          await signIn('google', { redirectTo: '/dashboard' })
        }}
      >
        <button
          type="submit"
          className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200"
        >
          Continue with Google
        </button>
      </form>
      <Link href="/download" className="text-sm text-neutral-400 underline hover:text-neutral-200">
        Prefer the desktop app? Download for Windows
      </Link>
    </main>
  )
}
