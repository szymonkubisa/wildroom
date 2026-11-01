import type { AssetDTO } from '@shared/types/assets'

/**
 * Plain-language media search: every query word must match (as a word prefix, ignoring plurals and accents)
 * somewhere in the name, keywords, AI description/tags, generation prompt or transcript. Results are ranked by
 * where the words matched (name and keywords first, transcript last).
 */

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'to', 'for', 'is', 'are', 'shot', 'clip', 'z', 'w', 'i', 'na'])

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

export function tokenize(query: string): string[] {
  return fold(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem)
}

interface Field {
  words: string[]
  weight: number
}

const cache = new WeakMap<AssetDTO, Field[]>()

function fieldsOf(a: AssetDTO): Field[] {
  let f = cache.get(a)
  if (f) return f
  const words = (text: string | undefined) => (text ? fold(text).split(/[^a-z0-9]+/).filter(Boolean).map(stem) : [])
  f = [
    { words: words(a.name), weight: 5 },
    { words: words(a.keywords.join(' ')), weight: 5 },
    { words: words(a.aiTags?.join(' ')), weight: 4 },
    { words: words(a.description), weight: 3 },
    { words: words(a.generation?.prompt), weight: 2 },
    { words: words(a.alignment?.words.map((w) => w.text).join(' ')), weight: 1 },
  ]
  cache.set(a, f)
  return f
}

/** 0 when some query word matches nowhere; otherwise a relevance score. */
export function scoreAsset(a: AssetDTO, tokens: readonly string[]): number {
  if (!tokens.length) return 1
  let score = 0
  for (const t of tokens) {
    let best = 0
    for (const field of fieldsOf(a)) {
      if (field.weight <= best) continue
      if (field.words.some((w) => w === t)) best = field.weight + 0.5
      else if (field.words.some((w) => w.startsWith(t))) best = Math.max(best, field.weight)
    }
    if (!best) return 0
    score += best
  }
  return score
}

/** Same rules for things that only have a name (timelines): 0 when some query word is not in it. */
export function scoreName(name: string, tokens: readonly string[]): number {
  if (!tokens.length) return 1
  const words = fold(name).split(/[^a-z0-9]+/).filter(Boolean).map(stem)
  let score = 0
  for (const t of tokens) {
    if (words.some((w) => w === t)) score += 5.5
    else if (words.some((w) => w.startsWith(t))) score += 5
    else return 0
  }
  return score
}

/** Where a match came from, for the result hint (description or a snippet of what was said). */
export function matchHint(a: AssetDTO, tokens: readonly string[]): string | undefined {
  if (!tokens.length) return undefined
  const has = (text: string | undefined) => Boolean(text) && tokens.every((t) => fold(text!).includes(t))
  if (has(a.name) || has(a.keywords.join(' '))) return undefined
  if (a.description && tokens.some((t) => fold(a.description!).includes(t))) return a.description
  const words = a.alignment?.words
  if (words?.length) {
    const i = words.findIndex((w) => tokens.some((t) => fold(w.text).startsWith(t)))
    if (i >= 0) return `“…${words.slice(Math.max(0, i - 3), i + 5).map((w) => w.text).join(' ')}…”`
  }
  return undefined
}
