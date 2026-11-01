import { open, readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { Resvg, renderAsync } from '@resvg/resvg-js'

/** Long edge of the PNG an SVG is rendered to — what the timeline, posters and exports use. */
export const SVG_RASTER_EDGE = 2048

/** True for .svg files, or files whose first bytes are SVG markup. */
export async function isSvgFile(path: string): Promise<boolean> {
  if (extname(path).toLowerCase() === '.svg') return true
  const fh = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(512), 0, 512, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8').trimStart()
    return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)
  } finally {
    await fh.close()
  }
}

/** An SVG this app won't render: it can't be checked for references to local files. */
export class UnsafeSvgError extends Error {}

const ATTR = /(\s+)([^\s=/>]+)(\s*=\s*)("[^"]*"|'[^']*')/y
const TAG_NAME = /<([^\s/>]+)/y
const TAG_END = /\s*\/?>/y
const ENTITY_DECL = /^<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>$/
/** In-document references and embedded raster images: nothing the renderer has to fetch. A data: SVG could nest its own. */
const SAFE_HREF = /^(#|data:image\/(png|jpe?g|gif|webp)[;,])/i

/** Index just past `term` (searched from `from`), or an error for markup that never closes. */
function after(s: string, term: string, from: number): number {
  const i = s.indexOf(term, from)
  if (i < 0) throw new UnsafeSvgError(`Unterminated markup (missing “${term}”)`)
  return i + term.length
}

/** Index just past a `<!DOCTYPE …>` starting at `start`: quoted literals, the internal subset and its comments skipped whole. */
function doctypeEnd(s: string, start: number): number {
  let inSubset = false
  for (let i = start + 2; i < s.length; ) {
    const c = s[i]!
    if (c === '"' || c === "'") i = after(s, c, i + 1)
    else if (inSubset && s.startsWith('<!--', i)) i = after(s, '-->', i + 4)
    else if (inSubset && s.startsWith('<?', i)) i = after(s, '?>', i + 2)
    else {
      if (c === '[') inSubset = true
      else if (c === ']') inSubset = false
      else if (c === '>' && !inSubset) return i + 1
      i++
    }
  }
  throw new UnsafeSvgError('Unterminated DOCTYPE')
}

/**
 * The plain text entities a DOCTYPE declares (Illustrator writes a few namespace URLs this way). Anything that could
 * expand to markup or reach outside the file — parameter or external entities, values with `<`, `&` or `%`, attribute
 * defaults — is refused, because this pass would never see what it turns into.
 */
function doctypeEntities(doctype: string): Map<string, string> {
  const entities = new Map<string, string>()
  const subset = /\[([\s\S]*)\]/.exec(doctype)?.[1] ?? ''
  const decls = subset.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '').match(/<![A-Z]+(?:[^>"']|"[^"]*"|'[^']*')*>/g) ?? []
  for (const decl of decls) {
    if (/^<!(ELEMENT|NOTATION)\b/.test(decl)) continue
    const m = ENTITY_DECL.exec(decl)
    const value = m ? (m[2] ?? m[3])! : undefined
    if (!m || /[<&%]/.test(value!)) throw new UnsafeSvgError('The SVG declares entities or attribute defaults that could hide references')
    entities.set(m[1]!, value!)
  }
  return entities
}

/**
 * Removes references to anything outside the SVG itself before it is rendered: resvg reads local files named in
 * `<image href="/Users/…">` (or `<feImage>`, or an SVG nested as a data URL) into the PNG, which can then be shared or
 * uploaded. Only in-document `#fragment` references and embedded raster `data:` images stay.
 *
 * A small tokenizer, not a pattern search: comments, CDATA, processing instructions and quoted attribute values are
 * stepped over whole, so a `>` or a decoy `href` inside them can't hide a real one. The DOCTYPE is dropped after its
 * plain-text entities are written out in place. Markup it can't follow throws `UnsafeSvgError`.
 */
export function stripExternalRefs(input: string): string {
  let s = input
  const doctypeAt = s.search(/<!DOCTYPE/i)
  if (doctypeAt >= 0) {
    const end = doctypeEnd(s, doctypeAt)
    const entities = doctypeEntities(s.slice(doctypeAt, end))
    const quote = (v: string) => v.replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    s = s.slice(0, doctypeAt) + s.slice(end).replace(/&([A-Za-z_][\w.-]*);/g, (ref, name: string) => {
      const value = entities.get(name)
      return value === undefined ? ref : quote(value)
    })
  }

  let out = ''
  let i = 0
  for (;;) {
    const lt = s.indexOf('<', i)
    if (lt < 0) return out + s.slice(i)
    out += s.slice(i, lt)
    let next: number
    if (s.startsWith('<!--', lt)) next = after(s, '-->', lt + 4)
    else if (s.startsWith('<![CDATA[', lt)) next = after(s, ']]>', lt + 9)
    else if (s.startsWith('<?', lt)) next = after(s, '?>', lt + 2)
    else if (s.startsWith('</', lt)) next = after(s, '>', lt + 2)
    else if (s.startsWith('<!', lt)) throw new UnsafeSvgError('Unexpected declaration in the SVG')
    else {
      // A start tag: its name, then each attribute in turn (quoted values taken whole), then `>` or `/>`.
      TAG_NAME.lastIndex = lt
      const name = TAG_NAME.exec(s)
      if (!name) throw new UnsafeSvgError('Malformed tag in the SVG')
      out += name[0]
      let j = TAG_NAME.lastIndex
      for (;;) {
        ATTR.lastIndex = j
        const attr = ATTR.exec(s)
        if (!attr) break
        j = ATTR.lastIndex
        const isHref = /^(?:[^:]+:)?href$/i.test(attr[2]!)
        if (!isHref || SAFE_HREF.test(attr[4]!.slice(1, -1).trim())) out += attr[0]
      }
      TAG_END.lastIndex = j
      const end = TAG_END.exec(s)
      if (!end) throw new UnsafeSvgError('Malformed tag in the SVG')
      out += end[0]
      i = TAG_END.lastIndex
      continue
    }
    out += s.slice(lt, next)
    i = next
  }
}

/** Renders an SVG to a PNG whose long edge is `edge` px, keeping transparency. */
export async function rasterizeSvg(svgPath: string, pngPath: string, edge = SVG_RASTER_EDGE): Promise<{ width: number; height: number }> {
  const svg = Buffer.from(stripExternalRefs(await readFile(svgPath, 'utf8')))
  // Only the size is needed here: skip loading system fonts (slow), and render off the main thread below.
  const probe = new Resvg(svg, { font: { loadSystemFonts: false } })
  const mode = probe.width >= probe.height ? 'width' : 'height'
  const rendered = await renderAsync(svg, { fitTo: { mode, value: edge }, background: 'rgba(0,0,0,0)' })
  await writeFile(pngPath, rendered.asPng())
  return { width: rendered.width, height: rendered.height }
}
