import type { DatabaseSync } from 'node:sqlite'

/**
 * Everything an application form asks for that isn't the resume itself.
 *
 * Deliberately local-only, like the resume text: this is the most personal
 * data the app touches (demographics, work authorization), it is needed only
 * on the machine that fills the form, and the server has no use for it. The
 * shared Worker never sees any of it.
 */

/** The fields every application form asks for, in the order the UI shows them. */
export const PROFILE_FIELDS = [
  'fullName', 'email', 'phone', 'city', 'state', 'country',
  'linkedin', 'github', 'portfolio',
  'workAuthorized', 'needsSponsorship',
  'gender', 'ethnicity', 'veteranStatus', 'disabilityStatus'
] as const

export type ProfileField = (typeof PROFILE_FIELDS)[number]
export type Profile = Partial<Record<ProfileField, string>>

const now = (): string => new Date().toISOString()

export function getProfile(db: DatabaseSync): Profile {
  const rows = db.prepare('SELECT key, value FROM profile').all() as { key: string; value: string }[]
  const out: Profile = {}
  for (const r of rows) {
    if ((PROFILE_FIELDS as readonly string[]).includes(r.key)) out[r.key as ProfileField] = r.value
  }
  return out
}

export function saveProfile(db: DatabaseSync, patch: Profile): void {
  const stmt = db.prepare(
    `INSERT INTO profile (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  const ts = now()
  for (const [k, v] of Object.entries(patch)) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(k)) continue
    stmt.run(k, v ?? '', ts)
  }
}

/* ------------------------------------------------------------------ answers */

export interface SavedAnswer {
  question: string
  answer: string
  updatedAt: string
}

/**
 * The long tail: "willing to relocate?", "preferred location", "how did you
 * hear about us". Stored on first answer and reused, so the question is asked
 * once rather than once per application.
 */
export function listAnswers(db: DatabaseSync): SavedAnswer[] {
  return db
    .prepare('SELECT question, answer, updated_at AS updatedAt FROM profile_answers ORDER BY question')
    .all() as unknown as SavedAnswer[]
}

export function saveAnswer(db: DatabaseSync, question: string, answer: string): void {
  db.prepare(
    `INSERT INTO profile_answers (question, answer, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(question) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`
  ).run(question.trim(), answer, now())
}

export function deleteAnswer(db: DatabaseSync, question: string): void {
  db.prepare('DELETE FROM profile_answers WHERE question = ?').run(question)
}

/* ------------------------------------------------------------------ resumes */

export interface ResumeRow {
  id: number
  label: string
  kind: string
  sourcePath: string | null
  text: string
  isDefault: number
  createdAt: string
}

export function listResumes(db: DatabaseSync): ResumeRow[] {
  return db
    .prepare(
      `SELECT id, label, kind, source_path AS sourcePath, text, is_default AS isDefault,
              created_at AS createdAt
       FROM resumes ORDER BY is_default DESC, created_at DESC`
    )
    .all() as unknown as ResumeRow[]
}

export function getResume(db: DatabaseSync, id: number): ResumeRow | null {
  const row = db
    .prepare(
      `SELECT id, label, kind, source_path AS sourcePath, text, is_default AS isDefault,
              created_at AS createdAt
       FROM resumes WHERE id = ?`
    )
    .get(id) as unknown as ResumeRow | undefined
  return row ?? null
}

export function addResume(
  db: DatabaseSync,
  r: { label: string; kind: string; sourcePath: string | null; text: string }
): number {
  // The first resume imported becomes the default, so a single-resume user
  // never has to think about the concept at all.
  const count = (db.prepare('SELECT COUNT(*) AS n FROM resumes').get() as { n: number }).n
  const res = db
    .prepare(
      `INSERT INTO resumes (label, kind, source_path, text, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(r.label, r.kind, r.sourcePath, r.text, count === 0 ? 1 : 0, now())
  return Number(res.lastInsertRowid)
}

export function setDefaultResume(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE resumes SET is_default = 0').run()
  db.prepare('UPDATE resumes SET is_default = 1 WHERE id = ?').run(id)
}

export function deleteResume(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM resumes WHERE id = ?').run(id)
}

/* ---------------------------------------------------------------- tailored */

export interface TailoredRow {
  id: number
  resumeId: number
  postingId: number | null
  companyName: string
  jobTitle: string
  jobUrl: string | null
  markdown: string
  changes: string
  gaps: string
  pdfPath: string | null
  docxPath: string | null
  createdAt: string
}

const TAILORED_COLUMNS = `id, resume_id AS resumeId, posting_id AS postingId,
  company_name AS companyName, job_title AS jobTitle, job_url AS jobUrl, markdown,
  changes, gaps, pdf_path AS pdfPath, docx_path AS docxPath, created_at AS createdAt`

export function listTailored(db: DatabaseSync): TailoredRow[] {
  return db
    .prepare(`SELECT ${TAILORED_COLUMNS} FROM tailored_resumes ORDER BY created_at DESC LIMIT 100`)
    .all() as unknown as TailoredRow[]
}

export function getTailored(db: DatabaseSync, id: number): TailoredRow | null {
  const row = db
    .prepare(`SELECT ${TAILORED_COLUMNS} FROM tailored_resumes WHERE id = ?`)
    .get(id) as unknown as TailoredRow | undefined
  return row ?? null
}

export function addTailored(
  db: DatabaseSync,
  t: {
    resumeId: number
    postingId: number | null
    companyName: string
    jobTitle: string
    jobUrl: string | null
    markdown: string
    changes: string[]
    gaps: string[]
  }
): number {
  const res = db
    .prepare(
      `INSERT INTO tailored_resumes
         (resume_id, posting_id, company_name, job_title, job_url, markdown, changes, gaps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.resumeId, t.postingId, t.companyName, t.jobTitle, t.jobUrl, t.markdown,
      JSON.stringify(t.changes), JSON.stringify(t.gaps), now()
    )
  return Number(res.lastInsertRowid)
}

export function setTailoredExport(db: DatabaseSync, id: number, kind: 'pdf' | 'docx', path: string): void {
  db.prepare(`UPDATE tailored_resumes SET ${kind === 'pdf' ? 'pdf_path' : 'docx_path'} = ? WHERE id = ?`).run(path, id)
}

export function deleteTailored(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM tailored_resumes WHERE id = ?').run(id)
}
