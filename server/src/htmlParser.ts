import { setHtmlParser, type HtmlNode } from '../../src/core/connectors/index'

/**
 * Minimal HTML extraction for the Worker runtime, where cheerio cannot load
 * (it pulls Node built-ins that Workers does not provide).
 *
 * Supports the simple selector shapes Scout actually emits - tag, .class, #id -
 * rather than pretending to be a full CSS engine. This is the last-resort
 * connector path anyway: Scout is explicitly instructed to prefer JSON
 * endpoints, which need no HTML parsing at all.
 */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function selectorToRegex(sel: string): RegExp {
  const s = sel.trim()

  if (s.startsWith('.')) {
    const cls = escapeRe(s.slice(1))
    return new RegExp(
      '<(\\w+)[^>]*class=["\'][^"\']*\\b' + cls + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)</\\1>',
      'gi'
    )
  }

  if (s.startsWith('#')) {
    const id = escapeRe(s.slice(1))
    return new RegExp('<(\\w+)[^>]*id=["\']' + id + '["\'][^>]*>([\\s\\S]*?)</\\1>', 'gi')
  }

  const tag = s.replace(/[^\w-]/g, '')
  return new RegExp('<(' + tag + ')\\b[^>]*>([\\s\\S]*?)</\\1>', 'gi')
}

const stripTags = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

function attrIn(scope: string, name: string): string | null {
  const m = new RegExp(escapeRe(name) + '=["\']([^"\']*)["\']', 'i').exec(scope)
  return m?.[1] ?? null
}

export function registerWorkerHtmlParser(): void {
  setHtmlParser({
    select(html, itemSelector) {
      const out: HtmlNode[] = []
      const re = selectorToRegex(itemSelector)
      let m: RegExpExecArray | null

      // Bounded so a pathological page cannot spin the Worker's CPU budget.
      while ((m = re.exec(html)) !== null && out.length < 500) {
        const whole = m[0]
        const inner = m[2] ?? ''

        out.push({
          text: (selector?: string): string => {
            if (!selector) return stripTags(inner)
            const sub = selectorToRegex(selector).exec(inner)
            return sub ? stripTags(sub[2] ?? '') : ''
          },
          attr: (name: string, selector?: string): string | null => {
            if (!selector) return attrIn(whole, name)
            const sub = selectorToRegex(selector).exec(inner)
            return sub ? attrIn(sub[0], name) : null
          }
        })
      }

      return out
    }
  })
}
