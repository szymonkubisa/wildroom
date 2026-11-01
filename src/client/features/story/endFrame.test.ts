import type { StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { endState, endStateText, splitAtEndFrame } from './endFrame'

const shot = (id: string, over: Partial<StoryShot> = {}): StoryShot => ({
  id,
  sceneId: 'sc',
  scene: 'Salt plain',
  description: '',
  prompt: '',
  duration: 5,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...over,
})

describe('endState: what becomes of the end picture', () => {
  const end = { endFrame: 'The rings are fully exposed.' }
  const checked = (ssim: number) => ({ ...end, endCheck: { startId: 'kf', endId: 'end', ssim } })

  it('goes as the last frame only when measured as the same camera with a visible change', () => {
    expect(endState(checked(0.43), 'kf', 'end')).toBe('image')
    // The Last Road 4 (0.97): it froze. Impossible Worlds 4 (0.14): it cut in the middle.
    expect(endState(checked(0.97), 'kf', 'end')).toBe('same')
    expect(endState(checked(0.14), 'kf', 'end')).toBe('recomposed')
    // Not measured, or measured on stills since redrawn.
    expect(endState(end, 'kf', 'end')).toBe('unchecked')
    expect(endState(checked(0.43), 'kf-2', 'end')).toBe('unchecked')
    expect(endState(checked(0.43), undefined, 'end')).toBe('unchecked')
  })

  it('the user’s call wins; no end picture is the words alone; no end frame is nothing', () => {
    expect(endState({ ...checked(0.97), endUse: 'image' }, 'kf', 'end')).toBe('image')
    expect(endState({ ...checked(0.43), endUse: 'text' }, 'kf', 'end')).toBe('text')
    expect(endState(end, 'kf', undefined)).toBe('text')
    expect(endState({}, 'kf', undefined)).toBeUndefined()
  })

  it('says so in one line', () => {
    expect(endStateText('same', 0.97)).toBe('Barely differs from the still (97% alike): the clip would freeze — only its description goes')
    expect(endStateText('image', 0.43)).toBe('Same camera, a visible change (43% alike): sent as the clip’s last frame')
    expect(endStateText('image', 0.43, { userCall: true })).toBe('Sent as the clip’s last frame — your call')
    expect(endStateText('image', 0.43, { lipSync: true })).toContain('Lip-synced')
  })
})

describe('splitAtEndFrame', () => {
  function story(): StoryDoc {
    return {
      script: '',
      style: '',
      characters: [],
      scenes: [{ id: 'sc', title: 'Salt plain', placeId: 'p' }],
      shots: [
        shot('a', {
          description: 'Kael pulls the ring free',
          shotType: 'Medium',
          view: 'east of Kael, looking west',
          camera: 'slow push in',
          prompt: 'Kael pulls at the ring until it comes free of the salt.',
          duration: 6,
          characterIds: ['kael'],
          hiddenIds: ['watcher'],
          placeId: 'p',
          sfx: 'wind over the salt',
          endFrame: 'From exactly the same camera, the ring is free in his raised hands; the hollow it left gapes in the salt.',
          keyframeAssetId: 'kf-a',
          endKeyframeAssetId: 'end-a',
          endCheck: { startId: 'kf-a', endId: 'end-a', ssim: 0.14 },
          endUse: 'image',
          videoGenerationIds: ['take-a'],
        }),
        shot('b', { placeId: 'p' }),
      ],
    }
  }

  it('the next shot starts from the end picture; this one ends where it will', () => {
    // Impossible Worlds 4: an end of another composition cut the clip in the middle — as two shots, the cut is meant.
    const s = story()
    expect(splitAtEndFrame(s, 'a', () => 'new')).toBe('new')
    expect(s.shots.map((x) => x.id)).toEqual(['a', 'new', 'b'])
    const [a, next] = s.shots as [StoryShot, StoryShot]
    expect(a).toMatchObject({ duration: 3, keyframeAssetId: 'kf-a', videoGenerationIds: ['take-a'] })
    for (const key of ['endFrame', 'endKeyframeAssetId', 'endKeyframeGenerationId', 'endCheck', 'endUse'] as const) expect(a[key]).toBeUndefined()
    expect(next).toMatchObject({
      sceneId: 'sc',
      description: 'The ring is free in his raised hands',
      frame: 'From exactly the same camera, the ring is free in his raised hands; the hollow it left gapes in the salt.',
      keyframeAssetId: 'end-a',
      duration: 3,
      characterIds: ['kael'],
      hiddenIds: ['watcher'],
      placeId: 'p',
      sfx: 'wind over the salt',
      dialogue: [],
      videoGenerationIds: [],
    })
    // Another camera than the start's: no position or move carried over.
    expect(next.view).toBeUndefined()
    expect(next.camera).toBeUndefined()
  })

  it('an end still rendering moves as its generation', () => {
    const s = story()
    const a = s.shots[0]!
    delete a.endKeyframeAssetId
    a.endKeyframeGenerationId = 'gen-end'
    splitAtEndFrame(s, 'a', () => 'new')
    expect(s.shots[1]).toMatchObject({ keyframeGenerationId: 'gen-end' })
    expect(s.shots[1]!.keyframeAssetId).toBeUndefined()
  })

  it('keeps a multi-shot group whole: the new shot goes after it', () => {
    const s = story()
    s.multishots = [{ id: 'g', shotIds: ['a', 'b'], videoGenerationIds: ['take-g'] }]
    splitAtEndFrame(s, 'a', () => 'new')
    expect(s.shots.map((x) => x.id)).toEqual(['a', 'b', 'new'])
    expect(s.multishots[0]).toMatchObject({ shotIds: ['a', 'b'], videoGenerationIds: ['take-g'] })
  })

  it('a story from before scenes: right after the shot', () => {
    const s = story()
    delete s.scenes
    for (const x of s.shots) delete x.sceneId
    splitAtEndFrame(s, 'a', () => 'new')
    expect(s.shots.map((x) => x.id)).toEqual(['a', 'new', 'b'])
  })

  it('does nothing without an end frame', () => {
    const s = story()
    expect(splitAtEndFrame(s, 'b', () => 'new')).toBeUndefined()
    expect(splitAtEndFrame(s, 'gone', () => 'new')).toBeUndefined()
    expect(s.shots).toHaveLength(2)
  })
})
