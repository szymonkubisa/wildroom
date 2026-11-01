import { getModel } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import type { StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { parseParams } from '@shared/models/params'
import { countWords } from '@shared/text/speech'
import { cutPoints } from './dialects'
import {
  type MultishotPlan,
  type PlanContext,
  type VideoPlan,
  canUseSource,
  chosenModelId,
  rendersShotByShot,
  finalModelFor,
  videoSubjects,
  castPlan,
  followsVoices,
  groupCutPlan,
  groupLimitProblem,
  groupSource,
  isFinalTake,
  planMultishot,
  planVideo,
  sameFamily,
  sourceOfParams,
  type StillsContext,
  stillsWanted,
  storySettings,
  takeRecords,
} from './planning'

// Locks what the storyboard sends to each model today: any change in these snapshots changes real renders.

const READY = new Set(['maja-front', 'tymon-front', 'maja-voice', 'station-photo', 'kf1', 'kf2', 'kf3'])

function story(): StoryDoc {
  return {
    script: '',
    style: 'Cinematic 35mm film, muted colours',
    characters: [
      {
        id: 'maja',
        name: 'Maja',
        description: 'a woman in her thirties with short dark hair, wearing a green raincoat',
        refAssetId: 'maja-front',
        voiceSampleAssetId: 'maja-voice',
        kling: { elementId: 'el-maja', syncedAt: '2026-10-01T00:00:00.000Z', sourceAssetIds: ['maja-front'] },
      },
      { id: 'tymon', name: 'Tymon', description: 'a tall man with a grey beard, wearing a navy wool coat', refAssetId: 'tymon-front' },
    ],
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
    shots: [
      {
        id: 's1',
        scene: 'EXT. STATION - EVENING',
        placeId: 'station',
        description: 'Wide of the platform',
        shotType: 'wide',
        camera: 'slow push in',
        prompt: 'Maja waits at the ticket machine while Tymon sits on the bench.',
        duration: 4,
        characterIds: ['maja', 'tymon'],
        dialogue: [{ id: 'l1', characterId: 'maja', text: 'The train is late again.' }],
        sfx: 'distant train horn',
        keyframeAssetId: 'kf1',
        videoGenerationIds: [],
      },
      {
        id: 's2',
        scene: 'EXT. STATION - EVENING',
        placeId: 'station',
        description: 'Tymon answers',
        shotType: 'medium close-up',
        camera: 'static',
        prompt: 'Tymon looks up from his newspaper and smiles.',
        duration: 3,
        characterIds: ['tymon'],
        partialIds: ['maja'],
        dialogue: [{ id: 'l2', characterId: 'tymon', text: 'It always is.' }],
        keyframeAssetId: 'kf2',
        videoGenerationIds: [],
      },
      {
        id: 's3',
        scene: 'EXT. STATION - EVENING',
        placeId: 'station',
        description: 'Maja checks the time',
        shotType: 'close-up',
        camera: 'handheld',
        prompt: 'Maja checks her phone and sighs.',
        duration: 5,
        characterIds: ['maja'],
        dialogue: [{ id: 'l3', characterId: 'maja', text: 'Twenty more minutes.' }],
        keyframeAssetId: 'kf3',
        videoGenerationIds: [],
      },
      {
        // No keyframe: rendered from the cast's references where the model takes them.
        id: 's4',
        scene: 'EXT. STATION - EVENING',
        placeId: 'station',
        description: 'They walk',
        shotType: 'medium',
        prompt: 'Maja and Tymon walk along the platform together.',
        duration: 5,
        characterIds: ['maja', 'tymon'],
        dialogue: [],
        videoGenerationIds: [],
      },
    ],
    multishots: [{ id: 'g1', shotIds: ['s1', 's2'], videoGenerationIds: [], source: 'references' }],
    videoSettings: { resolution: '1080p', audio: true },
    finalVideoSettings: { resolution: '4K', fps: 25 },
  }
}

function context(s: StoryDoc): PlanContext {
  return {
    story: s,
    aspect: '16:9',
    assetReady: (id) => Boolean(id && READY.has(id)),
    keyframeOf: (shot) => (shot.keyframeAssetId && READY.has(shot.keyframeAssetId) ? { id: shot.keyframeAssetId } : undefined),
    settingsFor: (model, final) => storySettings(s, model, final),
  }
}

const model = (id: string): ModelSpec => {
  const m = getModel(id)
  if (!m) throw new Error(`No model ${id}`)
  return m
}
const shotOf = (s: StoryDoc, id: string): StoryShot => s.shots.find((x) => x.id === id)!
const view = (plan: VideoPlan | string) => (typeof plan === 'string' ? plan : { ...plan, model: plan.model.id })

describe('planMultishot', () => {
  it('RunPod LTX from references: Image/Audio blocks, the place as referenceBackground, the voice sample, no start frame', () => {
    const s = story()
    const ctx = context(s)
    const ltx = model('runpod-ltx-2.5')
    expect(groupSource(ctx, s.multishots![0]!, ltx)).toBe('references')
    expect(view(planMultishot(ctx, s.multishots![0]!, ltx))).toMatchInlineSnapshot(`
      {
        "label": "Multi-shot · shots 1–2",
        "model": "runpod-ltx-2.5",
        "params": {
          "aspectRatio": "16:9",
          "audio": true,
          "duration": 7,
          "fps": 24,
          "guideKind": "layout",
          "guideStrength": 1,
          "negativePrompt": "subtitles, captions, on-screen text, written words, letters, watermark",
          "prompt": "A multi-shot sequence of 2 shots joined by hard cuts.

      Image 1: Maja: a woman in her thirties with short dark hair, wearing a green raincoat.

      Image 2: Tymon: a tall man with a grey beard, wearing a navy wool coat.

      Image 3: Scene, A small suburban train platform with a ticket machine and a yellow bench.

      Audio 1: Female voice, belongs only to Image 1.

      The camera stays on the same side of the action across every cut, never crossing or circling round it. Image 1 is always established on the left side of the frame and Image 2 on the right side. Keep Image 1's and Image 2's faces, hair and clothes the same across every cut. Low evening sun from the left, warm, the same in every shot.

      wide shot in Station platform matching Image 3. Image 1 waits at the ticket machine while Image 2 sits on the bench. Image 1 on the left at the ticket machine, Image 2 on the right by the bench. A slow push in.

      A hard cut transitions to a medium close-up shot. Image 2 looks up from his newspaper and smiles. Image 1 remains a soft blurred foreground shoulder at the left edge of the frame, and Image 2, on the right side of the frame, faces left toward Image 1. A static camera.

      Cinematic 35mm film, muted colours",
          "referenceBackground": "station-photo",
          "referenceImages": [
            "maja-front",
            "tymon-front",
          ],
          "resolution": "1080p",
          "voice1": "maja-voice",
        },
        "planned": [
          4,
        ],
        "total": 7,
      }
    `)
  })

  it('RunPod LTX from the first keyframe: start frame, cuts in prose, names instead of Image N', () => {
    const s = story()
    s.multishots![0]!.source = 'keyframe'
    const ctx = context(s)
    const ltx = model('runpod-ltx-2.5')
    expect(groupSource(ctx, s.multishots![0]!, ltx)).toBe('keyframe')
    expect(view(planMultishot(ctx, s.multishots![0]!, ltx))).toMatchInlineSnapshot(`
      {
        "label": "Multi-shot · shots 1–2",
        "model": "runpod-ltx-2.5",
        "params": {
          "aspectRatio": "16:9",
          "audio": true,
          "duration": 7,
          "firstFrame": "kf1",
          "fps": 24,
          "guideKind": "layout",
          "guideStrength": 1,
          "negativePrompt": "subtitles, captions, on-screen text, written words, letters, watermark",
          "prompt": "A multi-shot sequence of 2 shots joined by hard cuts.

      Maja: a woman in her thirties with short dark hair, wearing a green raincoat. Tymon: a tall man with a grey beard, wearing a navy wool coat.

      The camera stays on the same side of the action across every cut, never crossing or circling round it. Maja is always established on the left side of the frame and Tymon on the right side. Keep Maja's and Tymon's faces, hair and clothes the same across every cut. Low evening sun from the left, warm, the same in every shot.

      wide shot. Maja waits at the ticket machine while Tymon sits on the bench. A slow push in. Maja says in English in a female voice, natural and conversational, "The train is late again.", lips moving with the words, while Tymon listens silently with closed lips. Ambient sound: distant train horn.

      A hard cut transitions to a medium close-up shot. Tymon looks up from his newspaper and smiles. A static camera. Tymon says in English in a male voice, natural and conversational, "It always is.", lips moving with the words, while Maja listens silently with closed lips.

      Cinematic 35mm film, muted colours",
          "resolution": "1080p",
        },
        "planned": [
          4,
        ],
        "total": 7,
      }
    `)
  })

  it('a final render takes the final settings and label', () => {
    const s = story()
    expect(view(planMultishot(context(s), s.multishots![0]!, model('runpod-ltx-2.5'), { final: true }))).toMatchInlineSnapshot(`
      {
        "label": "Final multi-shot · shots 1–2",
        "model": "runpod-ltx-2.5",
        "params": {
          "aspectRatio": "16:9",
          "audio": true,
          "duration": 7,
          "fps": 25,
          "guideKind": "layout",
          "guideStrength": 1,
          "negativePrompt": "subtitles, captions, on-screen text, written words, letters, watermark",
          "prompt": "A multi-shot sequence of 2 shots joined by hard cuts.

      Image 1: Maja: a woman in her thirties with short dark hair, wearing a green raincoat.

      Image 2: Tymon: a tall man with a grey beard, wearing a navy wool coat.

      Image 3: Scene, A small suburban train platform with a ticket machine and a yellow bench.

      Audio 1: Female voice, belongs only to Image 1.

      The camera stays on the same side of the action across every cut, never crossing or circling round it. Image 1 is always established on the left side of the frame and Image 2 on the right side. Keep Image 1's and Image 2's faces, hair and clothes the same across every cut. Low evening sun from the left, warm, the same in every shot.

      wide shot in Station platform matching Image 3. Image 1 waits at the ticket machine while Image 2 sits on the bench. Image 1 on the left at the ticket machine, Image 2 on the right by the bench. A slow push in.

      A hard cut transitions to a medium close-up shot. Image 2 looks up from his newspaper and smiles. Image 1 remains a soft blurred foreground shoulder at the left edge of the frame, and Image 2, on the right side of the frame, faces left toward Image 1. A static camera.

      Cinematic 35mm film, muted colours",
          "referenceBackground": "station-photo",
          "referenceImages": [
            "maja-front",
            "tymon-front",
          ],
          "resolution": "4K",
          "voice1": "maja-voice",
        },
        "planned": [
          4,
        ],
        "total": 7,
      }
    `)
  })
})

describe('reference numbering', () => {
  it('numbers the people in the Cast\u2019s order in every clip, whoever appears first', () => {
    const s = story()
    // Tymon now opens the group: he still is Image 2, Maja Image 1.
    Object.assign(s.shots[0]!, { characterIds: ['tymon'], partialIds: ['maja'] })
    const plan = planMultishot(context(s), s.multishots![0]!, model('runpod-ltx-2.5')) as MultishotPlan
    expect(plan.params.referenceImages).toEqual(['maja-front', 'tymon-front'])
    expect(String(plan.params.prompt)).toContain('Image 1: Maja')
  })
})

describe('video references', () => {
  it('LTX gets the plain-background video reference; other models keep the front view', () => {
    const s = story()
    s.characters[0]!.videoRefAssetId = 'maja-video'
    const ctx = { ...context(s), assetReady: (id?: string) => Boolean(id && (READY.has(id) || id === 'maja-video')) }
    const refs = (id: string) => {
      const plan = planMultishot(ctx, s.multishots![0]!, model(id))
      return typeof plan === 'string' ? plan : plan.params.referenceImages
    }
    expect(refs('runpod-ltx-2.5')).toEqual(['maja-video', 'tymon-front'])
    expect(refs('fal-veo3.1')).toEqual(['maja-front', 'tymon-front'])
    // Not ready yet: the front view, as before.
    expect(planMultishot(context(s), s.multishots![0]!, model('runpod-ltx-2.5'))).toMatchObject({ params: { referenceImages: ['maja-front', 'tymon-front'] } })
  })
})

describe('planVideo', () => {
  it('local LTX from a keyframe, with dialogue', () => {
    const s = story()
    expect(view(planVideo(context(s), shotOf(s, 's3'), model('local-ltx-2.5')))).toMatchInlineSnapshot(`
      {
        "label": "Video · shot 3",
        "model": "local-ltx-2.5",
        "params": {
          "aspectRatio": "16:9",
          "audio": true,
          "duration": 5,
          "firstFrame": "kf3",
          "fps": 24,
          "mode": "fast",
          "negativePrompt": "subtitles, captions, on-screen text, written words, letters, watermark",
          "prompt": "Maja checks her phone and sighs. A handheld camera.

      Maja says in English in a female voice, natural and conversational, "Twenty more minutes.", lips moving with the words.",
          "quality": "standard",
        },
      }
    `)
  })

  it('Kling 3.0 (direct) passes a synced character as an element and mentions it as @element_1', () => {
    const s = story()
    expect(view(planVideo(context(s), shotOf(s, 's3'), model('kling-3.0')))).toMatchInlineSnapshot(`
      {
        "label": "Video · shot 3",
        "model": "kling-3.0",
        "params": {
          "aspectRatio": "16:9",
          "audio": true,
          "duration": 5,
          "elements": [
            "el-maja",
          ],
          "firstFrame": "kf3",
          "multiShot": false,
          "prompt": "Cinematic 35mm film, muted colours, no subtitles, no on-screen text. A small suburban train platform with a ticket machine and a yellow bench. Light: low evening sun from the left, warm. @element_1 is Maja, a woman in her thirties with short dark hair, wearing a green raincoat. @element_1 on the left at the ticket machine, Tymon on the right by the bench. Close-up shot. @element_1 checks her phone and sighs. Camera: handheld. @element_1 (natural, English): "twenty more minutes." One continuous take.",
          "resolution": "1080p",
        },
      }
    `)
  })

  it('Veo 3.1 from a keyframe, with dialogue: negative prompt against subtitles', () => {
    const s = story()
    expect(view(planVideo(context(s), shotOf(s, 's3'), model('fal-veo3.1')))).toMatchInlineSnapshot(`
      {
        "label": "Video · shot 3",
        "model": "fal-veo3.1",
        "params": {
          "aspectRatio": "16:9",
          "audio": true,
          "duration": 4,
          "firstFrame": "kf3",
          "negativePrompt": "subtitles, captions, on-screen text, written words, letters, watermark",
          "prompt": "Close-up shot. Camera: handheld. Maja: a woman in her thirties with short dark hair, wearing a green raincoat. Maja checks her phone and sighs. A small suburban train platform with a ticket machine and a yellow bench. Light: low evening sun from the left, warm. Maja on the left at the ticket machine, Tymon on the right by the bench. Cinematic 35mm film, muted colours.

      Maja says in a natural voice, "Twenty more minutes." Ambient noise: the natural ambience of Station platform.",
          "resolution": "1080p",
        },
      }
    `)
  })

  it('Happy Horse 1.1 without a keyframe: the cast as reference images', () => {
    const s = story()
    expect(view(planVideo(context(s), shotOf(s, 's4'), model('fal-happy-horse-1.1')))).toMatchInlineSnapshot(`
      {
        "label": "Video · shot 4",
        "model": "fal-happy-horse-1.1",
        "params": {
          "aspectRatio": "16:9",
          "duration": 5,
          "prompt": "Cinematic 35mm film, muted colours. A small suburban train platform with a ticket machine and a yellow bench. Light: low evening sun from the left, warm. character1 is Maja, a woman in her thirties with short dark hair, wearing a green raincoat. character2 is Tymon, a tall man with a grey beard, wearing a navy wool coat. character1 on the left at the ticket machine, character2 on the right by the bench. Medium shot. character1 and character2 walk along the platform together. Preserve the exact appearance of each character.",
          "referenceImages": [
            "maja-front",
            "tymon-front",
          ],
          "resolution": "1080p",
        },
      }
    `)
  })

  it('a final render takes the final settings and label', () => {
    const s = story()
    expect(view(planVideo(context(s), shotOf(s, 's3'), model('runpod-ltx-2.5'), { final: true }))).toMatchInlineSnapshot(`
      {
        "label": "Final · shot 3",
        "model": "runpod-ltx-2.5",
        "params": {
          "aspectRatio": "16:9",
          "audio": true,
          "duration": 5,
          "firstFrame": "kf3",
          "fps": 25,
          "guideKind": "layout",
          "guideStrength": 1,
          "negativePrompt": "subtitles, captions, on-screen text, written words, letters, watermark",
          "prompt": "Maja checks her phone and sighs. A handheld camera.

      Maja says in English in a female voice, natural and conversational, "Twenty more minutes.", lips moving with the words.",
          "resolution": "4K",
        },
      }
    `)
  })

  it('the model and `final` are independent: another model renders with the draft settings unless final', () => {
    const s = story()
    const ctx = context(s)
    const ltx = model('runpod-ltx-2.5')
    const draft = planVideo(ctx, shotOf(s, 's3'), ltx)
    const final = planVideo(ctx, shotOf(s, 's3'), ltx, { final: true })
    expect(draft.label).toBe('Video · shot 3')
    expect(draft.params).toMatchObject({ resolution: '1080p', fps: 24 })
    expect(final.label).toBe('Final · shot 3')
    expect(final.params).toMatchObject({ resolution: '4K', fps: 25 })
    expect({ ...final.params, resolution: undefined, fps: undefined }).toEqual({ ...draft.params, resolution: undefined, fps: undefined })
  })
})

describe('a shot with a Blender previs on Seedance (OpenRouter)', () => {
  const withPrevis = () => {
    const s = story()
    const s3 = shotOf(s, 's3')
    s3.previs = { assetId: 'layout', depthAssetId: 'depth' }
    s3.endUse = 'image'
    shotOf(s, 's4').previs = { assetId: 'layout4', depthAssetId: 'depth4' }
    const renders = new Set(['layout', 'depth', 'layout4', 'depth4'])
    const ctx: PlanContext = {
      ...context(s),
      assetReady: (id) => Boolean(id && (READY.has(id) || renders.has(id))),
      endKeyframeOf: (shot) => (shot.id === 's3' ? { id: 'kf3-end' } : undefined),
    }
    return { s, ctx, renders }
  }

  it('takes the clip’s length from the previs, and leaves out a render no longer in the project', () => {
    const { s, ctx, renders } = withPrevis()
    shotOf(s, 's3').previs!.frames = 241
    const ltx = model('runpod-ltx-2.5')
    expect(planVideo(ctx, shotOf(s, 's3'), ltx).params).toMatchObject({ guideVideo: 'layout', duration: 10 })
    // Rendered at another rate: 241 frames at 30 fps last about 8 s.
    shotOf(s, 's3').previs!.fps = 30
    expect(planVideo(ctx, shotOf(s, 's3'), ltx).params).toMatchObject({ duration: 8 })
    delete shotOf(s, 's3').previs!.fps
    renders.delete('layout')
    renders.delete('depth')
    expect(planVideo(ctx, shotOf(s, 's3'), ltx).params).not.toHaveProperty('guideVideo')
  })

  it('sends the keyframe and the grey box, keeps the guide over an end frame, and never a depth render', () => {
    const { s, ctx } = withPrevis()
    const seedance = model('or-seedance-2.5')
    const plan = planVideo(ctx, shotOf(s, 's3'), seedance)
    expect(plan.params).toMatchObject({ firstFrame: 'kf3', guideVideo: 'layout' })
    expect(plan.params).not.toHaveProperty('lastFrame')
    expect(parseParams(seedance, plan.params).ok).toBe(true)
    // Without a keyframe the grey box would set the look: no guide (the cast's references instead).
    expect(planVideo(ctx, shotOf(s, 's4'), seedance).params).not.toHaveProperty('guideVideo')
  })

  it('leaves RunPod LTX as it was: guide and end frame together, depth without a keyframe', () => {
    const { s, ctx } = withPrevis()
    const ltx = model('runpod-ltx-2.5')
    expect(planVideo(ctx, shotOf(s, 's3'), ltx).params).toMatchObject({ firstFrame: 'kf3', lastFrame: 'kf3-end', guideVideo: 'layout', guideKind: 'layout' })
    expect(planVideo(ctx, shotOf(s, 's4'), ltx).params).toMatchObject({ guideVideo: 'depth4', guideKind: 'depth' })
  })
})

describe('audio to follow: LTX dialogue shots made to their ElevenLabs lines', () => {
  const ltx = () => model('runpod-ltx-2.5')
  const voiced = (s: StoryDoc) => {
    s.characters[0]!.voiceId = 'v-maja'
    s.characters[1]!.voiceId = 'v-tymon'
    return s
  }

  it('renders the shot from its keyframe to its voice track, which sets the clip length', () => {
    const s = voiced(story())
    const ctx = { ...context(s), voiceTrackOf: (shot: StoryShot) => (shot.id === 's3' ? { id: 'track-s3', seconds: 6 } : undefined) }
    expect(followsVoices(s, s.shots[2]!, ltx())).toBe(true)
    const plan = planVideo(ctx, s.shots[2]!, ltx())
    expect(plan.params).toMatchObject({ firstFrame: 'kf3', audioClip: 'track-s3', duration: 6 })
    expect(plan.params.referenceImages).toBeUndefined()
    expect(parseParams(ltx(), plan.params).ok).toBe(true)
  })

  it('changes nothing without a voice track, or for a model without audio to follow', () => {
    const s = voiced(story())
    expect(planVideo(context(s), s.shots[2]!, ltx()).params.audioClip).toBeUndefined()
    expect(followsVoices(s, s.shots[2]!, model('kling-3.0'))).toBe(false)
    expect(followsVoices(s, s.shots[2]!, model('local-ltx-2.5'))).toBe(false)
  })

  it('needs every speaker on screen with an ElevenLabs voice, and no insert', () => {
    const s = story()
    expect(followsVoices(s, s.shots[2]!, ltx())).toBe(false) // no ElevenLabs voice yet
    voiced(s)
    expect(followsVoices(s, s.shots[3]!, ltx())).toBe(false) // nothing said
    expect(followsVoices(s, { ...s.shots[1]!, characterIds: [], partialIds: ['tymon'] }, ltx())).toBe(false) // speaker seen from behind
    expect(followsVoices(s, { ...s.shots[2]!, shotType: 'INSERT, hands on the phone' }, ltx())).toBe(false)
  })
})

describe('storySettings', () => {
  it('drops what the storyboard sets itself (multi-shot, camera move…), even when the model has the param', () => {
    const s = story()
    s.videoSettings = { resolution: '1080p', audio: true, multiShot: true, prompt: 'stale', duration: 9 }
    expect(storySettings(s, model('kling-3.0'), false)).toEqual({ resolution: '1080p', audio: true })
    s.videoSettings = { resolution: '720p', fps: 50, cameraMotion: 'dolly_in' }
    expect(storySettings(s, model('fal-ltx-2.5-pro'), false)).toEqual({ resolution: '720p', fps: 50 })
    s.finalVideoSettings = { resolution: '1080p', multiClip: true, seed: 7 }
    expect(storySettings(s, model('fal-pixverse-v6'), true)).toEqual({ resolution: '1080p' })
  })

  it('a stored multi-shot switch no longer reaches a Kling shot render', () => {
    const s = story()
    s.videoSettings = { resolution: '1080p', audio: true, multiShot: true }
    expect(planVideo(context(s), shotOf(s, 's3'), model('kling-3.0')).params.multiShot).toBe(false)
  })
})

describe('fal native features', () => {
  // Maja has her front view and two more angles; Tymon only a front view.
  const ANGLES = ['maja-side', 'maja-back']
  const withAngles = () => {
    const s = story()
    s.characters[0]!.refAssetIds = [...ANGLES]
    return s
  }
  const ctxOf = (s: StoryDoc): PlanContext => ({ ...context(s), assetReady: (id) => Boolean(id && (READY.has(id) || ANGLES.includes(id))) })
  const group = (s: StoryDoc) => s.multishots![0]!
  const multi = (plan: MultishotPlan | string): MultishotPlan => {
    if (typeof plan === 'string') throw new Error(plan)
    return plan
  }
  const accepts = (m: ModelSpec, params: Record<string, unknown>) => {
    const parsed = parseParams(m, params)
    return parsed.ok ? null : parsed.message
  }

  it('Kling 3.0 on fal: keyframe + elements ("both") — the start frame, Maja as @Element1 from her three views, the shot list as multiPrompt', () => {
    const s = withAngles()
    const ctx = ctxOf(s)
    const kling = model('fal-kling-3.0')
    // The group asks for references, which Kling 3.0 doesn't take without a start frame: the first that works.
    expect(groupSource(ctx, group(s), kling)).toBe('both')
    const plan = multi(planMultishot(ctx, group(s), kling))
    expect(plan.params.firstFrame).toBe('kf1')
    expect(plan.params.elementImages).toEqual(['maja-front', 'maja-side', 'maja-back'])
    expect(plan.params.elementCounts).toEqual([3])
    expect(plan.params.referenceImages).toBeUndefined()
    const shots = plan.params.multiPrompt as { prompt: string; duration: number }[]
    expect(shots.map((x) => x.duration)).toEqual([4, 3])
    expect(shots.reduce((a, x) => a + x.duration, 0)).toBe(plan.total)
    expect(plan.params.duration).toBe(plan.total)
    expect(cutPoints(shots.map((x) => x.duration))).toEqual(plan.planned)
    expect(shots[0]!.prompt).toContain('@Element1 waits at the ticket machine')
    // Tymon (a front view only) is no element: named in words.
    expect(JSON.stringify(shots)).not.toContain('@Element2')
    expect(shots[1]!.prompt).toContain('Tymon looks up from his newspaper')
    expect(kling.validate!(plan.params)).toBeNull()
    expect(accepts(kling, plan.params)).toBeNull()
  })

  it('Kling 3.0 on fal without any character with a second angle: the keyframe alone, no elements', () => {
    const s = story()
    const ctx = context(s)
    const kling = model('fal-kling-3.0')
    expect(canUseSource(ctx, group(s), kling, 'both')).toBe(false)
    expect(groupSource(ctx, group(s), kling)).toBe('keyframe')
    const plan = multi(planMultishot(ctx, group(s), kling))
    expect(plan.params.firstFrame).toBe('kf1')
    expect(plan.params.elementImages).toBeUndefined()
    expect(plan.params.multiPrompt).toBeDefined()
  })

  it('a single fal Kling 3.0 shot from its keyframe takes the angled characters as elements', () => {
    const s = withAngles()
    const kling = model('fal-kling-3.0')
    const params = planVideo(ctxOf(s), shotOf(s, 's1'), kling).params
    expect(params).toMatchObject({ firstFrame: 'kf1', elementImages: ['maja-front', 'maja-side', 'maja-back'], elementCounts: [3] })
    expect(String(params.prompt)).toContain('@Element1 waits at the ticket machine while Tymon sits on the bench')
    // No keyframe: Kling 3.0 takes no elements, the shot is text-to-video.
    const bare = planVideo(ctxOf(s), shotOf(s, 's4'), kling).params
    expect(bare.elementImages).toBeUndefined()
    expect(bare.firstFrame).toBeUndefined()
  })

  it('Kling O3 from references: Maja as @Element1, the place as @Image1, Tymon’s front view as @Image2, no start frame', () => {
    const s = withAngles()
    const ctx = ctxOf(s)
    const o3 = model('fal-kling-o3')
    expect(groupSource(ctx, group(s), o3)).toBe('references')
    const plan = multi(planMultishot(ctx, group(s), o3))
    expect(plan.params.firstFrame).toBeUndefined()
    expect(plan.params).toMatchObject({
      elementImages: ['maja-front', 'maja-side', 'maja-back'],
      elementCounts: [3],
      referenceImages: ['station-photo', 'tymon-front'],
    })
    const prompt = String(plan.params.prompt)
    expect(prompt).toContain('as in @Image1')
    expect(prompt).toContain('@Element1 waits at the ticket machine while @Image2 sits on the bench')
    expect(prompt).not.toMatch(/\bImage \d/)
    expect(accepts(o3, plan.params)).toBeNull()
  })

  it('Kling O3 with the keyframe ("both"): the start frame and the elements only', () => {
    const s = withAngles()
    s.multishots![0]!.source = 'both'
    const ctx = ctxOf(s)
    const o3 = model('fal-kling-o3')
    expect(groupSource(ctx, group(s), o3)).toBe('both')
    const plan = multi(planMultishot(ctx, group(s), o3))
    expect(plan.params).toMatchObject({ firstFrame: 'kf1', elementImages: ['maja-front', 'maja-side', 'maja-back'], elementCounts: [3] })
    expect(plan.params.referenceImages).toBeUndefined()
    expect(accepts(o3, plan.params)).toBeNull()
  })

  it('Veo from its ingredients: an 8 s clip, the cast as reference images named by name, no start frame', () => {
    const s = story()
    const ctx = context(s)
    const veo = model('fal-veo3.1')
    expect(groupSource(ctx, group(s), veo)).toBe('references')
    const plan = multi(planMultishot(ctx, group(s), veo))
    expect(plan.total).toBe(8)
    expect(plan.planned).toEqual([5])
    expect(plan.params).toMatchObject({ duration: 8, referenceImages: ['maja-front', 'tymon-front'] })
    expect(plan.params.firstFrame).toBeUndefined()
    expect(plan.params.referenceBackground).toBeUndefined()
    const prompt = String(plan.params.prompt)
    expect(prompt).toMatch(/^\[00:00-00:05\]|\n\[00:00-00:05\]/)
    expect(prompt).toContain('[00:05-00:08]')
    expect(prompt).not.toMatch(/Image \d|Maja is Maja/)
    expect(accepts(veo, plan.params)).toBeNull()
    // From the keyframe it stays an image-to-video clip as long as the shots.
    s.multishots![0]!.source = 'keyframe'
    const fromFrame = multi(planMultishot(ctx, group(s), veo))
    expect(fromFrame.params).toMatchObject({ firstFrame: 'kf1', duration: 8 })
    expect(fromFrame.params.referenceImages).toBeUndefined()
  })

  it('a single Veo shot without a keyframe: its ingredients, 8 s', () => {
    const s = story()
    const veo = model('fal-veo3.1-fast')
    s.shots[3]!.duration = 4
    const params = planVideo(context(s), shotOf(s, 's4'), veo).params
    expect(params).toMatchObject({ duration: 8, referenceImages: ['maja-front', 'tymon-front'] })
    expect(params.firstFrame).toBeUndefined()
    expect(accepts(veo, params)).toBeNull()
  })

  it('Happy Horse stays references or a keyframe, never both', () => {
    const s = story()
    const hh = model('fal-happy-horse-1.1')
    expect(canUseSource(context(s), group(s), hh, 'both')).toBe(false)
    const plan = multi(planMultishot(context(s), group(s), hh))
    expect(plan.params.referenceImages).toEqual(['maja-front', 'tymon-front'])
    expect(plan.params.firstFrame).toBeUndefined()
  })
})

describe('Render with… (a model per group and shot)', () => {
  const multi = (plan: MultishotPlan | string): MultishotPlan => {
    if (typeof plan === 'string') throw new Error(plan)
    return plan
  }
  /** Shots 1–3 (4 + 3 + 5 = 12 s) as one group. */
  const threeShots = () => {
    const s = story()
    s.multishots = [{ id: 'g3', shotIds: ['s1', 's2', 's3'], videoGenerationIds: [] }]
    return s
  }

  it('the cut plan follows the group’s model: Veo 8 s (its ingredients’ fixed length), LTX 10 s, Kling up to 15 s', () => {
    const s = threeShots()
    const ctx = context(s)
    const g = s.multishots![0]!
    expect(groupCutPlan(ctx, g, model('runpod-ltx-2.5')).total).toBe(10)
    expect(groupCutPlan(ctx, g, model('kling-3.0')).total).toBe(12)
    const veo = model('fal-veo3.1')
    expect(groupCutPlan(ctx, g, veo).total).toBe(8)
    // The length the bar shows is the one the render gets.
    expect(multi(planMultishot(ctx, g, veo)).total).toBe(8)
    expect(multi(planMultishot(ctx, g, model('runpod-ltx-2.5'))).total).toBe(10)
  })

  it('a short group on Veo from its ingredients is still 8 s; from a keyframe the next length Veo takes', () => {
    const s = story()
    s.shots[0]!.duration = 2
    s.shots[1]!.duration = 2
    const ctx = context(s)
    const g = s.multishots![0]!
    const veo = model('fal-veo3.1')
    expect(groupCutPlan(ctx, g, veo).total).toBe(8)
    g.source = 'keyframe'
    expect(groupCutPlan(ctx, g, veo).total).toBe(4)
    expect(multi(planMultishot(ctx, g, veo)).total).toBe(4)
  })

  it('warns when a group has more shots (or seconds) than one clip of its model takes', () => {
    const s = story()
    const extra = [5, 6].map((n) => ({ ...s.shots[3]!, id: `s${n}`, duration: 2 }))
    s.shots.push(...extra)
    s.shots.forEach((x) => (x.duration = 2))
    s.multishots = [{ id: 'g6', shotIds: s.shots.map((x) => x.id), videoGenerationIds: [] }]
    const g = s.multishots[0]!
    expect(groupLimitProblem(s, g, model('fal-veo3.1'))).toMatch(/up to 4 shots per clip — this group has 6/)
    expect(groupLimitProblem(s, g, model('kling-3.0'))).toBeUndefined()
    s.shots.forEach((x) => (x.duration = 3))
    expect(groupLimitProblem(s, g, model('kling-3.0'))).toMatch(/up to 15 s per clip/)
  })

  it('a shot in a group renders with the group’s choice, a lone shot with its own', () => {
    const s = story()
    s.multishots![0]!.modelId = 'fal-veo3.1'
    s.shots[0]!.modelId = 'kling-3.0'
    s.shots[2]!.modelId = 'fal-happy-horse-1.1'
    expect(chosenModelId(s, shotOf(s, 's1'))).toBe('fal-veo3.1')
    expect(chosenModelId(s, shotOf(s, 's2'))).toBe('fal-veo3.1')
    expect(chosenModelId(s, shotOf(s, 's3'))).toBe('fal-happy-horse-1.1')
    expect(chosenModelId(s, shotOf(s, 's4'))).toBeUndefined()
    delete s.multishots![0]!.modelId
    expect(chosenModelId(s, shotOf(s, 's1'))).toBeUndefined()
  })

  it('a take’s source is read off what was really sent', () => {
    expect(sourceOfParams({ firstFrame: 'kf1', elementImages: ['a', 'b'] })).toBe('both')
    expect(sourceOfParams({ firstFrame: 'kf1', elements: ['el-maja'] })).toBe('both')
    expect(sourceOfParams({ firstFrame: 'kf1', referenceImages: [] })).toBe('keyframe')
    expect(sourceOfParams({ referenceImages: ['maja-front'] })).toBe('references')
    expect(sourceOfParams({ prompt: 'text only' })).toBeUndefined()
    const s = story()
    expect(sourceOfParams(multi(planMultishot(context(s), s.multishots![0]!, model('runpod-ltx-2.5'))).params)).toBe('references')
    expect(sourceOfParams(planVideo(context(s), shotOf(s, 's3'), model('local-ltx-2.5')).params)).toBe('keyframe')
  })

  it('take records: group takes with a model and shot takes; old cut records without one don’t count', () => {
    const s = story()
    s.multishots![0]!.takes = {
      old: { planned: [4], total: 7 },
      kling: { planned: [4], total: 7, modelId: 'fal-kling-3.0', source: 'both' },
    }
    s.shots[2]!.takes = { veo: { modelId: 'fal-veo3.1', source: 'keyframe' } }
    const records = takeRecords(s)
    expect([...records.keys()].sort()).toEqual(['kling', 'veo'])
    expect(records.get('kling')).toEqual({ modelId: 'fal-kling-3.0', source: 'both' })
    expect(records.get('veo')).toEqual({ modelId: 'fal-veo3.1', source: 'keyframe' })
  })

  describe('final labels', () => {
    const DRAFT = 'local-ltx-2.5'
    const FINAL = 'runpod-ltx-2.5'
    const finals = () => {
      const s = story()
      s.finalVideoModelId = FINAL
      // A group rendered with the final model as its "Render with…" choice: a draft, though made with the final model.
      s.multishots![0]!.takes = { override: { planned: [4], total: 7, modelId: FINAL, source: 'references' }, legacyCuts: { planned: [4], total: 7 } }
      s.shots[2]!.takes = { shotOverride: { modelId: FINAL } }
      return s
    }

    it('a recorded take made with the final model is not final unless it is in finalTakeIds', () => {
      const s = finals()
      expect(isFinalTake(s, 'override', { modelId: FINAL, draftModelId: DRAFT })).toBe(false)
      expect(isFinalTake(s, 'shotOverride', { modelId: FINAL, draftModelId: DRAFT })).toBe(false)
      s.finalTakeIds = ['override', 'shotOverride']
      expect(isFinalTake(s, 'override', { modelId: FINAL, draftModelId: DRAFT })).toBe(true)
      expect(isFinalTake(s, 'shotOverride', { modelId: FINAL, draftModelId: DRAFT })).toBe(true)
    })

    it('older takes without a record are still judged by their model', () => {
      const s = finals()
      expect(isFinalTake(s, 'legacy', { modelId: FINAL, draftModelId: DRAFT })).toBe(true)
      // A cut record from before models were recorded is no take record.
      expect(isFinalTake(s, 'legacyCuts', { modelId: FINAL, draftModelId: DRAFT })).toBe(true)
      expect(isFinalTake(s, 'legacy', { modelId: DRAFT, draftModelId: DRAFT })).toBe(false)
      // Drafts and finals with one model: only finalTakeIds can tell.
      expect(isFinalTake(s, 'legacy', { modelId: FINAL, draftModelId: FINAL })).toBe(false)
      expect(isFinalTake(s, undefined, { modelId: FINAL, draftModelId: DRAFT })).toBe(false)
    })
  })

  describe('which model renders a final', () => {
    it('the final model for a take of its family, else the take’s own model', () => {
      const final = model('runpod-ltx-2.5')
      expect(finalModelFor(model('local-ltx-2.5'), final).id).toBe('runpod-ltx-2.5')
      expect(finalModelFor(model('runpod-ltx-2.5'), final).id).toBe('runpod-ltx-2.5')
      expect(finalModelFor(model('fal-kling-3.0'), final).id).toBe('fal-kling-3.0')
      expect(finalModelFor(model('fal-veo3.1-fast'), final).id).toBe('fal-veo3.1-fast')
      expect(finalModelFor(undefined, final).id).toBe('runpod-ltx-2.5')
      // Kling direct and Kling on fal, Veo Fast and Veo: one family.
      expect(finalModelFor(model('kling-3.0'), model('fal-kling-3.0')).id).toBe('fal-kling-3.0')
      expect(finalModelFor(model('fal-veo3.1-fast'), model('fal-veo3.1')).id).toBe('fal-veo3.1')
      // Models of no known family are only their own family.
      expect(sameFamily(model('fal-seedance-2.5'), model('fal-seedance-2.5'))).toBe(true)
      expect(sameFamily(model('fal-seedance-2.5'), model('fal-happy-horse-1.1'))).toBe(false)
    })

    it('a take of another family renders with its own model and the story’s final settings (only what that model has)', () => {
      const s = story()
      s.characters[0]!.refAssetIds = ['maja-side']
      s.videoSettings = { resolution: '720p', audio: true }
      s.finalVideoSettings = { resolution: '1080p', audio: false, fps: 25 }
      const ctx: PlanContext = { ...context(s), assetReady: (id) => Boolean(id && (READY.has(id) || id === 'maja-side')) }
      const kling = finalModelFor(model('fal-kling-3.0'), model('runpod-ltx-2.5'))
      const plan = multi(planMultishot(ctx, s.multishots![0]!, kling, { final: true }))
      expect(plan.model.id).toBe('fal-kling-3.0')
      expect(plan.label).toBe('Final multi-shot · shots 1–2')
      expect(plan.params).toMatchObject({ resolution: '1080p', audio: false })
      expect(plan.params.fps).toBeUndefined()
      // Kling 3.0 takes the cast only with a start frame: still made from the keyframe with Maja as an element.
      expect(canUseSource(ctx, s.multishots![0]!, kling, groupSource(ctx, s.multishots![0]!, kling))).toBe(true)
      expect(plan.params).toMatchObject({ firstFrame: 'kf1', elementImages: ['maja-front', 'maja-side'] })
    })
  })

  describe('nothing to make a group from yet', () => {
    /** No keyframes, and the cast's pictures not ready (or none). */
    const bare = (refsReady: boolean) => {
      const s = story()
      for (const shot of s.shots) delete shot.keyframeAssetId
      delete s.multishots![0]!.source
      const ctx: PlanContext = { ...context(s), assetReady: (id) => refsReady && Boolean(id && READY.has(id)) }
      return { s, ctx, g: s.multishots![0]! }
    }

    it('a model that takes the cast only from references the story has none of: the keyframe, so Prepare makes it', () => {
      const { ctx, g } = bare(false)
      for (const id of ['fal-veo3.1', 'runpod-ltx-2.5', 'fal-happy-horse-1.1', 'fal-kling-3.0', 'fal-kling-o3', 'local-ltx-2.5']) {
        expect([id, groupSource(ctx, g, model(id))]).toEqual([id, 'keyframe'])
      }
      expect(groupSource(ctx, g, undefined)).toBe('keyframe')
      // Kling 3.0 (direct): Maja is in Kling's element library (no picture needed) — the keyframe-to-be with her as an element.
      expect(groupSource(ctx, g, model('kling-3.0'))).toBe('both')
    })

    it('the keyframe even when the cast has pictures — references only when picked; the keyframe with the cast where the model takes them so', () => {
      const { s, ctx, g } = bare(true)
      // Auto used to pick references here, so Prepare skipped the keyframe and the group never got one (13.10).
      expect(groupSource(ctx, g, model('runpod-ltx-2.5'))).toBe('keyframe')
      expect(groupSource(ctx, g, model('fal-veo3.1'))).toBe('keyframe')
      expect(groupSource(ctx, { ...g, source: 'references' }, model('runpod-ltx-2.5'))).toBe('references')
      // Kling 3.0 (direct): Maja is synced to the element library, so the keyframe with her as an element, once made.
      expect(groupSource(ctx, g, model('kling-3.0'))).toBe('both')
      expect(canUseSource(ctx, g, model('kling-3.0'), 'both')).toBe(false)
      // Kling 3.0 on fal: no character has a second angle to be an element — the keyframe alone.
      expect(groupSource(ctx, g, model('fal-kling-3.0'))).toBe('keyframe')
      // Once Maja has a second angle she can be an element with the keyframe-to-be.
      s.characters[0]!.refAssetIds = ['maja-side']
      const angled: PlanContext = { ...ctx, assetReady: (id) => ctx.assetReady(id) || id === 'maja-side' }
      expect(groupSource(angled, g, model('fal-kling-3.0'))).toBe('both')
    })
  })
})

describe('a continuing shot', () => {
  it('continues the previous take’s clip on a model that can (no start frame), and is planned as usual elsewhere', () => {
    const s = story()
    const shot = { ...shotOf(s, 's3'), keyframeAssetId: 'kf3' }
    const ltx = planVideo(context(s), shot, model('runpod-ltx-2.5'), { continueFrom: 'take-2' })
    expect(ltx.params.continueFrom).toBe('take-2')
    expect(ltx.params.firstFrame).toBeUndefined()
    expect(ltx.label).toBe('Video (continued) · shot 3')
    const kling = planVideo(context(s), shot, model('kling-3.0'), { continueFrom: 'take-2' })
    expect(kling.params.continueFrom).toBeUndefined()
    expect(kling.params.firstFrame).toBe('kf3')
  })

  it('takes the scene’s light and blocking over the place’s', () => {
    const s = story()
    s.scenes = [{ id: 'sc', title: 'Station', placeId: 'station', light: 'cold blue dusk, the station lamps just on', blocking: 'Tymon alone on the bench' }]
    for (const x of s.shots) x.sceneId = 'sc'
    const plan = planVideo(context(s), shotOf(s, 's4'), model('runpod-ltx-2.5'))
    expect(String(plan.params.prompt)).toContain('Cold blue dusk, the station lamps just on')
    expect(String(plan.params.prompt)).toContain('Image 2 alone on the bench')
    expect(String(plan.params.prompt)).not.toMatch(/low evening sun/i)
    // A close-up shows one face: the whole scene's blocking pulled it wide.
    const close = planVideo(context(s), { ...shotOf(s, 's2'), keyframeAssetId: undefined }, model('runpod-ltx-2.5'))
    expect(String(close.params.prompt)).not.toContain('alone on the bench')
  })
})

describe('a group rendered shot by shot', () => {
  const auto = (later?: string) => {
    const s = story()
    const g = s.multishots![0]!
    delete g.source
    const second = s.shots.find((x) => x.id === g.shotIds[1])!
    if (later) second.keyframeAssetId = later
    else delete second.keyframeAssetId
    return { s, g, ctx: context(s) }
  }

  it('on LTX, unless set to one clip: even before its later shots have keyframes, and with older one-clip takes', () => {
    // Every native multi-shot take of The Last Road and Impossible Worlds failed; single shots from keyframes didn't.
    const ltx = model('runpod-ltx-2.5')
    const { s, ctx, g } = auto()
    expect(rendersShotByShot(ctx, g, ltx)).toBe(true)
    expect(rendersShotByShot(ctx, g, model('local-ltx-2.5'))).toBe(true)
    expect(rendersShotByShot(ctx, { ...g, videoGenerationIds: ['take-1'] }, ltx)).toBe(true)
    expect(rendersShotByShot(ctx, g, undefined)).toBe(true)
    // One clip: what it is made from, picked.
    expect(rendersShotByShot(ctx, { ...g, source: 'keyframe' }, ltx)).toBe(false)
    expect(rendersShotByShot(ctx, { ...g, source: 'references' }, ltx)).toBe(false)
    // LTX from references only has nothing to render a shot from on its own.
    expect(rendersShotByShot(ctx, g, { ...ltx, params: ltx.params.filter((p) => p.key !== 'firstFrame') })).toBe(false)
    // Stills then wants every shot's keyframe.
    const stills: StillsContext = { story: s, shotByShot: (x) => rendersShotByShot(ctx, x, ltx), sourceOf: (x) => groupSource(ctx, x, ltx) }
    expect(g.shotIds.map((id) => stillsWanted(stills, shotOf(s, id)).keyframe)).toEqual([true, true])
  })

  it('elsewhere (Kling) as before: on Auto, without a take as one clip, once a later shot’s keyframe is ready', () => {
    // The user's rule (13.10): a group starts from its first keyframe unless its later shots have keyframes of their
    // own — then each shot renders from its keyframe (one clip couldn't use them).
    const kling = model('kling-3.0')
    const none = auto()
    expect(rendersShotByShot(none.ctx, none.g, kling)).toBe(false)
    const { ctx, g } = auto('kf2')
    expect(rendersShotByShot(ctx, g, kling)).toBe(true)
    expect(rendersShotByShot(ctx, { ...g, source: 'keyframe' }, kling)).toBe(false)
    expect(rendersShotByShot(ctx, { ...g, videoGenerationIds: ['take-1'] }, kling)).toBe(false)
  })
})

describe('a shot with a set end frame', () => {
  // Kael, Impossible Worlds: a ring structure told only in words was invented anew in every shot.
  it('renders between its keyframe and its end frame where the model takes both — once measured as a visible change', () => {
    const s = story()
    const shot = { ...shotOf(s, 's3'), keyframeAssetId: 'kf3', endFrame: 'The rings are fully exposed.', endCheck: { startId: 'kf3', endId: 'end3', ssim: 0.43 } }
    const ctx: PlanContext = { ...context(s), endKeyframeOf: (x) => (x.id === 's3' ? { id: 'end3' } : undefined) }
    const plan = planVideo(ctx, shot, model('runpod-ltx-2.5'))
    expect(typeof plan !== 'string' && plan.params).toMatchObject({ firstFrame: 'kf3', lastFrame: 'end3' })
    // No start keyframe: no end frame either (a clip from references can't land on a picture).
    const bare = planVideo(ctx, { ...shot, keyframeAssetId: undefined }, model('runpod-ltx-2.5'))
    expect(typeof bare !== 'string' && bare.params.lastFrame).toBeFalsy()
  })

  it('holds the end picture back when it barely differs, is another composition, or is not measured yet', () => {
    // The Last Road 4/5 froze (0.97, 0.94), Impossible Worlds 4 cut in the middle (0.14): only the words went right.
    const s = story()
    const base = { ...shotOf(s, 's3'), keyframeAssetId: 'kf3', endFrame: 'The rings are fully exposed.' }
    const ctx: PlanContext = { ...context(s), endKeyframeOf: (x) => (x.id === 's3' ? { id: 'end3' } : undefined) }
    const last = (over: Partial<StoryShot>) => planVideo(ctx, { ...base, ...over }, model('runpod-ltx-2.5')).params.lastFrame
    const check = (ssim: number, startId = 'kf3') => ({ endCheck: { startId, endId: 'end3', ssim } })
    expect(last(check(0.97))).toBeUndefined()
    expect(last(check(0.14))).toBeUndefined()
    expect(last({})).toBeUndefined()
    // Measured on another keyframe (redrawn since): unchecked again.
    expect(last(check(0.43, 'kf-old'))).toBeUndefined()
    // The user's call wins either way.
    expect(last({ ...check(0.97), endUse: 'image' })).toBe('end3')
    expect(last({ endUse: 'image' })).toBe('end3')
    expect(last({ ...check(0.43), endUse: 'text' })).toBeUndefined()
  })

  it('never sends the end picture with a shot made to its voice track', () => {
    const s = story()
    s.characters[0]!.voiceId = 'eleven-maja'
    const shot = { ...shotOf(s, 's3'), endFrame: 'The phone lies face down on the bench.', endCheck: { startId: 'kf3', endId: 'end3', ssim: 0.43 }, endUse: 'image' as const }
    const ctx: PlanContext = { ...context(s), endKeyframeOf: () => ({ id: 'end3' }), voiceTrackOf: () => ({ id: 'track-3', seconds: 6 }) }
    const plan = planVideo(ctx, shot, model('runpod-ltx-2.5'))
    expect(plan.params.audioClip).toBe('track-3')
    expect(plan.params.lastFrame).toBeUndefined()
    // Without its track (LTX voices the lines itself) the picture goes as the user asked.
    expect(planVideo({ ...ctx, voiceTrackOf: () => undefined }, shot, model('runpod-ltx-2.5')).params.lastFrame).toBe('end3')
  })

  it('makes a group on Auto go shot by shot: one clip ends once', () => {
    const s = story()
    const g = s.multishots![0]!
    delete g.source
    s.shots.find((x) => x.id === g.shotIds[1])!.keyframeAssetId = undefined
    const ctx: PlanContext = { ...context(s), endKeyframeOf: (x) => (x.id === g.shotIds[0] ? { id: 'end1' } : undefined) }
    // Kling: LTX renders shot by shot anyway.
    expect(rendersShotByShot(ctx, g, model('kling-3.0'))).toBe(true)
    expect(rendersShotByShot(context(s), g, model('kling-3.0'))).toBe(false)
  })
})

describe('the stills a shot needs (one rule for Stills and the scene’s progress)', () => {
  // The fixture: s1–s2 a group from references, s3 and s4 shots of their own, all at the station (one scene).
  const stills = (s: StoryDoc, opts: Partial<StillsContext> = {}) => {
    const ctx: StillsContext = { story: s, shotByShot: () => false, sourceOf: (g) => g.source ?? 'keyframe', ...opts }
    return Object.fromEntries(s.shots.map((x) => [x.id, stillsWanted(ctx, x)]))
  }

  it('a group from references uses no keyframe — its first shot is drawn only as the layout of a shot that does', () => {
    const s = story()
    expect(stills(s)).toMatchObject({ s1: { keyframe: true }, s2: { keyframe: false }, s3: { keyframe: true }, s4: { keyframe: true } })
    // The scene is the group alone: nothing follows its layout, so nothing to draw (it showed "stills 0/1" and Stills
    // had nothing to generate).
    s.shots = s.shots.slice(0, 2)
    expect(stills(s)).toMatchObject({ s1: { keyframe: false }, s2: { keyframe: false } })
  })

  it('a group from a keyframe uses its first shot’s; on Auto a later close or medium shot of someone gets one too', () => {
    const s = story()
    s.multishots![0]!.source = 'keyframe'
    expect(stills(s)).toMatchObject({ s1: { keyframe: true }, s2: { keyframe: false } })
    // On Auto Stills drew it (the group then renders shot by shot) but the progress didn't count it.
    delete s.multishots![0]!.source
    expect(stills(s)).toMatchObject({ s1: { keyframe: true }, s2: { keyframe: true } })
    // …not a wide of no one.
    shotOf(s, 's2').shotType = 'wide'
    shotOf(s, 's2').characterIds = []
    expect(stills(s).s2!.keyframe).toBe(false)
    // Rendered shot by shot, every shot's.
    expect(stills(s, { shotByShot: () => true }).s2!.keyframe).toBe(true)
  })

  it('an end frame only with a keyframe it is drawn from: none for a continuing shot or a later shot of one clip', () => {
    const s = story()
    s.multishots![0]!.source = 'keyframe'
    for (const x of s.shots) x.endFrame = 'The train pulls in.'
    shotOf(s, 's4').continues = true
    // Counted but never drawn, they kept the scene at "stills n/n+1" for good.
    expect(stills(s)).toEqual({
      s1: { keyframe: true, end: true },
      s2: { keyframe: false, end: false },
      s3: { keyframe: true, end: true },
      s4: { keyframe: false, end: false },
    })
  })
})

describe('LTX video prompts (Lightricks’ guide, the Last Road and Impossible Worlds renders)', () => {
  it('from a keyframe: what happens next — not what is behind them, which the picture already shows', () => {
    const s = story()
    const shot = { ...shotOf(s, 's3'), prompt: 'Maja checks her phone and sighs. Behind her, across the tracks: the yellow bench and the ticket machine.' }
    const prompt = String(planVideo(context(s), shot, model('local-ltx-2.5')).params.prompt)
    expect(prompt.startsWith('Maja checks her phone and sighs. A handheld camera.')).toBe(true)
    expect(prompt).not.toContain('Behind her')
    // Without a keyframe nothing shows it: it stays.
    expect(String(planVideo(context(s), { ...shot, keyframeAssetId: undefined }, model('runpod-ltx-2.5')).params.prompt)).toContain('Behind her, across the tracks')
  })

  it('made to its voice track: the camera holds still, the lines keep their words but lose their delivery and cues', () => {
    const s = story()
    s.characters[0]!.voiceId = 'eleven-maja'
    const shot = { ...shotOf(s, 's3'), dialogue: [{ id: 'l3', characterId: 'maja', text: '[sighs] Twenty more minutes. [looks at the board] Maybe more.' }] }
    const ctx: PlanContext = { ...context(s), voiceTrackOf: () => ({ id: 'track-3', seconds: 6 }) }
    const plan = planVideo(ctx, shot, model('runpod-ltx-2.5'))
    expect(plan.params.audioClip).toBe('track-3')
    expect(String(plan.params.prompt)).toBe(
      'Maja checks her phone and sighs. The camera holds still.\n\nMaja says in English in a female voice, "Twenty more minutes. Maybe more.", lips moving with the words.',
    )
    // Not made to a track (LTX voices it): the camera and the acting stay.
    const own = String(planVideo(context(s), shot, model('runpod-ltx-2.5')).params.prompt)
    expect(own).toContain('A handheld camera.')
    expect(own).toContain('sighs, "Twenty more minutes.", then looks at the board, "Maybe more."')
  })

  it('from references: the place’s photo of the shot’s direction, described by its first clause only', () => {
    const s = story()
    const place = s.places![0]!
    place.description = 'A small suburban train platform; a ticket machine and a yellow bench on the near side, the tracks beyond.'
    place.refAssetIds = ['station-photo', 'station-reverse']
    place.refNotes = { 'station-reverse': 'the reverse view' }
    const ctx: PlanContext = { ...context(s), assetReady: (id) => Boolean(id && (READY.has(id) || id === 'station-reverse')) }
    const reverse = { ...shotOf(s, 's4'), background: 'reverse' as const }
    const plan = planVideo(ctx, reverse, model('runpod-ltx-2.5'))
    expect(plan.params.referenceBackground).toBe('station-reverse')
    expect(String(plan.params.prompt)).toContain('Image 3: Scene, A small suburban train platform.')
    expect(String(plan.params.prompt)).not.toContain('on the near side')
    // The main view, as before: the main photo and the whole description.
    expect(videoSubjects(ctx, model('runpod-ltx-2.5'), [shotOf(s, 's4')])?.scene).toMatchObject({ id: 'station-photo', description: place.description })
    // No photo of that direction yet: the main one.
    expect(videoSubjects(context(s), model('runpod-ltx-2.5'), [reverse])?.scene?.id).toBe('station-photo')
  })

  it('Seedance from references: the cast, then the place’s photo, all as @Image n; none beside a keyframe', () => {
    const s = story()
    const seedance = model('fal-seedance-2.5')
    const subjects = videoSubjects(context(s), seedance, [shotOf(s, 's4')])!
    expect(subjects.ids.at(-1)).toBe('station-photo')
    expect(subjects.scene).toMatchObject({ id: 'station-photo', token: `@Image${subjects.ids.length}` })
    expect([...subjects.tokens.values()]).toEqual(subjects.ids.slice(0, -1).map((_, i) => `@Image${i + 1}`))
    const plan = castPlan(context(s), seedance, [shotOf(s, 's4')], false)!
    expect(plan.params.referenceImages).toEqual(subjects.ids)
    expect(plan.params.referenceBackground).toBeUndefined()
    expect(videoSubjects(context(s), seedance, [shotOf(s, 's4')], { withKeyframe: true })).toBeUndefined()
  })

  it('a group set to one clip: at most 200 words, each look said once by who they are', () => {
    const s = story()
    s.characters[0]!.description = 'a woman in her thirties with short dark hair; green raincoat over a grey hoodie, black jeans, white sneakers. On gray backdround — seen from behind.'
    s.characters[1]!.description = 'a tall man with a grey beard; navy wool coat, brown scarf, leather gloves. Only one shoot on gray background.'
    s.multishots = [{ id: 'g3', shotIds: ['s1', 's2', 's3'], videoGenerationIds: [], source: 'keyframe' }]
    const plan = planMultishot(context(s), s.multishots[0]!, model('runpod-ltx-2.5')) as MultishotPlan
    const prompt = String(plan.params.prompt)
    expect(countWords(prompt)).toBeLessThanOrEqual(200)
    expect(prompt).toContain('Maja: a woman in her thirties with short dark hair. Tymon: a tall man with a grey beard.')
    expect(prompt.split('short dark hair').length).toBe(2)
    expect(prompt.split('grey beard').length).toBe(2)
    expect(prompt).not.toMatch(/raincoat|navy wool|backdround|gray background/)
    expect(prompt).toContain('A hard cut transitions to a medium close-up shot.')
    expect(plan.params.firstFrame).toBe('kf1')
  })
})
