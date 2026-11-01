import { getModel } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import { workflowFor } from '@shared/models/workflow'
import type { StoryCharacter, StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import {
  cameraFor,
  canJoinNext,
  clipAtLeast,
  cutsForLength,
  breakdownGroups,
  fitMultishotPrompt,
  positiveStyle,
  joinNext,
  matchCuts,
  maxClipSeconds,
  multishotPrompt,
  planCuts,
  planCutsFor,
  styleFor,
  takeCuts,
  validGroups,
  withoutBackdrop,
  withoutCompass,
} from './multishot'

const shot = (id: string, duration: number, extra: Partial<StoryShot> = {}): StoryShot => ({
  id,
  description: '',
  prompt: `Prompt ${id}.`,
  duration,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...extra,
})
const story = (shots: StoryShot[], multishots: StoryDoc['multishots'] = []): StoryDoc => ({ script: '', style: '', characters: [], shots, multishots })

describe('multi-shot groups', () => {
  it('never joins across a scene: the next scene starts with a cut of its own', () => {
    const s = story([shot('a', 3, { sceneId: 'x' }), shot('b', 3, { sceneId: 'x' }), shot('c', 3, { sceneId: 'y' })])
    expect(canJoinNext(s, 'a')).toBe(true)
    expect(canJoinNext(s, 'b')).toBe(false)
  })

  it('joins consecutive shots, at most three (LTX: about 3 s each in 10 s), and never into another group', () => {
    const s = story(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => shot(id, 3)))
    let n = 0
    const id = () => `g${++n}`
    joinNext(s, 'a', id)
    joinNext(s, 'b', id)
    expect(validGroups(s).map((g) => g.shotIds)).toEqual([['a', 'b', 'c']])
    expect(canJoinNext(s, 'a')).toBe(false) // only the group's last shot extends it
    expect(canJoinNext(s, 'c')).toBe(false) // three shots is the limit
    joinNext(s, 'd', id)
    joinNext(s, 'e', id)
    expect(validGroups(s).map((g) => g.shotIds)).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']])
    expect(canJoinNext(s, 'f')).toBe(false) // last shot
  })

  it('forgets the shorter group’s takes, final render and cuts when a shot joins it', () => {
    const s = story(
      [shot('a', 3), shot('b', 3), shot('c', 3)],
      [{ id: 'g', shotIds: ['a', 'b'], videoGenerationIds: ['t'], chosenAssetId: 'x', finalGenerationId: 'f', takes: { t: { planned: [3] } } }],
    )
    joinNext(s, 'b', () => 'n')
    expect(s.multishots![0]).toMatchObject({ shotIds: ['a', 'b', 'c'], videoGenerationIds: [], chosenAssetId: undefined, finalGenerationId: undefined, takes: undefined })
  })

  it('gives a new group the first shot’s “Render with…” model', () => {
    const s = story([shot('a', 3, { modelId: 'kling-3.0' }), shot('b', 3), shot('c', 3), shot('d', 3)])
    joinNext(s, 'a', () => 'g1')
    joinNext(s, 'c', () => 'g2')
    expect(s.multishots).toMatchObject([
      { id: 'g1', shotIds: ['a', 'b'], modelId: 'kling-3.0' },
      { id: 'g2', shotIds: ['c', 'd'] },
    ])
    expect(s.multishots![1]!.modelId).toBeUndefined()
  })

  it('takes as many shots as the group’s model does: six on Kling 3.0 (its native shot list), three on LTX', () => {
    const kling = getModel('kling-3.0')!
    const maxShots = workflowFor(kling).multishot.maxShots
    expect(maxShots).toBe(6)
    expect(workflowFor(getModel('runpod-ltx-2.5')).multishot.maxShots).toBe(3)
    const s = story(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => shot(id, 2)))
    for (const id of ['a', 'b', 'c']) joinNext(s, id, () => 'g1', maxShots)
    expect(validGroups(s)[0]!.shotIds).toEqual(['a', 'b', 'c', 'd'])
    expect(canJoinNext(s, 'd')).toBe(false) // LTX's three by default
    expect(canJoinNext(s, 'd', maxShots)).toBe(true)
    joinNext(s, 'd', () => 'x') // the default limit: no change
    expect(validGroups(s)[0]!.shotIds).toHaveLength(4)
    joinNext(s, 'd', () => 'x', maxShots)
    joinNext(s, 'e', () => 'x', maxShots)
    expect(validGroups(s)[0]!.shotIds).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(canJoinNext(s, 'f', maxShots)).toBe(false) // six is Kling's limit
  })

  it('drops a group whose shots no longer follow one another', () => {
    const s = story([shot('a', 3), shot('x', 3), shot('b', 3)], [{ id: 'g', shotIds: ['a', 'b'], videoGenerationIds: [] }])
    expect(validGroups(s)).toEqual([])
  })
})

describe('planCuts', () => {
  it('scales the shots into the longest clip the model renders', () => {
    const { total, cuts } = planCuts([shot('a', 5), shot('b', 4), shot('c', 6)], 10)
    expect(total).toBe(10)
    expect(cuts.map((c) => [c.start, c.end])).toEqual([[0, 3.3], [3.3, 6], [6, 10]])
  })

  it('keeps short groups at their own length', () => {
    expect(planCuts([shot('a', 3), shot('b', 3)], 10).total).toBe(6)
    expect(cutsForLength([shot('a', 3), shot('b', 3)], 6.04).at(-1)!.end).toBe(6.04)
  })
})

describe('maxClipSeconds', () => {
  it('reads the longest duration from the model schema', () => {
    expect(maxClipSeconds(getModel('runpod-ltx-2.5') as ModelSpec)).toBe(10)
    expect(maxClipSeconds(getModel('local-ltx-2.5') as ModelSpec)).toBe(8)
  })
})

describe('maxClipSeconds beyond 20 s', () => {
  it('finds 30 s clips (Seedance)', () => {
    expect(maxClipSeconds(getModel('fal-seedance-2.5') as ModelSpec)).toBe(30)
  })
})

describe('planCutsFor', () => {
  const veo = getModel('fal-veo3.1') as ModelSpec
  it('lands a group on a length the model takes, so the prompt and the cuts match the clip', () => {
    // Veo renders 4, 6 or 8 s: a 5 s group becomes 6 s, not a silently snapped 4 s.
    const plan = planCutsFor(veo, [shot('a', 3), shot('b', 2)])
    expect(plan.total).toBe(6)
    expect(plan.cuts.at(-1)!.end).toBe(6)
    // Longer than the model's longest clip: capped at 8 s.
    expect(planCutsFor(veo, [shot('a', 5), shot('b', 5)]).total).toBe(8)
  })

  it('leaves lengths the model takes as they are', () => {
    expect(planCutsFor(getModel('runpod-ltx-2.5') as ModelSpec, [shot('a', 3), shot('b', 4)]).total).toBe(7)
  })

  it('gives every LTX shot about three seconds: a short one is lengthened, from the longer ones or a longer clip', () => {
    const ltx = getModel('runpod-ltx-2.5') as ModelSpec
    // 3 + 2 s: the clip grows to 6 s so the 2 s shot gets 3.
    expect(planCutsFor(ltx, [shot('a', 3), shot('b', 2)])).toMatchObject({ total: 6, cuts: [{ start: 0, end: 3 }, { start: 3, end: 6 }] })
    // Bajo la lluvia: her line 4 s, his 4 s, a 2 s two-shot — the two-shot gets its 3 s from the others.
    const plan = planCutsFor(ltx, [shot('a', 4), shot('b', 4), shot('c', 2)])
    expect(plan.total).toBe(10)
    expect(plan.cuts.map((c) => Math.round((c.end - c.start) * 10) / 10)).toEqual([3.5, 3.5, 3])
    // Veo keeps its own lengths (it times its shots in its prompt).
    expect(planCutsFor(veo, [shot('a', 3), shot('b', 2)]).cuts.map((c) => c.end - c.start)).toEqual([3.6, 2.4])
  })
})

describe('styleFor', () => {
  const style = 'Photorealistic, 35mm film look, no subtitles, no watermarks'
  it('drops the negative phrases for LTX and for models with a negative prompt', () => {
    expect(styleFor(style, getModel('runpod-ltx-2.5') as ModelSpec, true)).toBe('Photorealistic, 35mm film look')
    expect(styleFor(style, getModel('fal-veo3.1') as ModelSpec, true)).toBe('Photorealistic, 35mm film look')
  })

  it('keeps them for models that only have the prompt, and keeps spoken lines off the screen', () => {
    // Kling O3 on fal has no negative prompt (Kling 3.0 on fal has one since it takes elements).
    const kling = getModel('fal-kling-o3') as ModelSpec
    expect(styleFor(style, kling, true)).toBe(style)
    expect(styleFor('Photorealistic, 35mm film look', kling, true)).toBe('Photorealistic, 35mm film look, no subtitles, no on-screen text')
    expect(styleFor('Photorealistic, 35mm film look', kling, false)).toBe('Photorealistic, 35mm film look')
  })
})

describe('clipAtLeast', () => {
  it('picks the shortest clip that is long enough, else the longest', () => {
    const ltx = getModel('local-ltx-2.5') as ModelSpec
    expect(clipAtLeast(ltx, 5.2)).toBe(6)
    expect(clipAtLeast(ltx, 30)).toBe(8)
  })
})

describe('matchCuts', () => {
  it('picks, in order and without repeats, the detected cuts closest to the plan', () => {
    // The live LTX test: planned 3.3 / 6, the picture cut at 1.5, 5 and 7.6.
    expect(matchCuts([3.3, 6], [1.5, 5, 7.6])).toEqual([1.5, 5])
    expect(matchCuts([2, 6], [1.8, 2.1, 6.2])).toEqual([2.1, 6.2])
    // Both planned cuts nearest to one detected cut: still two different, ordered cuts (least total distance).
    expect(matchCuts([4, 4.5], [1, 4.2, 9])).toEqual([1, 4.2])
    expect(matchCuts([4, 4.5], [4.2, 4.4])).toEqual([4.2, 4.4])
    expect(matchCuts([3], [])).toEqual([])
  })
})

describe('takeCuts', () => {
  const shots = [shot('a', 5), shot('b', 4), shot('c', 6)]

  it('uses the detected cuts, matched to the plan, when there are enough', () => {
    expect(takeCuts(shots, 10, { planned: [3.3, 6], total: 10, detected: [1.5, 5, 7.6] })).toEqual({ cuts: [1.5, 5], source: 'detected', found: 3 })
    expect(takeCuts(shots, 10, { planned: [3.3, 6], detected: [2, 7] }).cuts).toEqual([2, 7])
  })

  it('falls back to the recorded plan (scaled to the real length) when detection found too few', () => {
    expect(takeCuts(shots, 10, { planned: [3.3, 6], total: 10, detected: [4] })).toEqual({ cuts: [3.3, 6], source: 'planned', found: 1 })
    expect(takeCuts(shots, 5, { planned: [3.3, 6], total: 10 }).cuts).toEqual([1.7, 3])
  })

  it('ignores flashes at the clip ends', () => {
    expect(takeCuts(shots, 10, { planned: [3.3, 6], total: 10, detected: [0.1, 4, 9.95] }).source).toBe('planned')
  })

  it('splits by the shots’ current lengths without a usable record', () => {
    expect(takeCuts(shots, 10)).toEqual({ cuts: [3.3, 6], source: 'proportional', found: undefined })
    // A plan written for a different number of shots doesn't apply.
    expect(takeCuts(shots, 10, { planned: [5] }).source).toBe('proportional')
    // Detected cuts are matched to the proportional plan when there's no recorded one.
    expect(takeCuts(shots, 10, { planned: [], detected: [1, 3.5, 6.2, 8] }).cuts).toEqual([3.5, 6.2])
  })

  it('skips a stray opening shot: an extra cut in the first 1.5 s before the first planned one', () => {
    // Bajo la lluvia, multi-shot 2 on LTX: a 0.7 s two-shot nobody asked for, then the three shots.
    expect(takeCuts([shot('a', 4), shot('b', 4), shot('c', 2)], 10, { planned: [4, 8], total: 10, detected: [0.708, 4.75, 9.125] })).toEqual({
      cuts: [4.75, 9.125],
      source: 'detected',
      found: 3,
      start: 0.708,
    })
    // A first shot that really is short is matched, not skipped.
    expect(takeCuts([shot('a', 1), shot('b', 9)], 10, { planned: [1], total: 10, detected: [1.1] }).start).toBeUndefined()
    // Extra cuts later on are only ignored.
    expect(takeCuts(shots, 10, { planned: [3.3, 6], total: 10, detected: [3.4, 4.8, 6.1] }).start).toBeUndefined()
  })

  it('cuts away an opening beat it asked for, by the picture or else by the plan', () => {
    const three = [shot('a', 4), shot('b', 4), shot('c', 2)]
    // Asked for 1 s, ran 2.1 s: still the opener.
    expect(takeCuts(three, 10, { planned: [4.6, 8.2], total: 10, opener: 1, detected: [2.1, 4.7, 8.3] })).toMatchObject({ cuts: [4.7, 8.3], start: 2.1 })
    // The picture's cuts not found: where it was asked to end.
    expect(takeCuts(three, 10, { planned: [4.6, 8.2], total: 10, opener: 1, detected: [] })).toMatchObject({ cuts: [4.6, 8.2], source: 'planned', start: 1 })
  })
})

describe('multishotPrompt from references (Licon MSR)', () => {
  const valentina: StoryCharacter = { id: 'v', name: 'VALENTINA', description: 'Valentina, a 28-year-old Mexican woman; a deep red satin gown' }
  const mateo: StoryCharacter = { id: 'm', name: 'MATEO', description: 'Mateo, a tall 32-year-old Mexican man; a white linen shirt' }
  const blocking =
    'Valentina on the left of the frame by the stone fountain, facing right toward Mateo; Mateo on the right under the arched colonnade, facing left toward her'
  // Bajo la lluvia, multi-shot 2: her close-up over his shoulder, his reverse over hers, then both.
  const group = [
    shot('a', 4, {
      shotType: 'OVER-THE-SHOULDER CLOSE-UP from behind Mateo, eye level, 85mm',
      prompt: 'Valentina lifts her chin.',
      camera: "slow dolly push-in, ending on Valentina's trembling mouth",
      characterIds: ['v'],
      partialIds: ['m'],
      dialogue: [{ id: '1', characterId: 'v', text: "[voice held steady] I'm getting married tomorrow." }],
    }),
    shot('b', 4, {
      shotType: 'REVERSE OVER-THE-SHOULDER MEDIUM CLOSE-UP from behind Valentina, eye level, 50mm',
      prompt: 'Mateo steps toward Valentina.',
      characterIds: ['m'],
      partialIds: ['v'],
      dialogue: [{ id: '2', characterId: 'm', text: "I know. [takes one measured step] That's why I came." }],
    }),
    shot('c', 2, { shotType: 'COMPRESSED MEDIUM TWO-SHOT, eye level, 85mm', prompt: 'Valentina and Mateo hold their positions.', characterIds: ['v', 'm'] }),
  ]
  const subjects = new Map([
    ['v', 'Image 1'],
    ['m', 'Image 2'],
  ])
  const { total, cuts } = planCuts(group, 10)
  const text = multishotPrompt(cuts, total, [valentina, mateo], 'Telenovela look.', { blocking, subjects })
  const paragraphs = text.split('\n\n')
  const shotParagraph = (n: number) => paragraphs.find((p, i) => i > 0 && (n === 0 ? p.startsWith('OVER-THE-SHOULDER') : true) && p.includes(['lifts her chin', 'steps toward', 'hold their positions'][n]!))!

  it('holds the axis with sides only: no composition before the first shot to be drawn as a stray shot', () => {
    expect(text).toContain(
      "The camera stays on the same side of the action across every cut, never crossing or circling round it. Image 1 is always established on the left side of the frame and Image 2 on the right side. Keep Image 1's and Image 2's faces, hair and clothes the same across every cut.",
    )
    const axis = paragraphs.find((p) => p.startsWith('The camera stays'))!
    expect(axis).not.toContain('fountain')
    // The blocking's composition goes to the two-shot only.
    expect(text.split('by the stone fountain').length).toBe(2)
    expect(shotParagraph(2)).toContain('Image 1 on the left of the frame by the stone fountain')
  })

  it('keeps each over-the-shoulder shot on its side, in Licon\u2019s words', () => {
    expect(shotParagraph(0)).toContain(
      'Image 2 remains a soft blurred foreground shoulder at the right edge of the frame, and Image 1, on the left side of the frame, faces right toward Image 2.',
    )
    expect(shotParagraph(1)).toContain(
      'Image 1 remains a soft blurred foreground shoulder at the left edge of the frame, and Image 2, on the right side of the frame, faces left toward Image 1.',
    )
  })

  it('calls each person one way: by image in the framing and the camera too, never a lower-case name', () => {
    expect(shotParagraph(0).startsWith('OVER-THE-SHOULDER CLOSE-UP from behind Image 2, eye level, 85mm shot.')).toBe(true)
    expect(shotParagraph(0)).toContain("ending on Image 1's trembling mouth")
    expect(shotParagraph(1)).toContain('A hard cut transitions to a reverse over-the-shoulder medium close-up from behind Image 1, eye level, 50mm shot')
    // Names stay only in the "Image 1: Valentina, …" introductions.
    const shotsText = paragraphs.filter((p) => !/^Image \d:/.test(p)).join('\n\n')
    expect(shotsText).not.toMatch(/valentina|mateo/i)
  })

  it('gives every line its speaker\u2019s voice', () => {
    expect(shotParagraph(0)).toContain(
      'Image 1 speaks in English in a female voice with visible lip movement, voice held steady, while Image 2 listens silently with closed lips: "I\'m getting married tomorrow."',
    )
    expect(shotParagraph(1)).toContain(
      'Image 2 speaks in English in a male voice with visible lip movement, natural and conversational, while Image 1 listens silently with closed lips: "I know."',
    )
  })

  it('shortens a place sent as a photo to its first clause when asked (before the sounds go)', () => {
    const scene = { token: 'Image 3', name: 'Hacienda courtyard', description: 'The inner courtyard of an old hacienda at night: a fountain in the centre, a colonnade on the right' }
    expect(multishotPrompt(cuts, total, [valentina, mateo], '', { subjects, scene })).toContain('Image 3: Scene, The inner courtyard of an old hacienda at night: a fountain')
    expect(multishotPrompt(cuts, total, [valentina, mateo], '', { subjects, scene, sceneShort: true })).toContain('Image 3: Scene, The inner courtyard of an old hacienda at night.\n')
  })

  it('keeps the blocking in the axis line when it names no sides', () => {
    const plain = multishotPrompt(cuts, total, [valentina, mateo], '', { blocking: 'Both stand by the fountain', subjects })
    expect(plain).toContain('Both stand by the fountain. Keep')
    expect(plain).not.toContain('soft blurred foreground shoulder')
  })
})

describe('cameraFor', () => {
  it('words a preset for the render model and leaves free text alone', () => {
    const ltx = getModel('local-ltx-2.5') as ModelSpec
    const kling = getModel('kling-3.0') as ModelSpec
    expect(cameraFor('fixed camera, no camera movement', ltx)).toBe('static locked-off shot, the camera stays completely still')
    expect(cameraFor('static locked-off shot, the camera stays completely still', kling)).toBe('fixed camera, no camera movement')
    expect(cameraFor('slow drift over the water', kling)).toBe('slow drift over the water')
  })
})

describe('multishotPrompt', () => {
  const jan: StoryCharacter = { id: 'j', name: 'JAN', description: 'Jan Różalski, 44 lata, prokurator; ciemne włosy' }
  const shots = [
    shot('a', 3, { shotType: 'WIDE', prompt: 'A quiet meadow.', camera: 'static' }),
    shot('b', 3, { prompt: 'The same man drives.', characterIds: ['j'], dialogue: [{ id: '1', characterId: 'j', text: 'Co za dzień.' }], sfx: 'silnik' }),
  ]

  it('writes prose: each cut named and framed in words, no timestamps, seconds or labels, words and sounds kept', () => {
    const { total, cuts } = planCuts(shots, 10)
    const text = multishotPrompt(cuts, total, [jan], 'Documentary look.', { blocking: 'Jan stands on the left' })
    expect(text).toContain('A multi-shot sequence of 2 shots joined by hard cuts.\n')
    // Licon's axis line: only who holds which side.
    expect(text).toContain("Jan is always established on the left side of the frame. Keep Jan's face, hair and clothes the same across every cut.")
    expect(text).toContain('WIDE shot. A quiet meadow. A static camera.')
    // The cut and its framing, then the action, then where people are.
    expect(text).toContain('A hard cut transitions to the next shot. The same man drives. Jan is on the left side of the frame.')
    expect(text).toContain('Jan Różalski, 44 lata, prokurator says in Polish, in a natural, conversational voice, "Co za dzień.", lips moving with the words. Ambient sound: silnik.')
    // The settle after the last line is in the timing (END_SETTLE_SECONDS), not in words.
    expect(text).toContain('Ambient sound: silnik.\n\nDocumentary look.')
    expect(text).not.toContain('quiet beat')
    expect(text).not.toMatch(/Shot \d, \d|seconds?\b|Camera:|Light:/)
    expect(text.endsWith('Documentary look.')).toBe(true)
    expect(text).not.toContain('..')
  })

  it('names the framing of a later shot in the cut, and where its camera stands', () => {
    const framed = [shots[0]!, { ...shots[1]!, shotType: 'OVER-THE-SHOULDER CLOSE-UP' }]
    const { total, cuts } = planCuts(framed, 10)
    expect(multishotPrompt(cuts, total, [jan], '')).toContain('A hard cut transitions to an over-the-shoulder close-up shot. The same man drives.')
    // The view's first clause: a cut within one place with only a closer framing came out a push-in.
    const placed = [shots[0]!, { ...framed[1]!, view: "at the pier's end, looking back at the bank, over Jan's shoulder" }]
    expect(multishotPrompt(planCuts(placed, 10).cuts, total, [jan], '')).toContain("A hard cut transitions to an over-the-shoulder close-up shot from the pier's end. The same man drives.")
  })

  it('describes each character from the Cast in their own paragraph, word for word', () => {
    const { total, cuts } = planCuts(shots, 10)
    const text = multishotPrompt(cuts, total, [jan], '')
    expect(text).toContain('The same man drives. Jan Różalski, 44 lata, prokurator; ciemne włosy. Jan Różalski, 44 lata, prokurator says')
    // Shot 1 has no one in it: no look.
    expect(text).toContain('WIDE shot. A quiet meadow. A static camera.\n')
  })

  it('introduces referenced characters once and calls them by their image in the shots, keeping the spoken words', () => {
    const { total, cuts } = planCuts(
      [shot('a', 3, { prompt: 'Jan waits.', characterIds: ['j'] }), shot('b', 3, { prompt: 'Jan nods.', characterIds: ['j'], dialogue: [{ id: '1', characterId: 'j', text: 'Jan, tak.' }] })],
      10,
    )
    const text = multishotPrompt(cuts, total, [jan], '', { subjects: new Map([['j', 'Image 1']]), voices: new Map([['j', 'Audio 1']]), language: 'Polish' })
    expect(text).toContain('Image 1: Jan Różalski, 44 lata, prokurator; ciemne włosy.\n\nAudio 1: the voice of Image 1, belongs only to Image 1.')
    expect(text).toContain('Image 1 waits.')
    expect(text).toContain('Image 1 speaks in Polish with visible lip movement synchronized with Audio 1, in a natural, conversational voice. Audio 1 (Image 1): "Jan, tak."')
    // The Cast look is in the introduction, not repeated in each shot.
    expect(text.split('ciemne włosy').length).toBe(2)
  })

  it('follows Licon’s template with a scene reference: a block per image, the shot set in the scene', () => {
    const { total, cuts } = planCuts([shot('a', 3, { shotType: 'WIDE', prompt: 'Jan waits.', characterIds: ['j'] }), shot('b', 3, { prompt: 'Jan nods.', characterIds: ['j'] })], 10)
    const text = multishotPrompt(cuts, total, [jan], '', {
      subjects: new Map([['j', 'Image 1']]),
      scene: { token: 'Image 2', name: 'the station', description: 'A small railway station among pines.' },
    })
    expect(text).toContain('Image 1: Jan Różalski, 44 lata, prokurator; ciemne włosy.\n\nImage 2: Scene, A small railway station among pines.')
    expect(text).toContain('WIDE shot in the station matching Image 2. Image 1 waits.')
  })

  it('shortens the looks to who they are before giving up the dialogue', () => {
    const { total, cuts } = planCuts(shots, 10)
    const text = fitMultishotPrompt(cuts, total, [jan], '', (p) => !p.includes('ciemne włosy'))
    expect(text).toContain('The same man drives. Jan Różalski, 44 lata, prokurator.')
    expect(text).toContain('"Co za dzień."')
  })

  it('gives up the sounds, then the dialogue, then shot detail to fit the prompt limit', () => {
    const { total, cuts } = planCuts(shots, 10)
    const full = multishotPrompt(cuts, total, [jan], '')
    const noSound = fitMultishotPrompt(cuts, total, [jan], '', (p) => p.length < full.length)
    expect(noSound).toContain('"Co za dzień."')
    expect(noSound).not.toContain('Ambient sound')
    const bare = fitMultishotPrompt(cuts, total, [jan], '', (p) => !p.includes('"'))
    expect(bare).not.toContain('Co za dzień')
  })
})

describe('multishotPrompt — each look once (LTX)', () => {
  const daniel: StoryCharacter = { id: 'd', name: 'Daniel', description: 'Daniel, a man in his early 40s, tired eyes; grey wool jumper, dark jeans' }
  const claire: StoryCharacter = { id: 'c', name: 'Claire', description: 'Claire, a woman in her 30s, red bob; cream cable-knit jumper' }
  const three = [
    shot('a', 3, { shotType: 'WIDE', prompt: 'Daniel and Claire stand by the car.', characterIds: ['d', 'c'], blocking: 'Daniel by the bonnet, Claire at the door' }),
    shot('b', 3, { shotType: 'CLOSE-UP', prompt: 'Claire looks toward the smoke.', characterIds: ['c'], partialIds: ['d'], dialogue: [{ id: '1', characterId: 'c', text: '[quietly] We have to go now.' }] }),
    shot('c', 3, { shotType: 'MEDIUM', prompt: 'Daniel opens the boot.', characterIds: ['d'] }),
  ]

  it('says who everyone is in one sentence up top, by their first clause; the shots and lines name them', () => {
    const { total, cuts } = planCuts(three, 10)
    const text = multishotPrompt(cuts, total, [daniel, claire], '', { looks: 'once', blocking: 'Daniel on the left by the bonnet, Claire on the right at the door' })
    // Daniel came out in Claire's jumper when every shot restated every look.
    expect(text).toContain('Daniel, a man in his early 40s, tired eyes. Claire, a woman in her 30s, red bob.')
    expect(text.split('red bob').length).toBe(2)
    expect(text).not.toContain('jumper')
    expect(text).toContain('Claire says in English in a female voice, quietly, "We have to go now.", lips moving with the words')
  })

  it('from the first keyframe a shot is placed only by its own blocking: the picture shows the rest', () => {
    const { total, cuts } = planCuts(three, 10)
    const blocking = 'Daniel on the left by the bonnet, Claire on the right at the door'
    const text = multishotPrompt(cuts, total, [daniel, claire], '', { looks: 'once', blocking, fromFrame: true })
    expect(text).toContain('WIDE shot. Daniel and Claire stand by the car. Daniel by the bonnet, Claire at the door.')
    expect(text).not.toContain('soft blurred foreground shoulder')
    expect(text).not.toContain('Daniel is on the left side of the frame')
    // From references the sides are worked out from the scene's blocking, as before.
    expect(multishotPrompt(cuts, total, [daniel, claire], '', { looks: 'once', blocking })).toContain('soft blurred foreground shoulder')
  })
})

describe('withoutBackdrop', () => {
  it('drops what is behind the subject — the keyframe shows it — and keeps the action', () => {
    expect(withoutBackdrop('Claire turns toward the lift. Behind her, across the lane: the parked Porsche and the concrete pillar.')).toBe('Claire turns toward the lift.')
    expect(withoutBackdrop('Kuba sets the rod down. Behind Kuba stands the long wooden pier.')).toBe('Kuba sets the rod down.')
    expect(withoutBackdrop('Behind her, Daniel draws a gun. She freezes.')).toBe('Behind her, Daniel draws a gun. She freezes.')
    expect(withoutBackdrop('Maja waits.')).toBe('Maja waits.')
  })
})

describe('breakdownGroups', () => {
  it('turns runs of the same number into clips of 2–4 shots and leaves lone shots alone', () => {
    expect(breakdownGroups([0, 1, 1, 0, 2, 3, 3, 3])).toEqual([[1, 2], [5, 6, 7]])
    // Six in a row: two even clips, not 4 + 2.
    expect(breakdownGroups([4, 4, 4, 4, 4, 4])).toEqual([[0, 1, 2], [3, 4, 5]])
    expect(breakdownGroups([5, 5, 5, 5, 5])).toEqual([[0, 1, 2], [3, 4]])
    expect(breakdownGroups([])).toEqual([])
  })

  it('cuts runs into clips as long as the story’s video model takes', () => {
    const six = [4, 4, 4, 4, 4, 4]
    expect(breakdownGroups(six, 6)).toEqual([[0, 1, 2, 3, 4, 5]])
    expect(breakdownGroups([...six, 4, 4], 6)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]])
    expect(breakdownGroups(six, 4)).toEqual(breakdownGroups(six))
    // A model of two shots per clip: pairs, and a shot left over stays on its own.
    expect(breakdownGroups([1, 1, 1], 2)).toEqual([[0, 1]])
    expect(breakdownGroups([1, 1, 1], 1)).toEqual([[0, 1]])
  })
})

describe('multishotPrompt — light', () => {
  it('keeps the place’s light in every shot', () => {
    const { total, cuts } = planCuts([shot('a', 3), shot('b', 3)], 10)
    expect(multishotPrompt(cuts, total, [], '', { light: 'low golden sun from the left.' })).toContain('Low golden sun from the left, the same in every shot.')
  })
})

describe('positiveStyle', () => {
  it('drops the negative phrases of a style', () => {
    expect(positiveStyle('Photorealistic, 35mm film look, horizontal 16:9 framing, no subtitles, no captions, without logos')).toBe(
      'Photorealistic, 35mm film look, horizontal 16:9 framing',
    )
    expect(positiveStyle('')).toBe('')
  })

  it('drops its camera moves too: every shot says its own (a slow crane fought a rapid drone ascent)', () => {
    expect(positiveStyle('Epic photorealistic cinema, slow sweeping crane and drone camera, 65mm large-format film texture')).toBe(
      'Epic photorealistic cinema, 65mm large-format film texture',
    )
  })
})

describe('a place for a video prompt', () => {
  it('keeps its look and drops the compass geography, which read against a shot as another camera direction', () => {
    const kethra =
      'A vast alien desert: dunes surround a flat salt plain. From the establishing camera on the dune crest, looking east: three giant planets hang over the plain. North of the plain (screen left): tall black basalt spires. A colossal ringed structure lies buried beneath the salt.'
    expect(withoutCompass(kethra)).toBe('A vast alien desert: dunes surround a flat salt plain. A colossal ringed structure lies buried beneath the salt.')
    expect(withoutCompass('Looking north from the gate: the yard.')).toBe('Looking north from the gate: the yard.')
  })

  it('one person: no camera-axis rule, no "everyone" or "screen position" — their looks kept by name', () => {
    const kael: StoryCharacter = { id: 'k', name: 'Kael', description: 'Kael, 38, lean man; sand-coloured cloak' }
    const reveal = [
      shot('a', 3, { shotType: 'HIGH-ANGLE MEDIUM FULL', prompt: 'Kael lowers his gaze to his boots.', characterIds: ['k'] }),
      shot('b', 3, { shotType: 'AERIAL EXTREME WIDE', prompt: 'Rings of dark metal emerge around Kael.', characterIds: ['k'] }),
    ]
    const { total, cuts } = planCuts(reveal, 6)
    const text = multishotPrompt(cuts, total, [kael], '', { blocking: 'Kael alone at the centre of the salt plain' })
    expect(text).toContain("Kael alone at the centre of the salt plain. Keep Kael's face, hair and clothes the same across every cut.")
    expect(text).not.toMatch(/camera axis|everyone|screen position|same side of the action/i)
    expect(text).toContain('A hard cut transitions to an aerial extreme wide shot')
  })
})
