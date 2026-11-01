import { describe, expect, it } from 'vitest'
import { planAssetSet, sanitizePlan } from '../../src/server/services/assetSet'
import {
  breakdownScript,
  breakdownSystem,
  breakdownTarget,
  demoBreakdown,
  sanitizeBreakdown,
  type structuredCall,
} from '../../src/server/services/director'
import { getModel } from '../../src/shared/models/registry'
import type { Breakdown } from '../../src/shared/types/story'

const SCRIPT = `EXT. LIGHTHOUSE — DAWN
Waves crash against the rocks. Anna climbs the spiral stairs.

ANNA: [out of breath] It's still here…
TOMEK: Of course it is. Nobody comes up here anymore.

The lamp flickers on.`

describe('AI Director (demo rules)', () => {
  it('turns paragraphs into shots and NAME: lines into dialogue', () => {
    const b = demoBreakdown({ script: SCRIPT, style: '35mm film' })
    expect(b.shots).toHaveLength(3)
    expect(b.characters.map((c) => c.name)).toEqual(['Anna', 'Tomek'])
    expect(b.shots[1]!.dialogue).toEqual([
      { character: 'Anna', text: "[out of breath] It's still here…" },
      { character: 'Tomek', text: 'Of course it is. Nobody comes up here anymore.' },
    ])
    expect(b.shots[0]!.prompt).toContain('35mm film')
    for (const shot of b.shots) expect(shot.durationSeconds).toBeGreaterThanOrEqual(3)
  })

  it('keeps names of existing characters', () => {
    const b = demoBreakdown({ script: 'ANNA: Hi', characters: [{ name: 'Anna', description: 'yellow raincoat' }] })
    expect(b.characters).toEqual([{ name: 'Anna', description: 'yellow raincoat' }])
  })

  it('keeps existing places and leaves shots without one', () => {
    const b = demoBreakdown({ script: SCRIPT, places: [{ name: 'Lighthouse', description: 'white tower on black rocks' }] })
    expect(b.places).toEqual([{ name: 'Lighthouse', description: 'white tower on black rocks' }])
    for (const shot of b.shots) expect(shot.place).toBe('')
  })

  it('clears a shot place that is not in the place list', () => {
    const shot = { scene: '1', description: 'x', shotType: 'WIDE', camera: 'static', prompt: 'p', durationSeconds: 4, characters: [], dialogue: [], sfx: '' }
    const b = sanitizeBreakdown({
      title: 't',
      characters: [],
      places: [{ name: 'Peron', description: 'platform' }, { name: ' ', description: 'nameless' }],
      shots: [
        { ...shot, place: 'peron' },
        { ...shot, place: 'Kitchen' },
      ],
    })
    expect(b.places).toEqual([{ name: 'Peron', description: 'platform' }])
    expect(b.shots.map((s) => s.place)).toEqual(['peron', ''])
  })

  it('routes: demo without keys, error when demo is off', async () => {
    const res = await breakdownScript({ script: SCRIPT }, {}, true)
    expect(res.via).toBe('demo')
    await expect(breakdownScript({ script: SCRIPT }, {}, false)).rejects.toThrow(/Anthropic, OpenRouter or fal\.ai key/)
    await expect(breakdownScript({ script: '   ' }, {}, true)).rejects.toThrow(/script/)
  })
})

describe('AI Director: the target model', () => {
  const shot = (group: number, durationSeconds = 2): Breakdown['shots'][number] => ({
    scene: '1',
    place: '',
    description: 'd',
    shotType: 'MEDIUM',
    camera: 'static',
    prompt: 'Anna speaks.',
    durationSeconds,
    characters: ['Anna'],
    partial: [],
    dialogue: [],
    sfx: '',
    group,
  })
  const breakdown = (shots: Breakdown['shots']): Breakdown => ({ title: 't', characters: [], places: [], shots })
  const groups = (b: Breakdown) => b.shots.map((s) => s.group)

  it('writes for LTX-2.5 without a model, for an unknown one, and for LTX itself', () => {
    const system = breakdownSystem()
    expect(system).toContain('an AI video model that renders each shot from a keyframe, or a short multi-shot clip')
    expect(system).toContain("The model is LTX-2.5, Lightricks' audio-video model. Write everything the way Lightricks' prompting guide asks: concrete, present tense, physical, no negative phrasing.")
    // Every shot renders from its own keyframe (every native multi-shot take failed); dialogue is made to the recorded lines.
    expect(system).toContain('Every shot is rendered as its own image-to-video clip from its keyframe: its prompt starts with the action and says what happens next')
    expect(system).toContain('- "group": always 0 — every shot is rendered as a clip of its own.')
    expect(system).not.toContain('"group": shots where nobody speaks')
    expect(system).not.toContain('A multi-shot clip is written as prose')
    expect(system).toContain('one speaker per shot')
    // Geography: each place says what lies on each side, each shot what is behind the subject from its camera.
    expect(system).toContain('so a reverse shot can show the opposite side')
    expect(system).toContain('their backgrounds are opposite sides of the place')
    // "Looks off to the left" turned Jan the wrong way: facing the camera, his left is the frame's right.
    expect(system).toContain('never as left or right')
    expect(system).not.toContain('usually an exchange of lines in one place')
    expect(system).toContain('never change, translate or shorten the spoken words')
    expect(breakdownTarget('no-such-model')).toBeUndefined()
    expect(breakdownTarget('local-flux-2')).toBeUndefined() // an image model is no target
    expect(breakdownSystem(breakdownTarget('no-such-model'))).toBe(system)
    expect(breakdownSystem(breakdownTarget('runpod-ltx-2.5'))).toBe(system)
    // This Mac renders shot by shot too, without a recorded voice to follow.
    const local = breakdownSystem(breakdownTarget('local-ltx-2.5'))
    expect(local).toContain('"group": always 0')
    expect(local).not.toContain('one speaker per shot')
  })

  it('writes for Kling 3.0: native multi-shot up to 6 shots and 15 s, one name per character, English or Chinese', () => {
    const system = breakdownSystem(getModel('kling-3.0'))
    expect(system).toContain('The model is Kling 3.0')
    expect(system).toContain('up to 6 shots and 15 seconds, each shot at least 1 second')
    expect(system).toContain('2 to 6 shots, at most 15 seconds together')
    expect(system).toContain('one exact name')
    expect(system).toContain('English and Chinese')
    expect(system).not.toContain('LTX')
    // "(fal)" is where it runs, not what it is.
    expect(breakdownSystem(getModel('fal-kling-3.0'))).toContain('The model is Kling 3.0,')
  })

  it('writes for Veo 3.1: 8 s clips, single shots or 2–3 short ones, English, positive phrasing', () => {
    const system = breakdownSystem(getModel('fal-veo3.1'))
    expect(system).toContain('The model is Veo 3.1')
    expect(system).toContain('at most 8 seconds')
    expect(system).toContain('one after another — at most 8 seconds together, so prefer single shots or 2–3 short ones')
    expect(system).not.toContain('2 to 4 shots')
    expect(system).toContain('dialogue in English')
    expect(system).toContain('Phrase everything positively')
  })

  it('writes for Happy Horse 1.1: 15 s clips in beats, lip-sync from the dialogue', () => {
    const system = breakdownSystem(getModel('fal-happy-horse-1.1'))
    expect(system).toContain('The model is Happy Horse 1.1')
    expect(system).toContain('up to 15 seconds')
    expect(system).toContain('lip-syncs each speaker from the dialogue')
    expect(system).toContain('2 to 6 shots, at most 15 seconds together')
  })

  it('splits oversized groups by shot count', () => {
    const six = Array.from({ length: 6 }, () => shot(1))
    expect(groups(sanitizeBreakdown(breakdown(six)))).toEqual([1, 1, 1, 2, 2, 2])
    expect(groups(sanitizeBreakdown(breakdown(six), { maxShots: 6, maxSeconds: 15 }))).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('splits oversized groups by length, and a leftover shot plays alone', () => {
    // 4 × 4 s is 16 s, over LTX's 10 s: two clips of 8 s.
    expect(groups(sanitizeBreakdown(breakdown([shot(3, 4), shot(3, 4), shot(3, 4), shot(3, 4)])))).toEqual([1, 1, 2, 2])
    // 3 × 3 s is 9 s, over Veo's 8 s: one clip of two, the third shot alone.
    expect(groups(sanitizeBreakdown(breakdown([shot(0), shot(2, 3), shot(2, 3), shot(2, 3)]), { maxShots: 4, maxSeconds: 8 }))).toEqual([0, 1, 1, 0])
    // A group of one is no group.
    expect(groups(sanitizeBreakdown(breakdown([shot(5), shot(0), shot(6)])))).toEqual([0, 0, 0])
  })

  it('keeps shots with dialogue out of LTX groups; a silent run stays one clip', () => {
    const talking = (group: number) => ({ ...shot(group, 3), dialogue: [{ character: 'Anna', text: 'Tutaj, u nas?' }] })
    const shots = [shot(1, 3), shot(1, 3), talking(1), talking(2), talking(2), shot(0, 3)]
    expect(groups(sanitizeBreakdown(breakdown(shots), undefined, { soloDialogue: true }))).toEqual([1, 1, 0, 0, 0, 0])
    // Models that speak in their multi-shot clips keep the exchange together.
    expect(groups(sanitizeBreakdown(breakdown(shots)))).toEqual([1, 1, 1, 2, 2, 0])
  })

  it('asks the model with the target model’s prompt and holds the reply to its limits', async () => {
    const systems: string[] = []
    const reply = breakdown(Array.from({ length: 6 }, () => shot(1, 3)))
    const call = (async (_creds: unknown, system: string) => {
      systems.push(system)
      return { result: structuredClone(reply), via: 'anthropic', model: 'fake-model' }
    }) as unknown as typeof structuredCall
    const creds = { anthropic: 'test-key' }

    // Kling 3.0: six 3 s shots are 18 s, over 15 s: two clips of three.
    const kling = await breakdownScript({ script: SCRIPT, targetModelId: 'kling-3.0' }, creds, false, call)
    expect(systems[0]).toContain('up to 6 shots and 15 seconds')
    expect(groups(kling.breakdown)).toEqual([1, 1, 1, 2, 2, 2])

    // Veo 3.1: 8 s clips take two 3 s shots.
    const veo = await breakdownScript({ script: SCRIPT, targetModelId: 'fal-veo3.1' }, creds, false, call)
    expect(systems[1]).toContain('at most 8 seconds')
    expect(groups(veo.breakdown)).toEqual([1, 1, 2, 2, 3, 3])

    // No model (or one the server doesn't know): LTX-2.5, which renders shot by shot — the reply's groups go.
    const ltx = await breakdownScript({ script: SCRIPT, targetModelId: 'gone' }, creds, false, call)
    expect(systems[2]).toBe(breakdownSystem())
    expect(groups(ltx.breakdown)).toEqual([0, 0, 0, 0, 0, 0])

    // LTX on the GPU, a speaking shot among them: every shot a clip of its own all the same.
    reply.shots[1]!.dialogue = [{ character: 'Anna', text: 'Janek… co to znaczy?' }]
    const spoken = await breakdownScript({ script: SCRIPT, targetModelId: 'runpod-ltx-2.5' }, creds, false, call)
    expect(groups(spoken.breakdown)).toEqual([0, 0, 0, 0, 0, 0])
    // Kling still groups the exchange: two clips of three.
    expect(groups((await breakdownScript({ script: SCRIPT, targetModelId: 'kling-3.0' }, creds, false, call)).breakdown)).toEqual([1, 1, 1, 2, 2, 2])
  })

  it('makes a shot as long as its lines need, within one clip of the target', () => {
    const nine = 'We have to leave before the smoke reaches us.'
    const talking = (seconds: number, lines: string[]) => ({ ...shot(0, seconds), dialogue: lines.map((text) => ({ character: 'Anna', text })) })
    // 18 words at 2.5 words a second, laid out as the voice track lays them (0.3 s in, 0.25 s between, 0.6 s after):
    // 8.35 s — 9 s, the length the storyboard's dialogue check and the voice track want too. Cues in brackets aren't said.
    const [a, b, c] = sanitizeBreakdown(breakdown([talking(5, [nine, `[quietly] ${nine}`]), talking(10, ['Tak.']), talking(3, [])])).shots
    expect(a!.durationSeconds).toBe(9)
    expect(b!.durationSeconds).toBe(10)
    expect(c!.durationSeconds).toBe(3)
    // No longer than one clip of the model: 8 s on this Mac.
    expect(sanitizeBreakdown(breakdown([talking(5, [nine, nine, nine])]), { maxShots: 2, maxSeconds: 8 }).shots[0]!.durationSeconds).toBe(8)
  })
})

describe('asset set planner', () => {
  const req = {
    brief: 'Small-batch coffee roastery in Leeds. New website and launch campaign.',
    deliverables: [
      { id: 'logo', count: 2 },
      { id: 'og', count: 1 },
      { id: 'nonsense', count: 3 },
    ],
    brand: { name: 'Roastery', style: 'flat, warm, paper texture' },
  }

  it('plans templated items in demo mode and refuses without keys or input', async () => {
    const res = await planAssetSet(req, {}, true)
    expect(res.via).toBe('demo')
    expect(res.plan.items.map((i) => i.deliverable)).toEqual(['logo', 'logo', 'og'])
    expect(res.plan.style).toBe('flat, warm, paper texture')
    // Logos take no copy; the link preview does.
    expect(res.plan.items[0]).toMatchObject({ headline: '', subline: '' })
    expect(res.plan.items[2]!.headline).toBe('Roastery')
    await expect(planAssetSet(req, {}, false)).rejects.toThrow(/Anthropic, OpenRouter or fal\.ai key/)
    await expect(planAssetSet({ ...req, brief: ' ' }, {}, true)).rejects.toThrow(/brief/)
    await expect(planAssetSet({ ...req, deliverables: [{ id: 'nonsense', count: 1 }] }, {}, true)).rejects.toThrow(/deliverable/)
  })

  it('keeps only what was asked for, trims text and drops copy where none belongs', () => {
    const plan = sanitizePlan(
      {
        title: '  Launch  ',
        style: 'warm',
        items: [
          { deliverable: 'logo', title: 'A', prompt: 'mark one', headline: 'Should go', subline: 'x' },
          { deliverable: 'logo', title: 'B', prompt: 'mark two', headline: '', subline: '' },
          { deliverable: 'logo', title: 'C', prompt: 'mark three — one too many', headline: '', subline: '' },
          { deliverable: 'og', title: '', prompt: 'cups on a table', headline: ' Fresh every week ', subline: 'Roasted in Leeds', textArea: ' Right ' },
          { deliverable: 'hero', title: 'Not asked for', prompt: 'x', headline: '', subline: '' },
          { deliverable: 'og', title: 'Empty prompt', prompt: '  ', headline: '', subline: '' },
        ],
      },
      { brief: 'b', deliverables: [{ id: 'logo', count: 2 }, { id: 'og', count: 2 }] },
    )
    expect(plan.title).toBe('Launch')
    expect(plan.items.map((i) => [i.deliverable, i.title])).toEqual([
      ['logo', 'A'],
      ['logo', 'B'],
      ['og', 'Link preview (OG)'],
    ])
    expect(plan.items[0]!.headline).toBe('')
    expect(plan.items[2]).toMatchObject({ headline: 'Fresh every week', subline: 'Roasted in Leeds', textArea: 'right' })
    expect(plan.items[0]!.textArea).toBe('left')
  })
})
