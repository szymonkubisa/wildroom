import type { CanvasTextItem, TextSpan } from '../types/canvas'

/**
 * Rich text written as light markup in the text box:
 * `**bold**`, `*italic*`, `==highlight==`, `{#ffd400|colour}` and, for anything else,
 * `{"Playfair Display" w600 i #fff hl#ffe066|words}` (a quoted font, `w` + weight or `b`, `i` / `normal`,
 * a colour, `hl` with an optional colour). A backslash keeps a marker as it is (`\*`).
 */

export const DEFAULT_HIGHLIGHT = '#ffe066'

type Base = Pick<CanvasTextItem, 'color' | 'fontFamily' | 'fontWeight' | 'fontStyle'>
type Style = Omit<TextSpan, 'text'>
const STYLE_KEYS = ['color', 'fontFamily', 'fontWeight', 'fontStyle', 'highlight'] as const

/** What `**…**` sets: bold, or black when the text is already bold. */
export const boldWeight = (base: Base) => (base.fontWeight >= 600 ? 900 : 700)

const sameStyle = (a: Style, b: Style) => STYLE_KEYS.every((k) => a[k] === b[k])
const styled = (s: Style) => STYLE_KEYS.some((k) => s[k] !== undefined)

/** Spans made minimal: empty ones dropped, looks the element already has dropped, neighbours that look alike merged. */
export function normalizeSpans(spans: readonly TextSpan[], base: Base): TextSpan[] | undefined {
  const out: TextSpan[] = []
  for (const s of spans) {
    if (!s.text) continue
    const span: TextSpan = { text: s.text }
    if (s.color && s.color !== base.color) span.color = s.color
    if (s.fontFamily && s.fontFamily !== base.fontFamily) span.fontFamily = s.fontFamily
    if (s.fontWeight && s.fontWeight !== base.fontWeight) span.fontWeight = s.fontWeight
    if (s.fontStyle && s.fontStyle !== (base.fontStyle ?? 'normal')) span.fontStyle = s.fontStyle
    if (s.highlight) span.highlight = s.highlight
    const last = out.at(-1)
    if (last && sameStyle(last, span)) last.text += span.text
    else out.push(span)
  }
  return out.some(styled) ? out : undefined
}

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** The look a `{…|` opener sets, or undefined when nothing in it is understood (then the brace is just text). */
function parseAttrs(attrs: string, base: Base): Style | undefined {
  const style: Style = {}
  let known = false
  for (const m of attrs.matchAll(/"([^"]*)"|(\S+)/g)) {
    const family = m[1]
    const word = m[2] ?? ''
    if (family !== undefined) {
      if (!family.trim()) continue
      style.fontFamily = family.trim()
    } else if (COLOR.test(word)) style.color = word
    else if (word === 'b' || word === 'bold') style.fontWeight = boldWeight(base)
    else if (/^w\d{3}$/.test(word)) style.fontWeight = Number(word.slice(1))
    else if (word === 'i' || word === 'italic') style.fontStyle = 'italic'
    else if (word === 'normal' || word === 'upright') style.fontStyle = 'normal'
    else if (word === 'hl') style.highlight = DEFAULT_HIGHLIGHT
    else if (word.startsWith('hl') && COLOR.test(word.slice(2))) style.highlight = word.slice(2)
    else continue
    known = true
  }
  return known ? style : undefined
}

type Marker = '**' | '*' | '==' | '{'
const ESCAPABLE = new Set(['\\', '*', '=', '{', '}', '|'])

/** One pass; openers at `literal` positions are text. Returns the openers that never closed. */
function parsePass(src: string, base: Base, literal: ReadonlySet<number>) {
  const spans: TextSpan[] = []
  const stack: { marker: Marker; at: number; style: Style }[] = []
  const emit = (text: string) => {
    const style: Style = Object.assign({}, ...stack.map((f) => f.style))
    const last = spans.at(-1)
    if (last && sameStyle(last, style)) last.text += text
    else spans.push({ text, ...style })
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\\' && ESCAPABLE.has(src[i + 1] ?? '')) {
      emit(src[i + 1]!)
      i += 2
      continue
    }
    const marker: Marker | undefined = src.startsWith('**', i) ? '**' : ch === '*' ? '*' : src.startsWith('==', i) ? '==' : undefined
    if (marker) {
      if (stack.at(-1)?.marker === marker) stack.pop()
      else if (literal.has(i)) emit(marker)
      else stack.push({ marker, at: i, style: marker === '**' ? { fontWeight: boldWeight(base) } : marker === '*' ? { fontStyle: 'italic' } : { highlight: DEFAULT_HIGHLIGHT } })
      i += marker.length
      continue
    }
    if (ch === '{' && !literal.has(i)) {
      const bar = src.indexOf('|', i)
      const head = bar > i ? src.slice(i + 1, bar) : ''
      const style = bar > i && !/[{}\n]/.test(head) ? parseAttrs(head, base) : undefined
      if (style) {
        stack.push({ marker: '{', at: i, style })
        i = bar + 1
        continue
      }
    }
    if (ch === '}' && stack.at(-1)?.marker === '{') {
      stack.pop()
      i++
      continue
    }
    emit(ch)
    i++
  }
  return { spans, unclosed: stack.map((f) => f.at) }
}

/** Markup → the element's plain text and its spans (none when nothing is styled). Markers that never close are text. */
export function parseMarkup(src: string, base: Base): { text: string; spans?: TextSpan[] } {
  const literal = new Set<number>()
  for (let pass = 0; pass < 32; pass++) {
    const { spans, unclosed } = parsePass(src, base, literal)
    if (!unclosed.length) return { text: spans.map((s) => s.text).join(''), spans: normalizeSpans(spans, base) }
    for (const at of unclosed) literal.add(at)
  }
  return { text: src }
}

const escapeAll = (text: string) => text.replace(/[\\*={}|]/g, (c) => `\\${c}`)

function attrsOf(s: Style, base: Base): string {
  const out: string[] = []
  if (s.fontFamily) out.push(`"${s.fontFamily.replace(/"/g, '')}"`)
  if (s.fontWeight) out.push(s.fontWeight === boldWeight(base) ? 'b' : `w${s.fontWeight}`)
  if (s.fontStyle) out.push(s.fontStyle === 'italic' ? 'i' : 'normal')
  if (s.color) out.push(s.color)
  if (s.highlight) out.push(s.highlight === DEFAULT_HIGHLIGHT ? 'hl' : `hl${s.highlight}`)
  return out.join(' ')
}

/** The short form of one span: `**…**`, `*…*`, `==…==` when it changes that one thing, else `{attrs|…}`. */
function shortForm(s: TextSpan, base: Base): string {
  const keys = STYLE_KEYS.filter((k) => s[k] !== undefined)
  if (!keys.length) return s.text
  if (keys.length === 1) {
    if (s.fontWeight === boldWeight(base)) return `**${s.text}**`
    if (s.fontStyle === 'italic') return `*${s.text}*`
    if (s.highlight === DEFAULT_HIGHLIGHT) return `==${s.text}==`
  }
  return `{${attrsOf(s, base)}|${s.text}}`
}

/**
 * The element's text as markup for the text box: the short forms with the text as typed when that reads back the
 * same, otherwise braces and escapes, which always do.
 */
export function toMarkup(item: Base & Pick<CanvasTextItem, 'text' | 'spans'>): string {
  const norm = item.spans ? normalizeSpans(item.spans, item) : undefined
  const spans = norm ?? [{ text: item.text }]
  const plain = spans.map((s) => shortForm(s, item)).join('')
  const back = parseMarkup(plain, item)
  if (back.text === item.text && JSON.stringify(back.spans) === JSON.stringify(norm)) return plain
  return spans.map((s) => (styled(s) ? `{${attrsOf(s, item)}|${escapeAll(s.text)}}` : escapeAll(s.text))).join('')
}
