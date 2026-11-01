import { KLING_MAX_SHOTS, KLING_MAX_SHOT_CHARS, multiShotProblem, parseMultiShot, resolveShotDurations } from '@shared/models/multishot'
import { getModel } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import { workflowFor } from '@shared/models/workflow'
import type { StoryCharacter, StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { type Cut, SHRINK_LADDER, type ClipKnobs, fitClip, fitMultishotPrompt, multishotPrompt, planCuts } from '../multishot'
import { type MultishotPlan, type PlanContext, planMultishot, planVideo, storySettings, videoSubjects } from '../planning'
import { NO_SUBTITLES } from '../soundtrack'
import {
  type ClipContext,
  type CompiledClip,
  PRESERVE_CHARACTERS,
  compileClip,
  compilerFor,
  cutPoints,
  endingOf,
  lowercaseEnglish,
  timestamp,
  wholeSeconds,
} from '.'

// ------------------------------------------------------------------------------------ fixtures

const READY = new Set(['maja-front', 'tymon-front', 'maja-voice', 'station-photo', 'kf1', 'kf2', 'kf3'])

const maja: StoryCharacter = {
  id: 'maja',
  name: 'Maja',
  description: 'a woman in her thirties with short dark hair, wearing a green raincoat',
  refAssetId: 'maja-front',
  voiceSampleAssetId: 'maja-voice',
  kling: { elementId: 'el-maja', syncedAt: '2026-10-01T00:00:00.000Z', sourceAssetIds: ['maja-front'] },
}
const tymon: StoryCharacter = { id: 'tymon', name: 'TYMON', description: 'a tall man with a grey beard; navy wool coat', refAssetId: 'tymon-front' }
const narrator: StoryCharacter = { id: 'nar', name: 'Narrator', description: 'Voice of the station announcer' }
const CAST = [maja, tymon, narrator]

function shot(id: string, duration: number, extra: Partial<StoryShot> = {}): StoryShot {
  return { id, scene: 'EXT. STATION', placeId: 'station', description: '', prompt: '', duration, characterIds: [], dialogue: [], videoGenerationIds: [], ...extra }
}

const S1 = shot('s1', 4, {
  shotType: 'wide',
  camera: 'slow push in',
  prompt: 'Maja waits at the ticket machine while Tymon sits on the bench.',
  characterIds: ['maja', 'tymon'],
  dialogue: [{ id: 'l1', characterId: 'maja', text: 'The train is late again.' }],
  sfx: 'distant train horn',
  keyframeAssetId: 'kf1',
})
const S2 = shot('s2', 3, {
  shotType: 'medium close-up',
  camera: 'static',
  prompt: 'Tymon looks up from his newspaper and smiles.',
  characterIds: ['tymon'],
  partialIds: ['maja'],
  dialogue: [{ id: 'l2', characterId: 'tymon', text: '[dry] Maja, it always is. Ask NASA.' }],
  keyframeAssetId: 'kf2',
})
const S3 = shot('s3', 5, {
  shotType: 'close-up',
  prompt: 'Maja checks her phone and sighs.',
  characterIds: ['maja'],
  dialogue: [{ id: 'l3', characterId: 'nar', text: 'The 6:40 to Gdansk is delayed.' }],
  keyframeAssetId: 'kf3',
})

function story(shots: StoryShot[] = [S1, S2, S3]): StoryDoc {
  return {
    script: '',
    style: 'Cinematic 35mm film, muted colours',
    characters: CAST,
    places: [
      {
        id: 'station',
        name: 'Station platform',
        description: 'A small suburban train platform with a ticket machine and a yellow bench.',
        refAssetIds: ['station-photo'],
        blocking: 'Maja on the left at the ticket machine, Tymon on the right by the bench',
        light: 'low evening sun from the left, warm',
      },
    ],
    shots,
    multishots: [{ id: 'g1', shotIds: shots.map((s) => s.id), videoGenerationIds: [] }],
    videoSettings: { resolution: '1080p', audio: true },
  }
}

const context = (s: StoryDoc): PlanContext => ({
  story: s,
  aspect: '16:9',
  assetReady: (id) => Boolean(id && READY.has(id)),
  keyframeOf: (x) => (x.keyframeAssetId && READY.has(x.keyframeAssetId) ? { id: x.keyframeAssetId } : undefined),
  settingsFor: (model, final) => storySettings(s, model, final),
})

const model = (id: string): ModelSpec => {
  const m = getModel(id)
  if (!m) throw new Error(`No model ${id}`)
  return m
}

const groupPlan = (s: StoryDoc, id: string): MultishotPlan => {
  const plan = planMultishot(context(s), s.multishots![0]!, model(id))
  if (typeof plan === 'string') throw new Error(plan)
  return plan
}

const PLACE = { name: 'Station platform', description: 'A small suburban train platform with a ticket machine and a yellow bench.' }
const clipOf = (cuts: Cut[], total: number, context: ClipContext = {}) => ({ cuts, total, characters: CAST, style: 'Cinematic', context: { place: PLACE, ...context } })

// ------------------------------------------------------------------------------------ the ladder

describe('fitClip', () => {
  it('tries the ladder in order with the context on top, and returns the first clip that fits', () => {
    const seen: ClipKnobs[] = []
    const out = fitClip(
      (opts) => {
        seen.push({ ...opts })
        return { prompt: JSON.stringify(opts), step: seen.length }
      },
      (clip) => clip.step === 4,
      { looks: 'full' as const, tag: 'ctx' },
    )
    expect(out.step).toBe(4)
    expect(seen).toHaveLength(4)
    // The context wins over the ladder's knobs (fitMultishotPrompt's order).
    expect(seen.every((k) => k.looks === 'full' && (k as { tag?: string }).tag === 'ctx')).toBe(true)
    // The place's photo text is shortened before the sounds go.
    expect(seen.map((k) => [k.sceneShort, k.sound, k.dialogue])).toEqual([
      [undefined, undefined, undefined],
      [true, undefined, undefined],
      [true, false, undefined],
      [true, false, undefined],
    ])
  })

  it('walks scene → sound → short looks → shot length 900/650/450/300 → dialogue → no looks, and returns the last when nothing fits', () => {
    const seen: ClipKnobs[] = []
    const out = fitClip(
      (opts) => (seen.push(opts), opts),
      () => false,
    )
    expect(seen).toEqual(SHRINK_LADDER)
    expect(seen.map((k) => k.maxShotChars).filter(Boolean)).toEqual([900, 650, 450, 300, 300, 300])
    // The dialogue goes only after every shot is shortened: a model that speaks the lines keeps them longest.
    expect(seen.findIndex((k) => k.dialogue === false)).toBe(seen.findIndex((k) => k.maxShotChars === 300) + 1)
    expect(out).toEqual({ sceneShort: true, sound: false, dialogue: false, looks: 'none', maxShotChars: 300 })
  })

  it('is what fitMultishotPrompt runs: the LTX compiler gives the same prompts, each look said once', () => {
    const { total, cuts } = planCuts([S1, S2], 10)
    const fits = (p: string) => !p.includes('Ambient sound')
    const ctx: ClipContext = { blocking: 'Maja on the left', light: 'warm', styleAsIs: true }
    const once = (k: ClipKnobs) => ({ ...k, looks: k.looks === 'none' ? ('none' as const) : ('once' as const) })
    expect(compileClip(compilerFor('ltx'), { cuts, total, characters: CAST, style: 'Doc', context: ctx }, (c) => fits(c.prompt)).prompt).toBe(
      fitClip((k) => multishotPrompt(cuts, total, CAST, 'Doc', { ...once(k), ...ctx }), fits),
    )
    expect(compilerFor('generic').clip({ cuts, total, characters: CAST, style: 'Doc', context: {} }).prompt).toBe(multishotPrompt(cuts, total, CAST, 'Doc', { looks: 'once' }))
    // The ladder itself, as fitMultishotPrompt walks it, is unchanged.
    expect(fitMultishotPrompt(cuts, total, CAST, 'Doc', fits, ctx)).toBe(fitClip((k) => multishotPrompt(cuts, total, CAST, 'Doc', k), fits, ctx))
  })
})

describe('wholeSeconds', () => {
  it('rounds the cut points to whole seconds that add up to the clip, each at least 1 s', () => {
    const shots = [shot('a', 1.4), shot('b', 2.2), shot('c', 0.5), shot('d', 3.9), shot('e', 1), shot('f', 2.6)]
    for (const total of [6, 7, 9, 15]) {
      const { cuts } = planCuts(shots, total)
      const d = wholeSeconds(cuts, total)
      expect(d.reduce((a, b) => a + b, 0), String(total)).toBe(total)
      expect(d.every((x) => Number.isInteger(x) && x >= 1), String(total)).toBe(true)
    }
    expect(wholeSeconds(planCuts([shot('a', 4), shot('b', 3)], 15).cuts, 7)).toEqual([4, 3])
    expect(cutPoints([4, 3, 2])).toEqual([4, 7])
  })
})

describe('lowercaseEnglish', () => {
  it('lowers the sentence starts and keeps I, acronyms, the Cast’s names and proper nouns inside a sentence', () => {
    expect(lowercaseEnglish('The train is late again.', [])).toBe('the train is late again.')
    expect(lowercaseEnglish("Maja, it always is. Ask NASA. I'm off to Paris.", ['Maja'])).toBe("Maja, it always is. ask NASA. I'm off to Paris.")
    expect(lowercaseEnglish('No. TYMON said "Wait".', ['TYMON'])).toBe('no. TYMON said "wait".')
  })
})

// ------------------------------------------------------------------------------------ Kling

describe('Kling dialect', () => {
  const kling = compilerFor('kling')
  const speech = workflowFor(model('kling-3.0')).speech

  it('sets the scene first, then one line per shot with framing and whole seconds adding up to the clip', () => {
    const { total, cuts } = planCuts([S1, S2, S3], 15)
    const out = kling.clip(clipOf(cuts, total, { speech, light: 'warm', blocking: 'Maja on the left' }))
    const [setup, lines] = out.prompt.split('\n\n')
    expect(setup).toBe(
      'Cinematic. A small suburban train platform with a ticket machine and a yellow bench. Light: warm. Maja: a woman in her thirties with short dark hair, wearing a green raincoat. Tymon: a tall man with a grey beard; navy wool coat. Maja on the left.',
    )
    expect(lines!.split('\n')).toHaveLength(3)
    expect(lines).toMatch(/^Shot 1 \(wide shot, 4s\): Maja waits at the ticket machine while Tymon sits on the bench\. Camera: slow push in\./)
    expect(out.shots!.map((s) => s.duration)).toEqual([4, 3, 5])
    expect(out.shots!.reduce((a, s) => a + s.duration, 0)).toBe(total)
  })

  it('binds each line to its speaker with tone and language, English in lower case, a narrator as a voiceover', () => {
    const track = (s: StoryShot, language?: string) => kling.soundtrack(s, CAST, { speech, language })
    expect(track(S1)).toBe('Maja (natural, English): "the train is late again." Sound: distant train horn.')
    expect(track(S2)).toBe('Tymon (dry, English): "Maja, it always is. ask NASA."')
    expect(track(S3)).toBe('Voiceover (natural): "the 6:40 to Gdansk is delayed."')
    // A line Kling can't voice in its own languages is labelled as it is (the UI warns), never lowered.
    expect(track(S1, 'Polish')).toBe('Maja (natural, Polish): "The train is late again." Sound: distant train horn.')
    // Off-screen: in the scene but not in this shot.
    expect(kling.soundtrack({ ...S3, dialogue: [{ id: 'x', characterId: 'tymon', text: 'Hurry.' }] }, CAST, { speech })).toBe(
      'Tymon (off-screen, natural, English): "hurry."',
    )
  })

  it('names element characters by their token in the shot text, never inside a spoken line', () => {
    const subjects = new Map([['maja', '@element_1']])
    const { total, cuts } = planCuts([S1, S2], 15)
    const out = kling.clip(clipOf(cuts, total, { speech, subjects }))
    expect(out.prompt).toContain('@element_1 is Maja, a woman in her thirties')
    expect(out.prompt).toContain('@element_1 waits at the ticket machine')
    expect(out.prompt).toContain('@element_1 (natural, English): "the train is late again."')
    expect(out.prompt).toContain('"Maja, it always is. ask NASA."')
  })

  it('as a shot list: "Shot n (Xs):" lines only, the setup in shot 1, every shot within 512 characters', () => {
    const wordy = (s: StoryShot) => ({ ...s, prompt: `${s.prompt} ${'The wind tugs at coats and newspapers along the platform. '.repeat(14)}` })
    const shots = [S1, S2, S3, S1, S2, S3].map((s, i) => ({ ...wordy(s), id: `w${i}` }))
    const { total, cuts } = planCuts(shots, 15)
    const ctx: ClipContext = { speech, shotList: true, shotLimit: KLING_MAX_SHOT_CHARS, light: 'warm', blocking: 'Maja on the left' }
    const out = compileClip(kling, clipOf(cuts, total, ctx), (c) => c.shots!.every((s) => s.prompt.length <= KLING_MAX_SHOT_CHARS))
    expect(out.shots).toHaveLength(KLING_MAX_SHOTS)
    for (const s of out.shots!) expect(s.prompt.length).toBeLessThanOrEqual(KLING_MAX_SHOT_CHARS)
    expect(out.shots![0]!.prompt.startsWith('Cinematic.')).toBe(true)
    const parsed = parseMultiShot(out.prompt)!
    expect(parsed.shots.map((s) => s.seconds)).toEqual(out.shots!.map((s) => s.duration))
    expect(multiShotProblem(parsed.shots, total)).toBeNull()
  })

  it('writes a single shot as one paragraph ending in one continuous take', () => {
    const text = kling.shot({ shot: S1, characters: CAST, style: 'Cinematic', camera: 'slow push in', context: { speech, place: PLACE }, speaks: true, fits: () => true })
    expect(text).not.toContain('\n')
    expect(text.startsWith('Cinematic. A small suburban train platform')).toBe(true)
    expect(text).toContain('Wide shot. Maja waits at the ticket machine while Tymon sits on the bench. Camera: slow push in. Maja (natural, English): "the train is late again."')
    expect(text.endsWith('One continuous take.')).toBe(true)
  })
})

describe('Kling plans', () => {
  it('direct Kling 3.0: the group goes in as the native shot list with multiShot on, parsing to the planned cuts', () => {
    const s = story()
    const plan = groupPlan(s, 'kling-3.0')
    expect(plan.params.multiShot).toBe(true)
    expect(plan.params.firstFrame).toBe('kf1')
    // The keyframe and the synced character together ('both'), named @element_1 in the shot text.
    expect(plan.params.elements).toEqual(['el-maja'])
    const parsed = parseMultiShot(String(plan.params.prompt))!
    const seconds = resolveShotDurations(parsed.shots, plan.total).map((x) => x.seconds)
    expect(seconds.reduce((a, b) => a + b, 0)).toBe(plan.total)
    expect(cutPoints(seconds)).toEqual(plan.planned)
    expect(model('kling-3.0').validate!(plan.params)).toBeNull()
    expect(plan).toMatchObject({ total: 12, planned: [4, 7] })
    expect(String(plan.params.prompt)).toMatchInlineSnapshot(`
      "Shot 1 (4s): Cinematic 35mm film, muted colours, no subtitles, no on-screen text. Setting: Station platform. Light: low evening sun from the left, warm. @element_1 on the left at the ticket machine, Tymon on the right by the bench. Wide shot. @element_1 waits at the ticket machine while Tymon sits on the bench. Camera: slow push in. @element_1 (natural, English): "the train is late again." Sound: distant train horn.
      Shot 2 (3s): Medium close-up shot. Tymon looks up from his newspaper and smiles. Camera: static. Tymon (dry, English): "Maja, it always is. ask NASA."
      Shot 3 (5s): Close-up shot. @element_1 checks her phone and sighs. Voiceover (natural): "the 6:40 to Gdansk is delayed.""
    `)
  })

  it('direct Kling: a shot list that would not parse back falls back to one prompt without the switch', () => {
    const s = story([S1, { ...S2, prompt: 'Tymon smiles. Shot 3: he waves.' }])
    const plan = groupPlan(s, 'kling-3.0')
    expect(plan.params.multiShot).toBe(false)
    expect(String(plan.params.prompt)).toContain('\n\nShot 1 (wide shot, 4s):')
  })

  it('fal Kling 3.0: the group goes in as its multiPrompt shot list, the scene setup in shot 1, no multiShot', () => {
    const plan = groupPlan(story(), 'fal-kling-3.0')
    expect(plan.params).not.toHaveProperty('multiShot')
    const shots = plan.params.multiPrompt as { prompt: string; duration: number }[]
    expect(shots.map((x) => x.duration)).toEqual([4, 3, 5])
    expect(shots.reduce((a, x) => a + x.duration, 0)).toBe(plan.params.duration)
    expect(cutPoints(shots.map((x) => x.duration))).toEqual(plan.planned)
    expect(shots[0]!.prompt).toContain('Light: low evening sun from the left, warm.')
    expect(shots[1]!.prompt.startsWith('Medium close-up shot.')).toBe(true)
    for (const x of shots) expect(x.prompt.length).toBeLessThanOrEqual(KLING_MAX_SHOT_CHARS)
    // Spoken lines stay off the screen through the negative prompt it now has.
    expect(plan.params.negativePrompt).toBe(NO_SUBTITLES)
    expect(model('fal-kling-3.0').validate!(plan.params)).toBeNull()
  })

  it('a single direct Kling shot: the synced character as element 1, never a shot list', () => {
    const s = story()
    const plan = planVideo(context(s), S1, model('kling-3.0'))
    expect(plan.params.elements).toEqual(['el-maja'])
    expect(plan.params.multiShot).toBe(false)
    expect(String(plan.params.prompt)).toContain('@element_1 waits at the ticket machine while Tymon sits on the bench')
  })
})

// ------------------------------------------------------------------------------------ Veo

describe('Veo dialect', () => {
  const veo = compilerFor('veo')
  const segments = (prompt: string) => [...prompt.matchAll(/^\[(\d\d):(\d\d)-(\d\d):(\d\d)\] /gm)].map((m) => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])])

  it('timestamps the shots back to back from 0 s to the end of the clip', () => {
    const shots = [shot('a', 1.4), shot('b', 2.2), shot('c', 0.5), shot('d', 3.9)].map((x) => ({ ...x, prompt: 'Rain falls.' }))
    for (const total of [4, 6, 8]) {
      const { cuts } = planCuts(shots, total)
      const out = veo.clip(clipOf(cuts, total))
      const ts = segments(out.prompt)
      expect(ts).toHaveLength(4)
      expect(ts[0]![0]).toBe(0)
      expect(ts.at(-1)![1]).toBe(total)
      ts.slice(1).forEach(([start], i) => expect(start).toBe(ts[i]![1]))
      ts.forEach(([a, b]) => expect(b).toBeGreaterThan(a!))
    }
    expect(timestamp(75)).toBe('01:15')
  })

  it('writes the dialogue as "says in a … voice", a narrator, SFX and the place’s ambient noise', () => {
    expect(veo.soundtrack(S1, CAST)).toBe('Maja says in a natural voice, "The train is late again." SFX: distant train horn.')
    expect(veo.soundtrack(S2, CAST)).toBe('Tymon says in a dry voice, "Maja, it always is. Ask NASA."')
    expect(veo.soundtrack(S3, CAST)).toBe('A narrator says in a natural voice, "The 6:40 to Gdansk is delayed."')
    const { total, cuts } = planCuts([S1, S2], 8)
    expect(veo.clip(clipOf(cuts, total)).prompt).toContain('Ambient noise: the natural ambience of Station platform, continuous across every cut.')
  })

  it('plans the group as timestamps on an 8 s clip, positive phrasing, subtitles kept out by the negative prompt', () => {
    const s = story([S1, S2])
    s.multishots![0]!.source = 'keyframe'
    const plan = groupPlan(s, 'fal-veo3.1')
    expect(plan.params.firstFrame).toBe('kf1')
    expect(plan.params.referenceImages).toBeUndefined()
    expect(plan.total).toBe(8)
    expect(plan.planned).toEqual([5])
    expect(plan.params.negativePrompt).toBe(NO_SUBTITLES)
    expect(String(plan.params.prompt)).not.toMatch(/\bno (subtitles|on-screen)/i)
    expect(segments(String(plan.params.prompt))).toEqual([
      [0, 5],
      [5, 8],
    ])
    expect(String(plan.params.prompt)).toMatchInlineSnapshot(`
      "Maja: a woman in her thirties with short dark hair, wearing a green raincoat. Tymon: a tall man with a grey beard; navy wool coat. A small suburban train platform with a ticket machine and a yellow bench. Light: low evening sun from the left, warm. Maja on the left at the ticket machine, Tymon on the right by the bench.

      [00:00-00:05] Wide shot: Maja waits at the ticket machine while Tymon sits on the bench. Camera: slow push in. Maja says in a natural voice, "The train is late again." SFX: distant train horn.
      [00:05-00:08] Medium close-up shot: Tymon looks up from his newspaper and smiles. Camera: static. Tymon says in a dry voice, "Maja, it always is. Ask NASA."

      Ambient noise: the natural ambience of Station platform, continuous across every cut.

      Cinematic 35mm film, muted colours."
    `)
  })
})

// ------------------------------------------------------------------------------------ Happy Horse

describe('Happy Horse dialect', () => {
  it('names the references character1…N in reference order, beats from "Begin with" to "End on", closing on the cast’s appearance', () => {
    const s = story([{ ...S1, keyframeAssetId: undefined }, S2, S3])
    // Picked: Auto now renders from the keyframe (13.10).
    s.multishots![0]!.source = 'references'
    const plan = groupPlan(s, 'fal-happy-horse-1.1')
    const prompt = String(plan.params.prompt)
    expect(plan.params.referenceImages).toEqual(['maja-front', 'tymon-front'])
    expect(plan.params.firstFrame).toBeUndefined()
    expect(prompt).not.toMatch(/Image \d/)
    expect(prompt).toContain('character1 is Maja, a woman in her thirties')
    expect(prompt).toContain('character2 is Tymon, a tall man with a grey beard')
    expect(prompt).toContain('character1 says in a natural voice: "The train is late again."')
    expect(prompt).toContain('A narrator says in a natural voice: "The 6:40 to Gdansk is delayed."')
    expect(prompt.split('\n\n').map((p) => p.split(' ').slice(0, 2).join(' '))).toEqual(['Cinematic 35mm', 'Begin with', 'Cut to', 'End on', 'Preserve the'])
    expect(prompt.endsWith(PRESERVE_CHARACTERS)).toBe(true)
  })

  it('takes references or a start frame, never both', () => {
    const s = story()
    const ctx = context(s)
    const hh = model('fal-happy-horse-1.1')
    const fromFrame = planVideo(ctx, S1, hh).params
    expect(fromFrame.firstFrame).toBe('kf1')
    expect(fromFrame.referenceImages).toBeUndefined()
    const fromRefs = planVideo(ctx, { ...S1, keyframeAssetId: undefined }, hh).params
    expect(fromRefs.firstFrame).toBeUndefined()
    expect(fromRefs.referenceImages).toEqual(['maja-front', 'tymon-front'])
    expect(String(fromRefs.prompt)).toContain('character1 waits at the ticket machine while character2 sits on the bench')
    expect(String(fromRefs.prompt).endsWith(PRESERVE_CHARACTERS)).toBe(true)
    const group = groupPlan(s, 'fal-happy-horse-1.1').params
    expect(Boolean(group.firstFrame) && Boolean((group.referenceImages as string[] | undefined)?.length)).toBe(false)
  })
})

// ------------------------------------------------------------------------------------ the cast's tokens

describe('videoSubjects', () => {
  it('names the references with the model’s token; voice samples only for LTX', () => {
    const s = story()
    const tokens = (id: string) => {
      const refs = videoSubjects(context(s), model(id), [S1])
      return { tokens: [...(refs?.tokens.values() ?? [])], voices: [...(refs?.voices.values() ?? [])], scene: refs?.scene?.token }
    }
    expect(tokens('runpod-ltx-2.5')).toEqual({ tokens: ['Image 1', 'Image 2'], voices: ['Audio 1'], scene: 'Image 3' })
    expect(tokens('fal-happy-horse-1.1')).toEqual({ tokens: ['character1', 'character2'], voices: [], scene: undefined })
    // Kling's own API takes elements (library ids), Kling on fal elements made from the Cast — not reference images.
    expect(videoSubjects(context(s), model('kling-3.0-omni'), [S1])).toBeUndefined()
    expect(videoSubjects(context(s), model('fal-kling-o3'), [S1])).toBeUndefined()
    expect(tokens('fal-veo3.1')).toEqual({ tokens: ['Maja', 'Tymon'], voices: [], scene: undefined })
  })
})

// A compiled clip's shots, when it has them, always add up to the clip.
describe('every timed dialect', () => {
  it('returns shots whose lengths add up to the clip', () => {
    const { total, cuts } = planCuts([S1, S2, S3], 12)
    for (const d of ['kling', 'veo'] as const) {
      const out: CompiledClip = compilerFor(d).clip(clipOf(cuts, total))
      expect(out.shots!.reduce((a, s) => a + s.duration, 0), d).toBe(total)
    }
  })
})

// ------------------------------------------------------------------------------------ review fixes

describe('review fixes', () => {
  it('keeps shot 1’s own action and line in a Kling shot list when the style alone fills the shot', () => {
    const longStyle = `${'Photorealistic luxury commercial with deep shadows and brass highlights, '.repeat(8)}35mm`
    const cuts = planCuts([S1, S2], 10).cuts
    const out = compileClip(compilerFor('kling'), { ...clipOf(cuts, 7, { shotList: true, shotLimit: KLING_MAX_SHOT_CHARS }), style: longStyle }, () => true)
    const first = out.shots![0]!.prompt
    expect(first.length).toBeLessThanOrEqual(KLING_MAX_SHOT_CHARS)
    expect(first).toContain('Maja waits at the ticket machine')
    expect(first).toContain('“The train is late again.”'.replace(/[“”]/g, '"'))
  })

  it('timestamps to the nearest second across a minute', () => {
    expect(timestamp(59.6)).toBe('01:00')
    expect(timestamp(4)).toBe('00:04')
    expect(timestamp(72.2)).toBe('01:12')
  })

  it('sends the style’s “no …” phrases as the negative prompt where it works, and leaves LTX as it was', () => {
    const s = { ...story(), style: 'Cinematic 35mm film, no subtitles, no watermarks' }
    const silent = { ...s, shots: s.shots.map((x) => ({ ...x, dialogue: [] })) }
    expect(planVideo(context(silent), silent.shots[0]!, model('fal-veo3.1')).params.negativePrompt).toBe('subtitles, watermarks')
    // With lines: the spoken-lines guard plus the style's own, each term once.
    expect(planVideo(context(s), s.shots[0]!, model('fal-veo3.1')).params.negativePrompt).toBe(`${NO_SUBTITLES}, watermarks`)
    // LTX: its negative prompt does nothing at CFG 1 — only the spoken-lines guard, as before.
    expect(planVideo(context(silent), silent.shots[0]!, model('runpod-ltx-2.5')).params.negativePrompt).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------ the ending

describe('the ending in the prompt', () => {
  // The user's idea: an end picture that barely differs from the start froze the clip, so the end is said in words too.
  const END = 'Same framing as the start; the phone is no longer in her hand, it lies face down on the bench. Maja stands at screen left, arms crossed, looking toward the tracks.'
  const ending = endingOf({ endFrame: END })

  it('is the end frame’s first sentence, without an opening that only says the camera stays, at most 30 words', () => {
    expect(ending).toBe('The phone is no longer in her hand, it lies face down on the bench.')
    expect(endingOf({ endFrame: 'The phone is no longer on the floor; it is in her raised hand.' })).toBe('The phone is no longer on the floor; it is in her raised hand.')
    expect(endingOf({ endFrame: 'From exactly the same camera, the tower has risen out of the water' })).toBe('The tower has risen out of the water.')
    const long = `The rings rise ${'higher and higher '.repeat(12)}out of the salt; Kael stands among them.`
    expect(endingOf({ endFrame: long })!.split(' ').length).toBeLessThanOrEqual(30)
    expect(endingOf({ endFrame: '  ' })).toBeUndefined()
    expect(endingOf({})).toBeUndefined()
  })

  it('every dialect says it after the action — LTX before the camera', () => {
    const input = (fromFrame: boolean) => ({ shot: S3, characters: CAST, style: 'Cinematic', camera: 'handheld', context: { place: PLACE }, speaks: false, fromFrame, ending, fits: () => true })
    const said = 'At the end of the shot, the phone is no longer in her hand, it lies face down on the bench.'
    expect(compilerFor('ltx').shot(input(true))).toBe(`Maja checks her phone and sighs. ${said} A handheld camera.`)
    expect(compilerFor('ltx').shot(input(false))).toContain(`Maja checks her phone and sighs. ${said}`)
    expect(compilerFor('kling').shot(input(true))).toContain(`Maja checks her phone and sighs. Camera: handheld. ${said}`)
    expect(compilerFor('veo').shot(input(true))).toContain(`Maja checks her phone and sighs. ${said}`)
    expect(compilerFor('happyhorse').shot(input(true))).toContain(`Camera: handheld. ${said}`)
    // A name keeps its capital.
    expect(compilerFor('ltx').shot({ ...input(true), ending: 'Maja holds the phone up.' })).toContain('At the end of the shot, Maja holds the phone up.')
  })

  it('planVideo says it whether or not the end picture goes along', () => {
    const s = story()
    const shot = { ...S3, endFrame: END }
    const words = String(planVideo(context(s), shot, model('runpod-ltx-2.5')).params.prompt)
    expect(words).toContain('At the end of the shot, the phone is no longer in her hand')
    const ctx: PlanContext = { ...context(s), endKeyframeOf: () => ({ id: 'end3' }) }
    // Measured as the same camera with a visible change: the picture goes too.
    const both = planVideo(ctx, { ...shot, endCheck: { startId: 'kf3', endId: 'end3', ssim: 0.43 } }, model('runpod-ltx-2.5')).params
    expect(both.lastFrame).toBe('end3')
    expect(String(both.prompt)).toContain('At the end of the shot, the phone is no longer in her hand')
    // Held back (barely different from the start): the words alone.
    const held = planVideo(ctx, { ...shot, endCheck: { startId: 'kf3', endId: 'end3', ssim: 0.96 } }, model('runpod-ltx-2.5')).params
    expect(held.lastFrame).toBeUndefined()
    expect(String(held.prompt)).toContain('At the end of the shot, the phone is no longer in her hand')
    expect(String(planVideo(context(s), shot, model('kling-3.0')).params.prompt)).toContain('At the end of the shot,')
  })
})
