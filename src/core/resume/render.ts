/**
 * Renders the tailored Markdown to the two formats people actually upload.
 *
 * Both renderers understand the same small subset the tailoring prompt is
 * restricted to (h1, h2, bullets, bold, plain lines). Keeping the subset
 * narrow is what lets a PDF and a DOCX come out looking like the same
 * document rather than two loose interpretations.
 */

export interface MarkdownBlock {
  type: 'h1' | 'h2' | 'bullet' | 'text'
  text: string
}

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('## ')) blocks.push({ type: 'h2', text: line.slice(3).trim() })
    else if (line.startsWith('# ')) blocks.push({ type: 'h1', text: line.slice(2).trim() })
    else if (/^[-*]\s+/.test(line)) blocks.push({ type: 'bullet', text: line.replace(/^[-*]\s+/, '') })
    else blocks.push({ type: 'text', text: line })
  }
  return blocks
}

/** Splits on **bold** so each renderer can style the runs its own way. */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('**') && part.endsWith('**')
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false }
    )
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const inlineHtml = (text: string): string =>
  boldRuns(text)
    .map((r) => (r.bold ? `<strong>${escapeHtml(r.text)}</strong>` : escapeHtml(r.text)))
    .join('')

/**
 * A print stylesheet, not a screen one: physical page margins, points rather
 * than pixels, and `page-break-after: avoid` on headings so a section title
 * can't end up stranded alone at the bottom of a page.
 */
export function toHtml(markdown: string): string {
  const blocks = parseMarkdown(markdown)
  const parts: string[] = []
  let inList = false

  for (const b of blocks) {
    if (b.type === 'bullet' && !inList) { parts.push('<ul>'); inList = true }
    if (b.type !== 'bullet' && inList) { parts.push('</ul>'); inList = false }

    if (b.type === 'h1') parts.push(`<h1>${inlineHtml(b.text)}</h1>`)
    else if (b.type === 'h2') parts.push(`<h2>${inlineHtml(b.text)}</h2>`)
    else if (b.type === 'bullet') parts.push(`<li>${inlineHtml(b.text)}</li>`)
    else parts.push(`<p>${inlineHtml(b.text)}</p>`)
  }
  if (inList) parts.push('</ul>')

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { margin: 0.6in; }
  body { font-family: Calibri, Carlito, Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: 0.2pt; }
  h2 { font-size: 11pt; margin: 12pt 0 4pt; text-transform: uppercase; letter-spacing: 0.6pt;
       border-bottom: 0.75pt solid #999; padding-bottom: 2pt; page-break-after: avoid; }
  p { margin: 2pt 0; }
  ul { margin: 2pt 0 2pt 16pt; padding: 0; }
  li { margin: 1.5pt 0; }
  strong { font-weight: 600; }
</style></head><body>
${parts.join('\n')}
</body></html>`
}

/**
 * Built with the `docx` package rather than by renaming an HTML file: real
 * applicant tracking systems parse .docx XML, and a mislabelled HTML file
 * either fails upload or parses into gibberish.
 */
export async function toDocxBuffer(markdown: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle, AlignmentType } = await import('docx')

  const children = parseMarkdown(markdown).map((b) => {
    const runs = boldRuns(b.text).map((r) => new TextRun({ text: r.text, bold: r.bold }))

    if (b.type === 'h1') {
      return new Paragraph({
        children: boldRuns(b.text).map((r) => new TextRun({ text: r.text, bold: true, size: 40 })),
        alignment: AlignmentType.LEFT,
        spacing: { after: 40 }
      })
    }
    if (b.type === 'h2') {
      return new Paragraph({
        children: boldRuns(b.text).map((r) => new TextRun({ text: r.text.toUpperCase(), bold: true, size: 22 })),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 80 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } }
      })
    }
    if (b.type === 'bullet') {
      return new Paragraph({ children: runs, bullet: { level: 0 }, spacing: { after: 30 } })
    }
    return new Paragraph({ children: runs, spacing: { after: 40 } })
  })

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 864, right: 864, bottom: 864, left: 864 } } }, children }]
  })

  return Buffer.from(await Packer.toBuffer(doc))
}
