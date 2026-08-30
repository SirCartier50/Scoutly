import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer'

/**
 * Real Chromium, reserved for the one case a plain fetch cannot solve: a
 * career page whose job data only exists after its own JavaScript runs (a
 * single-page app calling an internal API on load). This is exactly how
 * Amazon's and Microsoft's dedicated connectors were found by hand - open the
 * real page, watch what it actually requests, replay that request headlessly
 * forever after. This module automates the "watch what it requests" step.
 *
 * Deliberately never used by the recurring hourly check: it's slow (seconds,
 * not milliseconds), metered (free tier is 10 browser-minutes/day), and only
 * relevant once per company, at onboarding - not on a schedule.
 */

export interface CapturedCall {
  url: string
  method: string
  status: number
  contentType: string
  /** Truncated; enough for a model to recognize a job-listing shape. */
  bodySnippet: string
}

const JOB_HINT = /job|career|posting|position|opening|requisition|search|listing/i

/**
 * Loads a page with a real browser and records every XHR/fetch response that
 * looks like it might carry job data - JSON or a paginated API shape, with a
 * URL or body suggestive of job listings. This is the same signal a human
 * reverse-engineering the site by hand would look for in the Network tab.
 */
export async function captureNetworkCalls(
  browserBinding: BrowserWorker,
  url: string,
  timeoutMs = 25000
): Promise<CapturedCall[]> {
  const browser = await puppeteer.launch(browserBinding)
  const captured: CapturedCall[] = []

  try {
    const page = await browser.newPage()

    page.on('response', (res) => {
      void (async () => {
        try {
          const reqUrl = res.url()
          const ct = res.headers()['content-type'] ?? ''
          if (!ct.includes('json') && !ct.includes('text')) return
          // Skip the page's own document/JS/CSS; only XHR-shaped calls matter.
          if (reqUrl === url || /\.(js|css|png|jpg|svg|woff2?)(\?|$)/i.test(reqUrl)) return
          if (!JOB_HINT.test(reqUrl)) {
            // The URL alone doesn't scream "jobs" - only keep it if the body does.
            const peek = await res.text().catch(() => '')
            if (!JOB_HINT.test(peek.slice(0, 500))) return
            captured.push({
              url: reqUrl, method: res.request().method(), status: res.status(),
              contentType: ct, bodySnippet: peek.slice(0, 2000)
            })
            return
          }
          const body = await res.text().catch(() => '')
          captured.push({
            url: reqUrl, method: res.request().method(), status: res.status(),
            contentType: ct, bodySnippet: body.slice(0, 2000)
          })
        } catch {
          // A single response failing to read must not abort the whole capture.
        }
      })()
    })

    await page.goto(url, { waitUntil: 'networkidle0', timeout: timeoutMs })
    // A brief settle: some SPAs fire their data call just after "network idle"
    // resolves (e.g. a debounced search-on-mount).
    await new Promise((r) => setTimeout(r, 1500))
  } finally {
    await browser.close()
  }

  // Largest, most job-shaped responses first - usually the actual listing call
  // rather than a small facet/metadata request.
  return captured.sort((a, b) => b.bodySnippet.length - a.bodySnippet.length).slice(0, 8)
}
