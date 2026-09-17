/**
 * Verifies the resume pipeline's pure parts: Markdown -> HTML/DOCX rendering,
 * and DOCX -> text extraction.
 *
 * The DOCX case is a genuine round trip rather than a snapshot - the document
 * this app generates is fed back through the same extractor it uses on an
 * imported resume. That catches the failure that actually matters: producing a
 * file that looks fine in Word but whose text a parser (ours, or an applicant
 * tracking system's) can't recover.
 *
 * PDF rendering isn't covered here: it runs on Chromium inside Electron, which
 * this plain-node harness can't start.
 *
 *   node scripts/run-check.mjs scripts/resume-check.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boldRuns, parseMarkdown, toDocxBuffer, toHtml } from '../src/core/resume/render'
import { extractResumeText, kindFromPath } from '../src/core/resume/extract'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

const SAMPLE = `# Ada Lovelace
ada@example.com · (555) 010-0100 · London

## Experience
**Analytical Engines Ltd** - Software Engineer Intern (2025)
- Built a **note-taking** system in Python that cut manual entry by 40%
- Wrote the first published algorithm for a general-purpose machine

## Education
University of London - BS Mathematics

## Skills
Python, TypeScript, C++`

async function main(): Promise<void> {
  console.log('\n[markdown parsing]')
  const blocks = parseMarkdown(SAMPLE)
  check('h1 is the name', blocks[0]?.type === 'h1' && blocks[0].text === 'Ada Lovelace')
  check('section headings parse', blocks.some((b) => b.type === 'h2' && b.text === 'Experience'))
  check('bullets parse', blocks.filter((b) => b.type === 'bullet').length === 2)
  check('plain lines survive', blocks.some((b) => b.type === 'text' && b.text.includes('ada@example.com')))
  check('blank lines are dropped', blocks.every((b) => b.text.trim() !== ''))

  console.log('\n[bold runs]')
  const runs = boldRuns('Built a **note-taking** system')
  check('splits into three runs', runs.length === 3, String(runs.length))
  check('marks only the middle bold', runs[1]?.bold === true && runs[0]?.bold === false)
  check('strips the asterisks', runs[1]?.text === 'note-taking', runs[1]?.text)

  console.log('\n[html rendering]')
  const html = toHtml(SAMPLE)
  check('emits a full document', html.startsWith('<!doctype html>'))
  check('bullets become list items', (html.match(/<li>/g) ?? []).length === 2)
  check('lists are closed', (html.match(/<ul>/g) ?? []).length === (html.match(/<\/ul>/g) ?? []).length)
  check('bold becomes <strong>', html.includes('<strong>note-taking</strong>'))
  check('sets physical page margins', html.includes('@page'))
  check(
    'escapes HTML rather than injecting it',
    toHtml('# <script>alert(1)</script>').includes('&lt;script&gt;')
  )

  console.log('\n[docx round trip: generate -> extract]')
  const dir = await mkdtemp(join(tmpdir(), 'cw-resume-check-'))
  try {
    const docxPath = join(dir, 'resume.docx')
    const buf = await toDocxBuffer(SAMPLE)
    await writeFile(docxPath, buf)

    // A .docx is a zip; every real one starts with the local file header.
    check('produces a real docx (zip) file', buf.subarray(0, 2).toString() === 'PK', buf.subarray(0, 2).toString())
    check('file kind is detected from the extension', kindFromPath(docxPath) === 'docx')

    const { kind, text } = await extractResumeText(docxPath)
    check('extracts as docx', kind === 'docx')
    check('name survives the round trip', text.includes('Ada Lovelace'))
    check('section headings survive', /EXPERIENCE/i.test(text))
    check('bullet text survives', text.includes('Wrote the first published algorithm'))
    check('bold text survives unmarked', text.includes('note-taking'))
    check('contact line survives', text.includes('ada@example.com'))
    check('skills survive', text.includes('TypeScript'))

    console.log('\n[extraction guards]')
    const emptyPath = join(dir, 'empty.txt')
    await writeFile(emptyPath, 'too short to be a resume')
    let refused = false
    try {
      await extractResumeText(emptyPath)
    } catch {
      refused = true
    }
    check('refuses a file with almost no text', refused)

    const bogusPath = join(dir, 'resume.rtf')
    await writeFile(bogusPath, 'x')
    let rejected = false
    try {
      await extractResumeText(bogusPath)
    } catch {
      rejected = true
    }
    check('rejects an unsupported format', rejected)
    check('unsupported extensions have no kind', kindFromPath(bogusPath) === null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('resume check crashed:', err)
  process.exit(1)
})
