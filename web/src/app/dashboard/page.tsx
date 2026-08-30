import { redirect } from 'next/navigation'
import { auth, signOut } from '@/auth'
import Dashboard from './Dashboard'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user) redirect('/')

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Career Watch</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <span>{session.user.email}</span>
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/' })
            }}
          >
            <button type="submit" className="rounded-md border border-neutral-700 px-3 py-1 hover:bg-neutral-900">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {session.cwError ? (
        <p className="mx-6 mt-4 rounded-md border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-200">
          Couldn&apos;t link this sign-in to Career Watch: {session.cwError}
        </p>
      ) : (
        <Dashboard />
      )}
    </main>
  )
}
