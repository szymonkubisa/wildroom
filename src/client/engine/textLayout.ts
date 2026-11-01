/** A run of text in one look (`style` indexes the looks of the element). */
export interface Piece {
  text: string
  style: number
}

type Measure = (text: string, style: number) => number

/** `pieces` then `more`, neighbours in the same look merged. */
function concat(pieces: readonly Piece[], more: readonly Piece[]): Piece[] {
  const out = pieces.map((p) => ({ ...p }))
  for (const p of more) {
    const last = out.at(-1)
    if (last && last.style === p.style) last.text += p.text
    else out.push({ ...p })
  }
  return out
}

function trimEnd(pieces: Piece[]): Piece[] {
  const out = pieces.map((p) => ({ ...p }))
  while (out.length) {
    const last = out.at(-1)!
    last.text = last.text.trimEnd()
    if (last.text) break
    out.pop()
  }
  return out
}

/**
 * Lines of styled text as the board shows them (`white-space: pre-wrap; overflow-wrap: break-word`): explicit line
 * breaks kept, words wrapped to `maxWidth` (a word may change look halfway), a word longer than a line broken by
 * characters.
 */
export function wrapRuns(runs: readonly Piece[], maxWidth: number, measure: Measure): Piece[][] {
  const paragraphs: Piece[][] = [[]]
  for (const r of runs)
    r.text.split('\n').forEach((part, i) => {
      if (i > 0) paragraphs.push([])
      if (part) paragraphs.at(-1)!.push({ text: part, style: r.style })
    })
  const widthOf = (pieces: readonly Piece[]) => pieces.reduce((w, p) => w + measure(p.text, p.style), 0)
  const lines: Piece[][] = []
  for (const paragraph of paragraphs) {
    const tokens: { space: boolean; pieces: Piece[] }[] = []
    for (const r of paragraph)
      for (const part of r.text.split(/(\s+)/)) {
        if (!part) continue
        const space = !part.trim()
        const last = tokens.at(-1)
        if (last && last.space === space) last.pieces = concat(last.pieces, [{ text: part, style: r.style }])
        else tokens.push({ space, pieces: [{ text: part, style: r.style }] })
      }
    let line: Piece[] = []
    for (const token of tokens) {
      const joined = concat(line, token.pieces)
      if (widthOf(joined) <= maxWidth) {
        line = joined
        continue
      }
      if (token.space) {
        // Spaces that overflow end the line (CSS hangs them).
        lines.push(trimEnd(line))
        line = []
        continue
      }
      if (line.some((p) => p.text.trim())) lines.push(trimEnd(line))
      line = []
      // A word wider than the whole line breaks by characters.
      for (const p of token.pieces)
        for (const ch of p.text) {
          const next = concat(line, [{ text: ch, style: p.style }])
          if (line.length && widthOf(next) > maxWidth) {
            lines.push(line)
            line = [{ text: ch, style: p.style }]
          } else line = next
        }
    }
    lines.push(trimEnd(line))
  }
  return lines
}

export const lineText = (pieces: readonly Piece[]) => pieces.map((p) => p.text).join('')

/**
 * How many characters of each line show at `reveal` (0..1): letters or whole words in reading order. Lines are
 * wrapped on the full text first, so nothing reflows while the text types itself.
 */
export function shownChars(lines: readonly string[], reveal: number, mode: 'typewriter' | 'words'): number[] {
  if (reveal >= 1) return lines.map((l) => [...l].length)
  if (mode === 'typewriter') {
    let left = Math.round(reveal * lines.reduce((n, l) => n + [...l].length, 0))
    return lines.map((l) => {
      const length = [...l].length
      const n = Math.min(length, Math.max(0, left))
      left -= length
      return n
    })
  }
  // Each word's end, in characters from the start of its line.
  const ends = lines.map((l) => [...l.matchAll(/\S+/g)].map((m) => [...l.slice(0, m.index + m[0].length)].length))
  let left = Math.round(reveal * ends.reduce((n, e) => n + e.length, 0))
  return ends.map((line) => {
    let end = 0
    for (const e of line) {
      if (left <= 0) break
      left--
      end = e
    }
    return end
  })
}

/** The first `count` characters of a line. */
export function cutPieces(pieces: readonly Piece[], count: number): Piece[] {
  const out: Piece[] = []
  let left = count
  for (const p of pieces) {
    if (left <= 0) break
    const chars = [...p.text]
    out.push({ text: chars.slice(0, left).join(''), style: p.style })
    left -= chars.length
  }
  return out
}
