import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/**
 * Resume file -> plain text.
 *
 * PDF and DOCX are both supported because people keep their resume in one or
 * the other and shouldn't have to convert it by hand. Extraction happens once,
 * at import: every tailoring run needs the text, and re-parsing a PDF each
 * time is slow enough to feel broken.
 */

export type ResumeKind = 'pdf' | 'docx' | 'text'

export function kindFromPath(path: string): ResumeKind | null {
  switch (extname(path).toLowerCase()) {
    case '.pdf': return 'pdf'
    case '.docx': return 'docx'
    case '.txt':
    case '.md': return 'text'
    default: return null
  }
}

/**
 * pdfjs positions every text run separately, so a naive join runs whole
 * sections together. `hasEOL` is what the library reports for an actual line
 * break, which keeps bullets on their own lines - and a resume's meaning is
 * mostly carried by its line structure.
 */
async function fromPdf(path: string): Promise<string> {
  // Legacy build: the modern one assumes browser APIs that Electron's main
  // process (plain Node) doesn't have.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path))
  // No worker thread, no remote font fetching, no logging - this runs in the
  // main process, so it stays as inert as possible.
  const task = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0
  })
  const doc = await task.promise

  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items) {
      if (!('str' in item)) continue
      text += item.str
      if (item.hasEOL) text += '\n'
      else if (item.str && !item.str.endsWith(' ')) text += ' '
    }
    pages.push(text)
  }
  await task.destroy()
  return pages.join('\n\n')
}

async function fromDocx(path: string): Promise<string> {
  const mammoth = await import('mammoth')
  const { value } = await mammoth.extractRawText({ path })
  return value
}

/** Collapses the ragged whitespace both extractors produce. */
function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function extractResumeText(path: string): Promise<{ kind: ResumeKind; text: string }> {
  const kind = kindFromPath(path)
  if (!kind) throw new Error(`unsupported resume format: ${extname(path) || path}`)

  const raw =
    kind === 'pdf' ? await fromPdf(path)
    : kind === 'docx' ? await fromDocx(path)
    : await readFile(path, 'utf8')

  const text = tidy(raw)
  if (text.length < 100) {
    // Almost always a scanned/image-only PDF. Saying so beats storing an empty
    // resume that silently tailors into nothing.
    throw new Error(
      'Could not read any text from that file. If it is a scanned PDF, export a text-based copy and try again.'
    )
  }
  return { kind, text }
}
