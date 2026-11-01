import { describe, expect, it } from 'vitest'
import type { TextSpan } from '../types/canvas'
import { DEFAULT_HIGHLIGHT, normalizeSpans, parseMarkup, toMarkup } from './richText'

const base = { color: '#ffffff', fontFamily: 'Inter', fontWeight: 400 }

describe('rich text markup', () => {
  it('reads bold, italic, highlight and colour', () => {
    expect(parseMarkup('RULES OF THE {#ffd400|**GAME**}', base)).toEqual({
      text: 'RULES OF THE GAME',
      spans: [{ text: 'RULES OF THE ' }, { text: 'GAME', color: '#ffd400', fontWeight: 700 }],
    })
    expect(parseMarkup('the *drama* ==triangle==', base).spans).toEqual([
      { text: 'the ' },
      { text: 'drama', fontStyle: 'italic' },
      { text: ' ' },
      { text: 'triangle', highlight: DEFAULT_HIGHLIGHT },
    ])
  })

  it('reads the long form: a quoted font, weight, italic, colour and highlight colour', () => {
    expect(parseMarkup('{"Playfair Display" w600 i #ff4466 hl#00000080|Persecutor} wins', base).spans).toEqual([
      { text: 'Persecutor', color: '#ff4466', fontFamily: 'Playfair Display', fontWeight: 600, fontStyle: 'italic', highlight: '#00000080' },
      { text: ' wins' },
    ])
  })

  it('leaves plain text alone: unclosed markers, unknown braces and escapes are text', () => {
    expect(parseMarkup('5 * 3 = 15', base)).toEqual({ text: '5 * 3 = 15' })
    expect(parseMarkup('a {x|c} d', base)).toEqual({ text: 'a {x|c} d' })
    expect(parseMarkup('\\*not italic\\*', base)).toEqual({ text: '*not italic*' })
    expect(parseMarkup('**open *nested* only', base).spans).toEqual([{ text: '**open ' }, { text: 'nested', fontStyle: 'italic' }, { text: ' only' }])
  })

  it('a bold element makes ** black, and spans that only repeat the element go', () => {
    const bold = { ...base, fontWeight: 700 }
    expect(parseMarkup('**big**', bold).spans).toEqual([{ text: 'big', fontWeight: 900 }])
    expect(normalizeSpans([{ text: 'a', color: '#ffffff' }, { text: 'b', fontWeight: 700 }], bold)).toBeUndefined()
  })

  it('writes the short forms back, and braces when the short ones would read differently', () => {
    const cases: TextSpan[][] = [
      [{ text: 'RULES OF THE ' }, { text: 'GAME', color: '#ffd400', fontWeight: 700 }],
      [{ text: 'a', fontStyle: 'italic' }, { text: 'b', fontWeight: 700 }],
      [{ text: '5 * 3 ' }, { text: 'x', highlight: DEFAULT_HIGHLIGHT }],
      [{ text: 'line one\n' }, { text: 'two', fontFamily: 'Fraunces', fontStyle: 'italic' }],
    ]
    for (const spans of cases) {
      const item = { ...base, text: spans.map((s) => s.text).join(''), spans }
      const markup = toMarkup(item)
      expect(parseMarkup(markup, base)).toEqual({ text: item.text, spans: normalizeSpans(spans, base) })
    }
    expect(toMarkup({ ...base, text: 'a b', spans: [{ text: 'a ' }, { text: 'b', fontWeight: 700 }] })).toBe('a **b**')
    expect(toMarkup({ ...base, text: '5 * 3' })).toBe('5 * 3')
  })
})
