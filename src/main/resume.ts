import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CHANNELS } from '@shared/ipc'
import type { TailorRequest, TailorSummary, UiProfile, UiResume, UiTailored } from '@shared/ipc'
import { getDb } from './db/index'
import { getSettings, setSettings } from './db/settings'
import { getSecret, setSecret } from './secrets'
import {
  addResume, addTailored, deleteAnswer, deleteResume, deleteTailored, getProfile, getResume,
  getTailored, listAnswers, listResumes, listTailored, saveAnswer, saveProfile,
  setDefaultResume, setTailoredExport, type TailoredRow
} from './db/profile'
import { extractResumeText } from '../core/resume/extract'
import { tailorResume } from '../core/resume/tailor'
import { toDocxBuffer, toHtml } from '../core/resume/render'

/**
 * Resume tailoring, kept entirely on this machine.
 *
 * The resume, the profile and the model key never touch the shared Worker:
 * this is the most personal data the app handles, the work only needs to
 * happen where the application gets filled in, and routing it through the
 * server would spend one shared model budget on every user's resume.
 */

const safeName = (s: string): string => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60)

function toUiTailored(row: TailoredRow): UiTailored {
  const parse = (raw: string): string[] => {
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? (v as string[]) : []
    } catch {
      return []
    }
  }
  return {
    id: row.id, resumeId: row.resumeId, postingId: row.postingId, companyName: row.companyName,
    jobTitle: row.jobTitle, jobUrl: row.jobUrl, markdown: row.markdown,
    changes: parse(row.changes), gaps: parse(row.gaps),
    pdfPath: row.pdfPath, docxPath: row.docxPath, createdAt: row.createdAt
  }
}

/**
 * Chromium renders the PDF - the same engine this app already is, so there's
 * no PDF library to ship. The window is offscreen and loads a local file we
 * just wrote, with scripts and remote content disabled.
 */
async function renderPdf(html: string): Promise<Buffer> {
  const tmp = join(app.getPath('temp'), `career-watch-resume-${Date.now()}.html`)
  await writeFile(tmp, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, javascript: false, images: false }
  })
  try {
    await win.loadFile(tmp)
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { marginType: 'none' }
    })
  } finally {
    win.destroy()
  }
}

export function registerResumeIpc(): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, async (_e, ...args) => fn(...(args as never[])))
  }

  /* ---------------------------------------------------------------- profile */

  handle(CHANNELS.getProfile, (): UiProfile => {
    const db = getDb()
    const s = getSettings(db)
    return {
      fields: getProfile(db),
      answers: listAnswers(db),
      llmBaseUrl: s.llmBaseUrl,
      llmModel: s.llmModel,
      hasLlmKey: getSecret('llmApiKey') !== null
    }
  })

  handle(CHANNELS.saveProfile, (patch: Record<string, string>) => {
    saveProfile(getDb(), patch)
  })

  handle(CHANNELS.saveAnswer, (question: string, answer: string) => {
    saveAnswer(getDb(), question, answer)
  })

  handle(CHANNELS.deleteAnswer, (question: string) => {
    deleteAnswer(getDb(), question)
  })

  handle(CHANNELS.saveTailorConfig, (cfg: { baseUrl?: string; model?: string; apiKey?: string }) => {
    const patch: { llmBaseUrl?: string; llmModel?: string } = {}
    if (cfg.baseUrl !== undefined) patch.llmBaseUrl = cfg.baseUrl.trim()
    if (cfg.model !== undefined) patch.llmModel = cfg.model.trim()
    if (Object.keys(patch).length) setSettings(getDb(), patch)
    // An empty string clears the key rather than storing a blank one.
    if (cfg.apiKey !== undefined) setSecret('llmApiKey', cfg.apiKey.trim() || null)
  })

  /* ---------------------------------------------------------------- resumes */

  handle(CHANNELS.listResumes, (): UiResume[] =>
    listResumes(getDb()).map((r) => ({
      id: r.id, label: r.label, kind: r.kind, isDefault: r.isDefault === 1,
      createdAt: r.createdAt, textLength: r.text.length
    }))
  )

  handle(CHANNELS.importResume, async (): Promise<{ ok: boolean; id?: number; error?: string }> => {
    const res = await dialog.showOpenDialog({
      title: 'Import your resume',
      properties: ['openFile'],
      filters: [{ name: 'Resume', extensions: ['pdf', 'docx', 'txt', 'md'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false }

    const path = res.filePaths[0]
    try {
      const { kind, text } = await extractResumeText(path)
      const id = addResume(getDb(), { label: basename(path), kind, sourcePath: path, text })
      return { ok: true, id }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(CHANNELS.setDefaultResume, (id: number) => setDefaultResume(getDb(), id))
  handle(CHANNELS.deleteResume, (id: number) => deleteResume(getDb(), id))

  /* --------------------------------------------------------------- tailoring */

  handle(CHANNELS.listTailored, (): UiTailored[] => listTailored(getDb()).map(toUiTailored))
  handle(CHANNELS.deleteTailored, (id: number) => deleteTailored(getDb(), id))

  handle(CHANNELS.tailorResume, async (req: TailorRequest): Promise<TailorSummary> => {
    const db = getDb()
    const apiKey = getSecret('llmApiKey')
    if (!apiKey) {
      return { ok: false, error: 'Add a model API key in Settings first - tailoring runs on your own key.' }
    }

    const resumes = listResumes(db)
    const resume = req.resumeId
      ? getResume(db, req.resumeId)
      : (resumes.find((r) => r.isDefault === 1) ?? resumes[0] ?? null)
    if (!resume) return { ok: false, error: 'Import a resume first.' }

    if (!req.jobDescription?.trim()) {
      // Tailoring against an empty description would just reformat the resume
      // while implying it had been targeted - worse than refusing.
      return { ok: false, error: 'This posting has no description saved, so there is nothing to tailor against.' }
    }

    const s = getSettings(db)
    try {
      const result = await tailorResume(
        {
          resumeText: resume.text,
          jobTitle: req.jobTitle,
          companyName: req.companyName,
          jobDescription: req.jobDescription
        },
        { apiKey, baseUrl: s.llmBaseUrl, model: s.llmModel }
      )

      const id = addTailored(db, {
        resumeId: resume.id,
        postingId: req.postingId ?? null,
        companyName: req.companyName,
        jobTitle: req.jobTitle,
        jobUrl: req.jobUrl ?? null,
        markdown: result.markdown,
        changes: result.changes,
        gaps: result.gaps
      })

      const row = getTailored(db, id)
      return { ok: true, tailored: row ? toUiTailored(row) : undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /* ---------------------------------------------------------------- exports */

  handle(
    CHANNELS.exportTailored,
    async (id: number, formats: ('pdf' | 'docx')[]): Promise<{ ok: boolean; paths?: string[]; error?: string }> => {
      const db = getDb()
      const row = getTailored(db, id)
      if (!row) return { ok: false, error: 'That tailored resume no longer exists.' }

      const suggested = `${safeName(row.companyName)}-${safeName(row.jobTitle)}-resume`
      const dir = await dialog.showOpenDialog({
        title: 'Where should the tailored resume go?',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: app.getPath('documents')
      })
      if (dir.canceled || !dir.filePaths[0]) return { ok: false }

      try {
        const written: string[] = []
        for (const format of formats) {
          const path = join(dir.filePaths[0], `${suggested}.${format}`)
          const data = format === 'pdf' ? await renderPdf(toHtml(row.markdown)) : await toDocxBuffer(row.markdown)
          await writeFile(path, data)
          setTailoredExport(db, id, format, path)
          written.push(path)
        }
        if (written[0]) shell.showItemInFolder(written[0])
        return { ok: true, paths: written }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
