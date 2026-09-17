import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UiPosting, UiProfile, UiResume, UiTailored } from '@shared/ipc'
import { Button, Card, Chip, Empty, TextField } from './ui'

/* =============================================================== Resume tab */

/**
 * Tailoring is its own step, deliberately separate from applying: the user
 * decides a resume is right for a job before anything touches an application
 * form. Once tailored, the app offers the hand-off rather than assuming it.
 *
 * Everything here stays on this machine - the resume text, the profile, and
 * the model key. None of it goes to the shared server.
 */
export function Resume(): JSX.Element {
  const [resumes, setResumes] = useState<UiResume[]>([])
  const [tailored, setTailored] = useState<UiTailored[]>([])
  const [postings, setPostings] = useState<UiPosting[]>([])
  const [profile, setProfile] = useState<UiProfile | null>(null)
  const [selectedPosting, setSelectedPosting] = useState<number | ''>('')
  const [selected, setSelected] = useState<UiTailored | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [r, t, p, pr] = await Promise.all([
      window.api.listResumes(),
      window.api.listTailored(),
      window.api.listPostings({ roleTypes: ['intern', 'newgrad', 'program'] }),
      window.api.getProfile()
    ])
    setResumes(r)
    setTailored(t)
    setPostings(p)
    setProfile(pr)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const importResume = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.api.importResume()
      if (res.error) setNote(res.error)
      else if (res.ok) setNote('Resume imported.')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const tailor = async (): Promise<void> => {
    const posting = postings.find((p) => p.id === selectedPosting)
    if (!posting) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.api.tailorResume({
        postingId: posting.id,
        companyName: posting.companyName,
        jobTitle: posting.title,
        jobUrl: posting.applyUrl,
        jobDescription: posting.description ?? ''
      })
      if (!res.ok || !res.tailored) {
        setNote(res.error ?? 'Tailoring failed.')
      } else {
        setSelected(res.tailored)
        setNote(null)
      }
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const exportAs = async (formats: ('pdf' | 'docx')[]): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      const res = await window.api.exportTailored(selected.id, formats)
      if (res.error) setNote(res.error)
      else if (res.ok && res.paths?.length) setNote(`Saved ${res.paths.length === 2 ? 'both files' : res.paths[0]}.`)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const needsKey = profile !== null && !profile.hasLlmKey

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="grid min-w-0 gap-5">
        <Card title="Your resume">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void importResume()} disabled={busy}>
              Import PDF or DOCX
            </Button>
            <span className="text-xs text-on-surface-variant">
              Read once on import. Scanned image-only PDFs can&apos;t be read.
            </span>
          </div>

          {resumes.length > 0 && (
            <ul className="mt-3 grid gap-1">
              {resumes.map((r) => (
                <li key={r.id} className="flex items-center gap-3 rounded-panel px-3 py-2 hover:bg-surface-container-high">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.label}</div>
                    <div className="truncate text-xs text-on-surface-variant">
                      {r.kind} · {Math.round(r.textLength / 1000)}k characters
                    </div>
                  </div>
                  {r.isDefault ? (
                    <Chip selected onClick={() => undefined}>default</Chip>
                  ) : (
                    <Button variant="text" onClick={() => void window.api.setDefaultResume(r.id).then(reload)}>
                      Make default
                    </Button>
                  )}
                  <Button variant="text" onClick={() => void window.api.deleteResume(r.id).then(reload)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Tailor to a job">
          {resumes.length === 0 ? (
            <Empty title="Import a resume first" hint="Tailoring rewrites your own resume - it never writes one from scratch." />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={selectedPosting}
                  onChange={(e) => setSelectedPosting(e.target.value === '' ? '' : Number(e.target.value))}
                  className="min-w-0 flex-1 rounded-pill border border-outline-variant bg-surface-container-low px-3 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
                >
                  <option value="">Pick a posting…</option>
                  {postings.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.companyName} — {p.title}
                    </option>
                  ))}
                </select>
                <Button onClick={() => void tailor()} disabled={busy || selectedPosting === '' || needsKey}>
                  {busy ? 'Tailoring…' : 'Tailor'}
                </Button>
              </div>
              {needsKey && (
                <p className="mt-2 text-xs text-warning">
                  Add a model API key below first — tailoring runs on your own key, on this machine.
                </p>
              )}
              <p className="mt-2 text-xs text-on-surface-variant">
                Rewrites and reorders what your resume already says to match the posting. It never adds a skill,
                employer, date or number that isn&apos;t already there — anything the job wants that you don&apos;t
                have is listed as a gap instead.
              </p>
            </>
          )}

          {note && <p className="mt-3 text-sm">{note}</p>}
        </Card>

        {tailored.length > 0 && (
          <Card title="Tailored versions">
            <ul className="grid gap-1">
              {tailored.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelected(t)}
                    className={`w-full rounded-panel px-3 py-2 text-left transition-colors ${
                      selected?.id === t.id ? 'bg-primary-container text-on-primary-container' : 'hover:bg-surface-container-high'
                    }`}
                  >
                    <div className="truncate text-sm font-medium">{t.jobTitle}</div>
                    <div className="truncate text-xs text-on-surface-variant">
                      {t.companyName}
                      {t.pdfPath ? ' · PDF saved' : ''}
                      {t.docxPath ? ' · DOCX saved' : ''}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <ProfileCard profile={profile} onSaved={reload} />
      </div>

      <Card title={selected ? 'Tailored resume' : undefined} className="h-fit lg:sticky lg:top-0">
        {selected ? (
          <div>
            <h3 className="break-words text-base font-semibold leading-snug">{selected.jobTitle}</h3>
            <p className="mt-1 break-words text-sm text-on-surface-variant">{selected.companyName}</p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => void exportAs(['pdf'])} disabled={busy}>PDF</Button>
              <Button variant="tonal" onClick={() => void exportAs(['docx'])} disabled={busy}>DOCX</Button>
              <Button variant="tonal" onClick={() => void exportAs(['pdf', 'docx'])} disabled={busy}>Both</Button>
            </div>

            {selected.gaps.length > 0 && (
              <div className="mt-4">
                <span className="mb-1 block text-xs font-medium text-warning">
                  What this job asks for that your resume doesn&apos;t show
                </span>
                <ul className="grid gap-1 text-xs text-on-surface-variant">
                  {selected.gaps.map((g, i) => (
                    <li key={i}>· {g}</li>
                  ))}
                </ul>
              </div>
            )}

            {selected.changes.length > 0 && (
              <div className="mt-4">
                <span className="mb-1 block text-xs font-medium text-on-surface-variant">What changed</span>
                <ul className="grid gap-1 text-xs text-on-surface-variant">
                  {selected.changes.map((c, i) => (
                    <li key={i}>· {c}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 rounded-panel bg-surface-container-low p-3">
              <span className="mb-1 block text-xs text-on-surface-variant">Preview</span>
              <pre className="max-h-[38vh] overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
                {selected.markdown}
              </pre>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <Button
                onClick={() => void (selected.jobUrl && window.api.openExternal(selected.jobUrl))}
                disabled={!selected.jobUrl}
              >
                Apply now
              </Button>
              <span className="text-xs text-on-surface-variant">
                Opens the posting. Automatic form filling is the next piece.
              </span>
            </div>
          </div>
        ) : (
          <Empty title="No tailored resume selected" hint="Tailor one, or pick an earlier version to export again." />
        )}
      </Card>
    </div>
  )
}

/* ================================================================= profile */

const FIELD_LABELS: [string, string][] = [
  ['fullName', 'Full name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['city', 'City'],
  ['state', 'State / region'],
  ['country', 'Country'],
  ['linkedin', 'LinkedIn'],
  ['github', 'GitHub'],
  ['portfolio', 'Portfolio']
]

/**
 * The questions essentially every application asks. Stored once and reused so
 * they are answered on the user's terms, in their own time - not hurried
 * through mid-application. "Prefer not to say" is a real answer on every one
 * of them, which is why it's always an option here.
 */
const DEMOGRAPHIC_FIELDS: [string, string, string[]][] = [
  ['workAuthorized', 'Authorized to work in the US', ['Yes', 'No']],
  ['needsSponsorship', 'Will need visa sponsorship', ['Yes', 'No']],
  ['gender', 'Gender', ['Male', 'Female', 'Non-binary', 'Prefer not to say']],
  [
    'ethnicity',
    'Race / ethnicity',
    ['Asian', 'Black or African American', 'Hispanic or Latino', 'Native American or Alaska Native',
     'Native Hawaiian or Pacific Islander', 'White', 'Two or more races', 'Prefer not to say']
  ],
  ['veteranStatus', 'Veteran status', ['I am not a protected veteran', 'I identify as a protected veteran', 'Prefer not to say']],
  ['disabilityStatus', 'Disability status', ['No', 'Yes', 'Prefer not to say']]
]

function ProfileCard({ profile, onSaved }: { profile: UiProfile | null; onSaved: () => Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!profile) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(profile.fields)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBaseUrl(profile.llmBaseUrl)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModel(profile.llmModel)
  }, [profile])

  if (!profile) return <Card title="Profile"><Empty title="Loading…" /></Card>

  const set = (key: string, value: string): void => setDraft((d) => ({ ...d, [key]: value }))

  const saveFields = async (): Promise<void> => {
    await window.api.saveProfile(draft)
    setNote('Profile saved.')
    await onSaved()
  }

  const saveTailorConfig = async (): Promise<void> => {
    await window.api.saveTailorConfig({
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {})
    })
    setApiKey('')
    setNote('Tailoring setup saved.')
    await onSaved()
  }

  return (
    <>
      <Card title="Application profile">
        <p className="mb-3 text-xs text-on-surface-variant">
          What forms ask for every time. Stored only on this computer, and editable whenever you want.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {FIELD_LABELS.map(([key, label]) => (
            <TextField key={key} label={label} value={draft[key] ?? ''} onChange={(v) => set(key, v)} />
          ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {DEMOGRAPHIC_FIELDS.map(([key, label, options]) => (
            <label key={key} className="grid gap-1">
              <span className="px-1 text-xs text-on-surface-variant">{label}</span>
              <select
                value={draft[key] ?? ''}
                onChange={(e) => set(key, e.target.value)}
                className="rounded-panel border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
              >
                <option value="">—</option>
                {options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <Button className="mt-4" onClick={() => void saveFields()}>Save profile</Button>

        {profile.answers.length > 0 && (
          <div className="mt-5">
            <span className="mb-1 block text-xs text-on-surface-variant">
              Answers saved from earlier applications
            </span>
            <ul className="grid gap-1">
              {profile.answers.map((a) => (
                <li key={a.question} className="flex items-center gap-3 rounded-panel px-3 py-2 text-sm hover:bg-surface-container-high">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{a.question}</div>
                    <div className="truncate text-xs text-on-surface-variant">{a.answer}</div>
                  </div>
                  <Button variant="text" onClick={() => void window.api.deleteAnswer(a.question).then(onSaved)}>
                    Forget
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Tailoring setup">
        <p className="mb-3 text-xs text-on-surface-variant">
          Tailoring runs on your own model key, from this machine — your resume never goes to the Career Watch
          server. Any OpenAI-compatible endpoint works; Groq&apos;s free tier is the default.
        </p>
        <div className="grid gap-3">
          <label className="grid gap-1">
            <span className="px-1 text-xs text-on-surface-variant">
              API key {profile.hasLlmKey ? '(saved — type to replace)' : '(required)'}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={profile.hasLlmKey ? '••••••••' : 'gsk_…'}
              className="rounded-panel border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
            />
          </label>
          <TextField label="Endpoint" value={baseUrl} onChange={setBaseUrl} />
          <TextField label="Model" value={model} onChange={setModel} />
          <Button onClick={() => void saveTailorConfig()}>Save tailoring setup</Button>
        </div>
        {note && <p className="mt-3 text-sm">{note}</p>}
      </Card>
    </>
  )
}
