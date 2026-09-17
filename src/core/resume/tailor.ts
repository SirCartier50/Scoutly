/**
 * Tailors a resume to one job description.
 *
 * The hard rule, stated in the prompt and reinforced by what the model is
 * allowed to return: it may reorder, re-emphasise and rewrite what is already
 * true, and it may drop things that don't matter for this role. It may never
 * invent an employer, a degree, a date, a metric or a skill. A resume that
 * claims something false is worse than no resume at all - it costs the user
 * the offer and their credibility, and they may not notice before sending it.
 *
 * Anything the job asks for that the resume does not support comes back as a
 * `gaps` note instead, which is honest and also genuinely useful: it tells the
 * user what to address in the questions or the cover letter.
 */

export interface TailorOptions {
  apiKey: string
  /** OpenAI-compatible endpoint. Groq's free tier is the default. */
  baseUrl?: string | null
  model?: string | null
}

export interface TailorInput {
  resumeText: string
  jobTitle: string
  companyName: string
  jobDescription: string
}

export interface TailorResult {
  markdown: string
  changes: string[]
  gaps: string[]
}

export const DEFAULT_TAILOR_BASE_URL = 'https://api.groq.com/openai/v1'
export const DEFAULT_TAILOR_MODEL = 'llama-3.3-70b-versatile'

/**
 * The output is a deliberately small Markdown subset (h1/h2, bullets, bold,
 * plain lines) because both exporters have to render it faithfully - a PDF via
 * Chromium and a DOCX via the docx package. Letting the model use arbitrary
 * Markdown would mean one of those two silently dropping formatting.
 */
const SYSTEM = `You tailor resumes to specific jobs. You are given the candidate's real resume and a job description.

ABSOLUTE RULES - breaking these makes the output useless:
- Never invent or embellish. No new employers, titles, dates, degrees, certifications, metrics or technologies.
- Every skill, tool and achievement in your output must be traceable to the original resume.
- Never change dates, employer names, job titles held, or degree names.
- You MAY: reorder sections and bullets, rewrite wording to use the job's vocabulary for things the candidate genuinely did, tighten or merge weak bullets, and drop content irrelevant to this role.
- If the job requires something the resume does not show, do NOT add it. Record it in "gaps".

OUTPUT FORMAT - reply with ONLY a JSON object:
{"markdown":"...","changes":["..."],"gaps":["..."]}

"markdown" is the full tailored resume using ONLY this subset:
# Name (first line)
Contact line as plain text directly under the name
## Section Heading
- bullet point
**bold** for emphasis inside a line
Plain lines for anything else. No tables, links, images, code blocks or nested lists.

"changes": short plain statements of what you changed and why, one per change (max 8).
"gaps": requirements in the job description the resume does not support (max 6). Empty array if none.`

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced?.[1] ?? raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('model did not return JSON')
  return JSON.parse(body.slice(start, end + 1))
}

const asStrings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max) : []

export async function tailorResume(input: TailorInput, opts: TailorOptions): Promise<TailorResult> {
  const base = (opts.baseUrl ?? DEFAULT_TAILOR_BASE_URL).replace(/\/+$/, '')
  const model = opts.model ?? DEFAULT_TAILOR_MODEL

  // Descriptions run long and the tail is usually boilerplate (benefits, EEO
  // statements); the requirements live near the top.
  const jd = input.jobDescription.slice(0, 12000)

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `JOB: ${input.jobTitle} at ${input.companyName}

JOB DESCRIPTION:
${jd}

CANDIDATE'S CURRENT RESUME:
${input.resumeText.slice(0, 16000)}`
        }
      ]
    })
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`tailoring failed: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 300)}` : ''}`)
  }

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('tailoring failed: empty response')

  const parsed = extractJson(content) as { markdown?: unknown; changes?: unknown; gaps?: unknown }
  const markdown = typeof parsed.markdown === 'string' ? parsed.markdown.trim() : ''
  if (markdown.length < 100) throw new Error('tailoring failed: model returned an empty resume')

  return {
    markdown,
    changes: asStrings(parsed.changes, 8),
    gaps: asStrings(parsed.gaps, 6)
  }
}
