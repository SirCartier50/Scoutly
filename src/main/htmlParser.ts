import { setHtmlParser, type HtmlNode } from '../core/connectors/index'

/**
 * Registers cheerio as the shared core's HTML parser.
 *
 * Not used by the running desktop app anymore - Scout and the connectors now
 * execute server-side (see `server/src/htmlParser.ts` for the Worker's own
 * regex-based parser, since cheerio cannot load on Workers). Kept here purely
 * so local test scripts (`scripts/scout-check.ts`) can exercise the real
 * HTML-selector connector path without needing the Worker runtime.
 */
export async function registerCheerio(): Promise<void> {
  const { load } = await import('cheerio')

  setHtmlParser({
    select(html, itemSelector) {
      const $ = load(html)
      const nodes: HtmlNode[] = []
      $(itemSelector).each((_i, el) => {
        const node = $(el)
        nodes.push({
          text: (selector?: string) => (selector ? node.find(selector).first().text() : node.text()),
          attr: (name: string, selector?: string) =>
            (selector ? node.find(selector).first().attr(name) : node.attr(name)) ?? null
        })
      })
      return nodes
    }
  })
}
