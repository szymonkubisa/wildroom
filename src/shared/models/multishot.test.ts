import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { klingElementLimit, klingModels, withKlingElementMentions } from './catalog/kling'
import {
  KLING_MAX_SHOT_CHARS,
  expectedCuts,
  multiShotProblem,
  parseMultiShot,
  resolveShotDurations,
  toKlingMultiShotPrompt,
} from './multishot'
import { parseParams } from './params'

describe('parseMultiShot', () => {
  it('reads the friendly "Shot N (Xs):" syntax, one shot per line', () => {
    expect(parseMultiShot('Shot 1 (3s): wide shot of the harbour at dawn\nShot 2 (2s): close-up of the keeper’s hands')).toEqual({
      shots: [
        { text: 'wide shot of the harbour at dawn', seconds: 3 },
        { text: 'close-up of the keeper’s hands', seconds: 2 },
      ],
    })
  })

  it('accepts duration variants, bracket headers, bullets and missing durations', () => {
    const prompt = [
      '- Shot 1 [3 sec] – dawn over the bay',
      '* Shot 2: 2s, the keeper climbs the stairs',
      'Shot 3 — the lamp room',
      '[4s] the lamp turns on',
      '(1 second) darkness',
    ].join('\n')
    expect(parseMultiShot(prompt)?.shots).toEqual([
      { text: 'dawn over the bay', seconds: 3 },
      { text: 'the keeper climbs the stairs', seconds: 2 },
      { text: 'the lamp room' },
      { text: 'the lamp turns on', seconds: 4 },
      { text: 'darkness', seconds: 1 },
    ])
  })

  it('reads Kling’s native syntax (m = the shot duration in seconds)', () => {
    expect(parseMultiShot('shot 1, 3, a runner in the forest; shot 2, 2, a cat on a sofa;')?.shots).toEqual([
      { text: 'a runner in the forest', seconds: 3 },
      { text: 'a cat on a sofa', seconds: 2 },
    ])
  })

  it('splits shots written on one line after sentence ends, and "[Shot N]" headers on their own line', () => {
    expect(parseMultiShot('Shot 1, profile of a truck driver, handheld. Shot 2, macro of hands on the wheel.')?.shots).toEqual([
      { text: 'profile of a truck driver, handheld.' },
      { text: 'macro of hands on the wheel.' },
    ])
    expect(parseMultiShot('[Shot 1]\nThe camera follows the cat.\n\n[Shot 2]\nThe girl reads on the\nsofa.')?.shots).toEqual([
      { text: 'The camera follows the cat.' },
      { text: 'The girl reads on the sofa.' },
    ])
  })

  it('keeps text before the first shot as context for shot 1', () => {
    expect(parseMultiShot('Film noir, 35 mm grain.\nShot 1 (2s): a detective lights a cigarette\nShot 2 (3s): rain on the window')?.shots).toEqual([
      { text: 'Film noir, 35 mm grain. a detective lights a cigarette', seconds: 2 },
      { text: 'rain on the window', seconds: 3 },
    ])
  })

  it('leaves ordinary prompts alone', () => {
    for (const prompt of [
      '',
      'A lighthouse keeper climbs the stairs at dusk',
      'Shot on 35mm film, a man walks through the rain',
      'shot 2 people talking at a cafe',
      'A wide shot 1 of a lighthouse',
      'Shot 3: the finale', // a shot list starts at shot 1
      'Numbers (3) and (4 dogs) in brackets',
    ]) {
      expect(parseMultiShot(prompt), prompt).toBeNull()
    }
  })

  it('does not take prose numbers for durations', () => {
    expect(parseMultiShot('Shot 1: 2 friends talk under a streetlight\nShot 2, 3 dogs run')?.shots).toEqual([
      { text: '2 friends talk under a streetlight' },
      { text: '3 dogs run' },
    ])
  })
})

describe('durations and cuts', () => {
  it('shares the remaining whole seconds between shots without a duration', () => {
    const shots = [{ text: 'a', seconds: 3 }, { text: 'b' }, { text: 'c' }, { text: 'd', seconds: 2 }]
    expect(resolveShotDurations(shots, 10).map((s) => s.seconds)).toEqual([3, 3, 2, 2])
    expect(resolveShotDurations([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 5).map((s) => s.seconds)).toEqual([2, 2, 1])
  })

  it('rejects shot lists that do not fit the clip', () => {
    expect(() => resolveShotDurations([{ text: 'a', seconds: 3 }, { text: 'b', seconds: 3 }], 5)).toThrow('add up to 6 s but the clip is 5 s')
    expect(() => resolveShotDurations([{ text: 'a', seconds: 5 }, { text: 'b' }], 5)).toThrow('no time left')
    expect(() => resolveShotDurations([{ text: 'a', seconds: 4 }, { text: 'b' }, { text: 'c' }], 5)).toThrow('Only 1 s left for 2 shots')
    expect(() => resolveShotDurations([{ text: 'a', seconds: 0 }, { text: 'b' }], 5)).toThrow('at least 1 s')
  })

  it('computes cumulative cut points', () => {
    const plan = parseMultiShot('Shot 1 (3s): a\nShot 2: b\nShot 3 (2s): c')!
    expect(expectedCuts(plan.shots, 10)).toEqual([3, 8])
    expect(expectedCuts([{ text: 'only one', seconds: 5 }], 5)).toEqual([])
    // Distributed evenly (whole seconds, spare seconds first) — exactly what the adapter sends.
    expect(expectedCuts([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 10)).toEqual([4, 7])
  })

  it('falls back to proportional cuts when the list does not fit the duration', () => {
    expect(expectedCuts([{ text: 'a', seconds: 3 }, { text: 'b', seconds: 2 }], 10)).toEqual([6])
    // Fractional seconds never reach Kling (validation asks for whole seconds); cuts then keep the typed times.
    expect(expectedCuts([{ text: 'a', seconds: 2.5 }, { text: 'b', seconds: 2.5 }], 5)).toEqual([2.5])
  })

  it('writes Kling’s native storyboard syntax', () => {
    const plan = parseMultiShot('Shot 1 (3s): harbour; dawn\nShot 2: hands')!
    expect(toKlingMultiShotPrompt(plan.shots, 5)).toBe('shot 1, 3, harbour, dawn; shot 2, 2, hands;')
    expect(toKlingMultiShotPrompt([{ text: 'a', seconds: 2 }, { text: 'b', seconds: 1 }])).toBe('shot 1, 2, a; shot 2, 1, b;')
    expect(() => toKlingMultiShotPrompt([{ text: 'a' }])).toThrow('no duration')
    // Native output parses back to the same shots.
    const native = toKlingMultiShotPrompt(resolveShotDurations(plan.shots, 5))
    expect(parseMultiShot(native)?.shots).toEqual([
      { text: 'harbour, dawn', seconds: 3 },
      { text: 'hands', seconds: 2 },
    ])
  })

  it('reports what Kling would reject', () => {
    const shot = (seconds?: number, text = 'x') => ({ text, seconds })
    expect(multiShotProblem([shot(1), shot(1), shot(1), shot(1), shot(1), shot(1)], 6)).toBeNull()
    expect(multiShotProblem([shot(), shot(), shot(), shot(), shot(), shot(), shot()], 10)).toMatch(/up to 6 shots/)
    expect(multiShotProblem([shot(2.5), shot(2.5)], 5)).toMatch(/whole seconds/)
    expect(multiShotProblem([shot(3, ''), shot(2)], 5)).toMatch(/Shot 1 needs a description/)
    expect(multiShotProblem([shot(3, 'y'.repeat(KLING_MAX_SHOT_CHARS + 1)), shot(2)], 5)).toMatch(/Shot 1 is too long/)
    expect(multiShotProblem([shot(3), shot(3)], 5)).toMatch(/add up to 6 s/)
  })

  it('always fills the clip exactly with ordered cuts (property)', () => {
    const shotArb = fc.record({ known: fc.boolean(), seconds: fc.integer({ min: 1, max: 4 }) })
    fc.assert(
      fc.property(fc.array(shotArb, { minLength: 1, maxLength: 6 }), fc.integer({ min: 3, max: 15 }), (spec, total) => {
        const shots = spec.map((s, i) => (s.known ? { text: `shot ${i}`, seconds: s.seconds } : { text: `shot ${i}` }))
        const problem = multiShotProblem(shots, total)
        const cuts = expectedCuts(shots, total)
        expect(cuts.every((c, i) => c > 0 && c < total && (i === 0 || c > cuts[i - 1]!))).toBe(true)
        if (problem) return
        const resolved = resolveShotDurations(shots, total)
        expect(resolved.reduce((sum, s) => sum + s.seconds, 0)).toBe(total)
        expect(resolved.every((s) => Number.isInteger(s.seconds) && s.seconds >= 1)).toBe(true)
        expect(cuts).toHaveLength(shots.length - 1)
      }),
    )
  })
})

describe('Kling catalog rules', () => {
  const model = (id: string) => klingModels.find((m) => m.id === id)!

  it('validates multi-shot prompts only when Multi-shot is on', () => {
    const prompt = 'Shot 1 (3s): harbour\nShot 2 (3s): hands'
    expect(parseParams(model('kling-3.0'), { prompt, duration: 5 }).ok).toBe(true)
    const bad = parseParams(model('kling-3.0'), { prompt, duration: 5, multiShot: true })
    expect(bad.ok ? '' : bad.message).toBe('Shot durations add up to 6 s but the clip is 5 s')
    expect(parseParams(model('kling-3.0'), { prompt, duration: 6, multiShot: true }).ok).toBe(true)
    expect(parseParams(model('kling-3.0-omni'), { prompt: 'A plain prompt', multiShot: true }).ok).toBe(true)
  })

  it('limits Kling elements per model and input', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `${100 + i}`)
    const k3 = model('kling-3.0')
    const omni = model('kling-3.0-omni')
    const noFrame = parseParams(k3, { prompt: 'p', elements: ids(1) })
    expect(noFrame.ok ? '' : noFrame.message).toMatch(/only together with a start frame/)
    expect(parseParams(k3, { prompt: 'p', firstFrame: 'img', elements: ids(3) }).ok).toBe(true)
    expect(parseParams(k3, { prompt: 'p', firstFrame: 'img', elements: ids(4) }).ok).toBe(false)
    expect(parseParams(omni, { prompt: 'p', elements: ids(7) }).ok).toBe(true)
    expect(parseParams(omni, { prompt: 'p', elements: ids(8) }).ok).toBe(false)
    const framed = parseParams(omni, { prompt: 'p', firstFrame: 'img', elements: ids(4) })
    expect(framed.ok ? '' : framed.message).toBe('Kling 3.0 Omni takes up to 3 characters with a start frame')
    const dup = parseParams(omni, { prompt: 'p', elements: ['1', '1'] })
    expect(dup.ok ? '' : dup.message).toBe('Each character can only be used once')
    expect(model('kling-2.6').params.some((p) => p.key === 'elements')).toBe(false)
    expect([false, true].map((framed) => klingElementLimit('kling-3.0', framed))).toEqual([0, 3])
    expect([false, true].map((framed) => klingElementLimit('kling-3.0-omni', framed))).toEqual([7, 3])
    expect(klingElementLimit('kling-2.6', true)).toBe(0)
    expect(klingElementLimit('fal-veo3.1', false)).toBe(0)
    expect(k3.params.find((p) => p.key === 'elements')?.ui).toMatchObject({ control: 'elements', label: 'Characters (Kling elements)', advanced: false })
  })

  it('points character names at their element handles', () => {
    expect(withKlingElementMentions('Anna hugs Ann; ANNA laughs. Annabel waves.', ['Ann', 'Anna'])).toBe(
      '@element_2 hugs @element_1; @element_2 laughs. Annabel waves.',
    )
    expect(withKlingElementMentions('Zoë meets Łukasz', ['Łukasz', 'Zoë'])).toBe('@element_2 meets @element_1')
    // Prompts that already use a handle keep it; unnamed slots are skipped.
    expect(withKlingElementMentions('@element_1 and Mara', ['Mara', undefined, 'Bo (the dog)'])).toBe('@element_1 and Mara')
    expect(withKlingElementMentions('Bo (the dog) runs', [undefined, 'Bo (the dog)'])).toBe('@element_2 runs')
  })
})

describe('parseMultiShot — numbers and brackets in the text', () => {
  it('keeps "8-year-old" in the text instead of reading 8 s', () => {
    expect(parseMultiShot('Shot 1 (2s): wide\nShot 2: 8-year-old boy waves')?.shots).toEqual([
      { text: 'wide', seconds: 2 },
      { text: '8-year-old boy waves' },
    ])
  })

  it('closes a bracket opened before "Shot" after the duration', () => {
    expect(parseMultiShot('[Shot 1 (3s)] wide\nShot 2 (2s): close')?.shots).toEqual([
      { text: 'wide', seconds: 3 },
      { text: 'close', seconds: 2 },
    ])
  })
})
