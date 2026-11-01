import type { StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import {
  type ContinuityContext,
  continuityRefs,
  facingOf,
  imagePrompt,
  keyframeRefs,
  keyframeStages,
  layoutKey,
  looksText,
  placeViewOf,
  referenceLegend,
  sceneKey,
  shotBackground,
  videoRefPrompt,
  withLegend,
} from './references'

function story(): StoryDoc {
  return {
    script: '',
    style: '',
    characters: [
      { id: 'm', name: 'MAJA', description: '', refAssetId: 'm-front', refAssetIds: ['m-2', 'm-3'] },
      { id: 't', name: 'TYMON', description: '', refAssetId: 't-front', refAssetIds: ['t-2'] },
      { id: 'x', name: 'NOBODY', description: '' },
    ],
    places: [{ id: 'p', name: 'Peron', description: '', refAssetIds: ['p-1', 'p-2'] }],
    shots: [],
  }
}

function shot(over: Partial<StoryShot> = {}): StoryShot {
  return { id: 's', description: '', prompt: '', duration: 4, characterIds: ['m', 't'], dialogue: [], videoGenerationIds: [], placeId: 'p', ...over }
}

const ids = (refs: { id: string }[]) => refs.map((r) => r.id)

describe('keyframeRefs', () => {
  it('puts one view of each person, then the place, before the extra views', () => {
    expect(ids(keyframeRefs(story(), shot(), 16))).toEqual(['m-front', 't-front', 'p-1', 'm-2', 't-2', 'm-3', 'p-2'])
  })

  it('keeps both people and the place when the model takes only four images', () => {
    expect(ids(keyframeRefs(story(), shot(), 4))).toEqual(['m-front', 't-front', 'p-1', 'm-2'])
  })

  it('uses only the characters in the shot and skips those without references', () => {
    expect(ids(keyframeRefs(story(), shot({ characterIds: ['x', 't'], placeId: undefined }), 16))).toEqual(['t-front', 't-2'])
  })

  it('falls back to the first extra view when there is no front view', () => {
    const s = story()
    s.characters[0]!.refAssetId = undefined
    expect(ids(keyframeRefs(s, shot({ characterIds: ['m'], placeId: undefined }), 16))).toEqual(['m-2', 'm-3'])
  })

  it('drops missing assets, duplicates and a place that no longer exists', () => {
    const s = story()
    s.characters[1]!.refAssetIds = ['t-front']
    const refs = keyframeRefs(s, shot({ placeId: 'gone' }), 16, { usable: (id) => id !== 'm-2' })
    expect(ids(refs)).toEqual(['m-front', 't-front', 'm-3'])
  })

  it('leads with the previous frame for continuity', () => {
    const lead = [{ id: 'frame', kind: 'frame' as const, label: 'the previous shot’s last frame' }]
    expect(ids(keyframeRefs(story(), shot(), 3, { lead }))).toEqual(['frame', 'm-front', 't-front'])
  })

  it('puts the place photo the shot talks about first and names it by its note', () => {
    const s = story()
    s.places![0]!.refNotes = { 'p-1': 'the white station building', 'p-2': 'the blue-and-red WKD ticket machine' }
    const insert = shot({ characterIds: [], prompt: 'Close-up: a hand taps a card on the WKD ticket machine' })
    const refs = keyframeRefs(s, insert, 16)
    expect(ids(refs)).toEqual(['p-2', 'p-1'])
    expect(refs.map((r) => r.label)).toEqual([
      'the location “Peron”: the blue-and-red WKD ticket machine',
      'the location “Peron”: the white station building',
    ])
    // A shot that mentions neither keeps the main view first.
    expect(ids(keyframeRefs(s, shot({ characterIds: [], prompt: 'Swallows in the evening sky' }), 16))).toEqual(['p-1', 'p-2'])
    // Whole-word starts only: "covered" is not "red", "machines" is "machine".
    expect(ids(keyframeRefs(s, shot({ characterIds: [], prompt: 'A covered bench' }), 16))).toEqual(['p-1', 'p-2'])
    expect(ids(keyframeRefs(s, shot({ characterIds: [], prompt: 'Two ticket machines' }), 16))).toEqual(['p-2', 'p-1'])
  })

  it('returns nothing for a model without references', () => {
    expect(keyframeRefs(story(), shot(), 0)).toEqual([])
  })
})

describe('a Blender previs as the keyframe’s layout', () => {
  const previs = { id: 'pv', kind: 'previs' as const, label: 'the blocking of shot 1', figures: 'the blue figure is Maja, the green figure is Tymon' }

  it('goes first, then the cast; the place’s photos only add detail, as after an earlier keyframe', () => {
    expect(ids(keyframeRefs(story(), shot(), 16, { lead: [previs] }))).toEqual(['pv', 'm-front', 't-front', 'm-2', 't-2', 'm-3'])
    // Without it the place's photos set the view.
    expect(ids(keyframeRefs(story(), shot(), 16))).toContain('p-1')
  })

  it('tells the model to keep the camera and blocking, names each coloured figure and never draws the grey box', () => {
    const legend = referenceLegend(keyframeRefs(story(), shot(), 3, { lead: [previs] }))
    expect(legend).toContain('image 1 is the blocking of shot 1')
    expect(legend).toContain('Image 1 is the blocking of this shot, rendered as a grey box: keep its camera position, angle, lens and framing exactly')
    expect(legend).toContain('Each coloured figure is a person — the blue figure is Maja, the green figure is Tymon')
    expect(legend).toContain('never the figures, their flat colours or the grey surfaces themselves')
  })
})

describe('referenceLegend', () => {
  it('names every image in order and says what to keep', () => {
    const legend = referenceLegend(keyframeRefs(story(), shot(), 3))
    expect(legend).toBe(
      'Reference images: image 1 is Maja; image 2 is Tymon; image 3 is the location “Peron”. Keep each person’s face, hair and clothes and the location’s architecture, objects, colours and signage exactly as in the references. Image 3 shows what the place looks like, not this shot’s view: the camera stands where this shot describes and faces that way, so what is behind the subject is what lies in that direction. Where this description and the references differ on how someone or something looks, follow the references.',
    )
  })

  it('mentions only what is there', () => {
    expect(referenceLegend(keyframeRefs(story(), shot({ characterIds: [] }), 4))).toBe(
      'Reference images: image 1 is the location “Peron”; image 2 is the location “Peron”, another view. Keep the location’s architecture, objects, colours and signage exactly as in the references. Image 1 and image 2 show what the place looks like, not this shot’s view: the camera stands where this shot describes and faces that way, so what is behind the subject is what lies in that direction. Where this description and the references differ on how someone or something looks, follow the references.',
    )
    expect(referenceLegend([])).toBe('')
  })
})

describe('looksText — positions', () => {
  it('takes the shot’s own positions over the place’s when its people regroup', () => {
    const s = story()
    s.places![0]!.blocking = 'Maja on the left, Tymon on the right'
    const sh = shot({ blocking: 'left to right: Tymon, Maja, shoulder to shoulder' })
    expect(looksText(s, sh, [])).toContain('Positions: left to right: Tymon, Maja, shoulder to shoulder')
    expect(looksText(s, shot(), [])).toContain('Positions: Maja on the left, Tymon on the right')
  })

  it('a shot with its first frame written out says where everyone is itself: no positions from the establishing camera', () => {
    const s = story()
    s.places![0]!.blocking = 'Maja on the left, Tymon on the right, both facing the tracks'
    expect(looksText(s, shot({ frame: 'Tymon faces the camera; Maja’s shoulder in the foreground' }), [])).not.toContain('Positions')
    expect(looksText(s, shot({ frame: 'Tymon faces the camera', blocking: 'Tymon in front' }), [])).toContain('Positions: Tymon in front')
  })
})

describe('looksText', () => {
  it('points a referenced character at its image instead of describing them', () => {
    const s = story()
    s.characters[0]!.description = 'Maja, 21; olive bomber jacket'
    s.characters[1]!.description = 'Tymon, 25; brown corduroy jacket'
    s.places![0]!.description = 'white station building'
    const sh = shot()
    expect(looksText(s, sh, keyframeRefs(s, sh, 16))).toBe(
      'Maja looks exactly like image 1: the same face, hairstyle, clothes and accessories. ' +
        'Tymon looks exactly like image 2: the same face, hairstyle, clothes and accessories. ' +
        'Location, Peron: white station building',
    )
  })

  it('keeps the description of a character whose reference did not fit or who has none', () => {
    const s = story()
    s.characters[1]!.description = 'Tymon, 25; brown corduroy jacket'
    const sh = shot({ placeId: undefined })
    expect(looksText(s, sh, keyframeRefs(s, sh, 1))).toBe(
      'Maja looks exactly like image 1: the same face, hairstyle, clothes and accessories. Tymon, 25; brown corduroy jacket',
    )
    const lead = [{ id: 'frame', kind: 'frame' as const, label: 'the previous shot’s last frame' }]
    expect(looksText(s, sh, keyframeRefs(s, sh, 2, { lead }))).toContain('Maja looks exactly like image 2')
  })
})

describe('continuity', () => {
  const earlier = [
    { id: 'kf-1', kind: 'continuity' as const, label: 'shot 1, the opening shot of this scene' },
    { id: 'kf-4', kind: 'continuity' as const, label: 'shot 4, an earlier shot of this scene' },
  ]

  it('leads with the scene’s keyframes and drops place photos the shot doesn’t talk about', () => {
    expect(ids(keyframeRefs(story(), shot(), 16, { continuity: earlier }))).toEqual(['kf-1', 'kf-4', 'm-front', 't-front', 'm-2', 't-2', 'm-3'])
    // A four-image model keeps the scene and the people.
    expect(ids(keyframeRefs(story(), shot(), 4, { continuity: earlier }))).toEqual(['kf-1', 'kf-4', 'm-front', 't-front'])
  })

  it('matches photos by the words that tell their notes apart', () => {
    const s = story()
    s.places![0]!.refNotes = { 'p-1': 'the blue WKD train with a red stripe', 'p-2': 'the blue-and-red WKD ticket machine' }
    // "blue", "red" and "WKD" are in both notes: only "ticket machine" picks a photo.
    const insert = shot({ characterIds: [], prompt: 'Close-up of the blue-and-red WKD ticket machine on the platform' })
    expect(ids(keyframeRefs(s, insert, 16, { continuity: earlier }))).toEqual(['kf-1', 'kf-4', 'p-2'])
  })

  it('keeps the place photo of what the shot is about', () => {
    const s = story()
    s.places![0]!.refNotes = { 'p-1': 'the station building', 'p-2': 'the ticket machine' }
    const insert = shot({ characterIds: [], prompt: 'Close-up of the card reader on the ticket machine' })
    expect(ids(keyframeRefs(s, insert, 16, { continuity: earlier }))).toEqual(['kf-1', 'kf-4', 'p-2'])
  })

  it('makes the opening shot the layout, over the place photos, and the people come from their own references', () => {
    const s = story()
    s.places![0]!.refNotes = { 'p-2': 'the ticket machine' }
    const sh = shot({ characterIds: ['m'], prompt: 'Maja at the ticket machine' })
    const legend = referenceLegend(keyframeRefs(s, sh, 16, { continuity: earlier }))
    expect(legend).toContain('image 1 is shot 1, the opening shot of this scene; image 2 is shot 4, an earlier shot of this scene; image 3 is Maja')
    expect(legend).toContain('This shot takes place in exactly the scene of image 1: the same place and layout')
    expect(legend).toContain('not copying the framing of image 1.')
    // An earlier moment: the people's poses and gaze come from the shot, and "follow the references" is about looks.
    expect(legend).toContain('Image 1 is an earlier moment of the scene: since then the people have moved — their poses, gestures, gaze and how close they stand come from this description, not from image 1.')
    expect(legend).toContain('follow the references; what the people do, where they stand and where they look come from this description.')
    expect(legend).toContain('Image 2 is another shot of the same scene, with the same layout.')
    expect(legend).toContain('Image 4 only shows what things there look like up close; where it differs from image 1, follow image 1.')
    expect(legend).toContain('Take each person’s face, hair and clothes from their own reference (image 3, image 5 and image 6), not from the earlier shots.')
    expect(legend).not.toContain('Keep the location’s architecture')
    expect(referenceLegend(keyframeRefs(story(), shot(), 16))).not.toContain('earlier shot')
  })

  it('points at the opening shot instead of describing the place', () => {
    const s = story()
    s.places![0]!.description = 'white station building'
    const sh = shot({ characterIds: [] })
    expect(looksText(s, sh, keyframeRefs(s, sh, 16, { continuity: earlier }))).toBe('The place looks exactly like image 1')
    expect(looksText(s, sh, keyframeRefs(s, sh, 16))).toBe('Location, Peron: white station building')
  })
})

describe('keyframeStages', () => {
  const s = (id: string, scene?: string) => shot({ id, scene, placeId: undefined })
  const shots = [s('a', 'peron'), s('b', 'peron'), s('c', 'peron'), s('d', 'kitchen'), s('e', 'kitchen'), s('f')]

  it('opens each scene with its first batch shot and holds the rest of the scene', () => {
    const stages = keyframeStages(shots, new Set(['a', 'b', 'c', 'd', 'e', 'f']), (x) => x.scene, () => false)
    expect(stages).toEqual({ opening: ['a', 'd'], waiting: ['b', 'c', 'e'] })
  })

  it('starts at once what already has a keyframe to follow, or no scene', () => {
    const hasEarlier = (x: StoryShot) => x.scene === 'peron'
    expect(keyframeStages(shots, new Set(['b', 'c', 'e', 'f']), (x) => x.scene, hasEarlier)).toEqual({ opening: ['e'], waiting: [] })
  })

  it('holds later shots for a new opening shot, also those after a keyframe made before it', () => {
    // b has a keyframe made without the wide; the wide (a) is made now: c follows it, not b's.
    const hasEarlier = (x: StoryShot) => x.id === 'c'
    expect(keyframeStages(shots, new Set(['a', 'c']), (x) => x.scene, hasEarlier)).toEqual({ opening: ['a'], waiting: ['c'] })
  })
})

describe('seen from behind', () => {
  it('sends the reference of someone seen from behind and points at their hair and clothes', () => {
    const s = story()
    const ots = shot({ characterIds: ['m'], partialIds: ['t'], placeId: undefined })
    const refs = keyframeRefs(s, ots, 16)
    expect(ids(refs)).toEqual(['m-front', 't-front', 'm-2', 't-2', 'm-3'])
    expect(looksText(s, ots, refs)).toBe(
      'Maja looks exactly like image 1: the same face, hairstyle, clothes and accessories. Tymon, seen from behind, looks exactly like image 2: the same hair, build and clothes',
    )
  })
})

describe('who is in the picture (The Chase)', () => {
  const chase = () => {
    const s = story()
    s.scenes = [{ id: 'sc', title: 'Garage', castIds: ['m', 't'] }]
    s.characters[0]!.description = 'Maja, 30, dark fringe; olive bomber jacket, black jeans'
    s.characters[1]!.description = 'Tymon, 40s, tall, stubble; long charcoal coat, leather gloves'
    return s
  }

  it('says who is not in it when someone of the scene or of the earlier stills could leak in', () => {
    const s = chase()
    const sh = shot({ sceneId: 'sc', characterIds: ['m'] })
    expect(looksText(s, sh, keyframeRefs(s, sh, 16))).toContain('Only Maja is in this picture; Tymon is not')
    // An insert of the car: nobody, though the opening wide shows them both.
    const insert = shot({ sceneId: 'sc', characterIds: [], shotType: 'Insert' })
    expect(looksText(s, insert, [{ id: 'kf-1', kind: 'continuity', label: 'shot 1', shotId: 'a' }])).toContain('Nobody is in this picture')
    // People of an earlier still the scene doesn't list.
    const loose = story()
    loose.shots = [shot({ id: 'a', characterIds: ['m', 't'] })]
    const refs = [{ id: 'kf-1', kind: 'continuity' as const, label: 'shot 1', shotId: 'a' }]
    expect(looksText(loose, shot({ id: 'b', characterIds: ['t'] }), refs)).toContain('Only Tymon is in this picture; Maja is not')
    // Nobody to leak in: nothing to say.
    expect(looksText(story(), shot({ characterIds: [] }), [])).not.toContain('in this picture')
    expect(looksText(s, shot({ sceneId: 'sc' }), [])).not.toContain('in this picture')
  })

  it('a hands-only insert shows the hands and sleeves, not someone from behind', () => {
    const s = chase()
    const insert = shot({ sceneId: 'sc', characterIds: [], partialIds: ['m'], shotType: 'Insert', frame: 'Her fingers type the code on the phone' })
    const refs = keyframeRefs(s, insert, 16)
    const text = looksText(s, insert, refs)
    expect(text).toContain('Only Maja’s hands and sleeves are in the frame — the same skin and sleeves as image 1')
    expect(text).not.toContain('seen from behind')
    expect(text).toContain('Only Maja is in this picture; Tymon is not')
    // Boots: the feet. Over a shoulder: from behind, whatever the hands in front do.
    const boots = shot({ characterIds: [], partialIds: ['m'], shotType: 'Close-up', frame: 'Her boots step onto the oil stain' })
    expect(looksText(s, boots, keyframeRefs(s, boots, 16))).toContain('Only Maja’s feet and shoes are in the frame')
    const ots = shot({ characterIds: ['t'], partialIds: ['m'], shotType: 'Over-the-shoulder', frame: 'Tymon holds the phone in both hands' })
    expect(looksText(s, ots, keyframeRefs(s, ots, 16))).toContain('Maja, seen from behind, looks exactly like image 2')
  })

  it('someone hidden in the dark gets no face reference — only their outline and clothes', () => {
    const s = chase()
    const sh = shot({ sceneId: 'sc', characterIds: ['m'], hiddenIds: ['t'] })
    const refs = keyframeRefs(s, sh, 16)
    expect(ids(refs)).toEqual(['m-front', 'p-1', 'm-2', 'm-3', 'p-2'])
    const text = looksText(s, sh, refs)
    expect(text).toContain('Tymon is only a dark outline in the shadow, face unreadable (long charcoal coat, leather gloves)')
    expect(text).not.toContain('stubble')
    expect(referenceLegend(refs)).not.toContain('Tymon')
  })
})

describe('place blocking and light', () => {
  it('tells the keyframe where everyone stands and how the place is lit', () => {
    const s = story()
    s.places![0]!.blocking = 'Maja on the left, Tymon on the right'
    s.places![0]!.light = 'low golden sun from the left'
    const sh = shot({ characterIds: [] })
    expect(looksText(s, sh, [])).toContain('Positions: Maja on the left, Tymon on the right. Light: low golden sun from the left')
  })
})

describe('the place seen in four directions', () => {
  // By the Lake, 1.2–1.5: with one view of the place, both sides of a conversation got the same lake behind them.
  const lake = () => {
    const s = story()
    s.places = [
      {
        id: 'p',
        name: 'Lakeshore',
        description: 'From the southern bank looking north: the pier and the lake; reeds to the west.',
        refAssetIds: ['main', 'rev', 'lft', 'rgt', 'pier'],
        refNotes: { rev: 'the reverse view', lft: 'the view to the left', rgt: 'the view to the right', pier: 'the weathered pier planks' },
      },
    ]
    return s
  }

  it('reads which way each photo looks: the first is the main view, the others by their note', () => {
    const p = lake().places![0]!
    expect(['main', 'rev', 'lft', 'rgt', 'pier'].map((id) => placeViewOf(p, id))).toEqual(['main', 'reverse', 'left', 'right', undefined])
  })

  it('a shot looking one way gets the photo of that direction as its backdrop, and no photo of another direction', () => {
    const refs = keyframeRefs(lake(), shot({ background: 'left', prompt: 'Stefan sets his foot on the pier planks' }), 16)
    expect(ids(refs)).toEqual(['m-front', 't-front', 'lft', 'm-2', 't-2', 'm-3', 'pier'])
    expect(refs.find((r) => r.id === 'lft')).toMatchObject({ behind: true, label: 'the location “Lakeshore” as it lies behind them from this camera (the view to the left)' })
    const legend = referenceLegend(refs)
    expect(legend).toContain('Image 3 is what lies behind the people from this camera: keep it as the backdrop')
    expect(legend).toContain('Image 7 only shows what things there look like up close.')
    expect(legend).not.toContain('not this shot’s view')
    // The establishing camera's description would put the lake back: the photo says what is behind them.
    const where = looksText(lake(), shot({ background: 'left' }), refs)
    expect(where).toContain('Behind them, from this camera, the place looks exactly like image 3')
    expect(where).not.toContain('southern bank')
  })

  it('without a photo of its direction, a shot gets the place as before — told it is not its view', () => {
    const s = lake()
    s.places![0]!.refAssetIds = ['main', 'pier']
    const refs = keyframeRefs(s, shot({ background: 'reverse' }), 16)
    expect(ids(refs)).toContain('main')
    expect(refs.some((r) => r.behind)).toBe(false)
    expect(referenceLegend(refs)).toContain('not this shot’s view')
  })

  it('a shot with no direction (stories from before) keeps every photo, ranked as before', () => {
    expect(ids(keyframeRefs(lake(), shot(), 16))).toEqual(['m-front', 't-front', 'main', 'm-2', 't-2', 'm-3', 'rev', 'lft', 'rgt', 'pier'])
  })

  it('with an earlier keyframe looking the same way, only the details the shot talks about go along', () => {
    const refs = keyframeRefs(lake(), shot({ background: 'left', prompt: 'his boot on the pier planks' }), 16, {
      continuity: [{ id: 'kf-13', kind: 'continuity', label: 'shot 1.3' }],
    })
    expect(ids(refs)).toEqual(['kf-13', 'm-front', 't-front', 'pier', 'm-2', 't-2', 'm-3'])
  })
})

describe('which way a shot looks, read from its camera position', () => {
  // By the Lake, scene 1: shots written before shots had a background all got the main view's lake behind them.
  const lake = () => {
    const s = story()
    s.places = [{ id: 'p', name: 'Lakeshore', description: 'From the establishing camera on the southern bank looking north, the open lake fills the background.' }]
    return s
  }

  it('reads compass directions, and nothing from landmarks', () => {
    expect(facingOf('on the bank side southeast of Kuba, looking northwest over Kuba’s shoulder')).toBe(315)
    expect(facingOf('just lakeward of the pier entrance, looking south toward Stefan')).toBe(180)
    expect(facingOf('looking north-east over his shoulder')).toBe(45)
    expect(facingOf('looking at Kuba, then looking west at the reeds')).toBe(270)
    expect(facingOf('from the doorway, looking toward the stove')).toBeUndefined()
  })

  it('turns the direction against the main view into one of the four views; what the shot says wins', () => {
    const s = lake()
    const at = (view: string) => shotBackground(s, shot({ view }))
    expect(at('on the southern bank looking north toward the pier')).toBe('main')
    expect(at('looking south toward Stefan and Kuba')).toBe('reverse')
    expect(at('looking northwest over Kuba’s shoulder onto Stefan')).toBe('left')
    expect(at('looking northeast over Stefan’s shoulder onto Kuba')).toBe('right')
    expect(shotBackground(s, shot({ view: 'looking south', background: 'left' }))).toBe('left')
    expect(at('looking toward the stove')).toBeUndefined()
    // That direction's photo goes with the keyframe.
    s.places![0]!.refAssetIds = ['main', 'lft']
    s.places![0]!.refNotes = { lft: 'the view to the left' }
    expect(ids(keyframeRefs(s, shot({ view: 'looking northwest' }), 3))).toEqual(['m-front', 't-front', 'lft'])
  })

  it('without the place saying which way it looks, the scene’s opening shot does', () => {
    const s = story()
    const opener = shot({ id: 'a', sceneId: 'sc', view: 'from the road looking east at the farmhouse' })
    s.shots = [opener, shot({ id: 'b', sceneId: 'sc', view: 'looking west down the road' })]
    expect(shotBackground(s, s.shots[1]!)).toBe('reverse')
    expect(shotBackground(s, opener)).toBeUndefined()
  })
})

describe('stills drawn from stills: an end frame from its shot, a keyframe from the shot before', () => {
  it('an end frame keeps the shot’s first frame: its place, light and people, with what changed from the description', () => {
    const refs = keyframeRefs(story(), shot(), 4, { continuity: [{ id: 'kf-start', kind: 'start', label: 'the first frame of shot 1.1' }] })
    expect(refs[0]!.id).toBe('kf-start')
    const legend = referenceLegend(refs)
    expect(legend).toContain('Image 1 is the first frame of this shot: keep its place, light and people exactly as there')
    expect(legend).toContain('what has changed in the place, what the people do and where they are come from this description')
    expect(looksText(story(), shot(), refs)).toContain('The place is the one in image 1, as it is at this moment')
  })

  it('a locked-off shot’s end frame is the same camera: what it moves is no longer where it was, and no copy stays', () => {
    // The Chase: the end frames kept the phone on the floor and put a second one in her hand.
    const refs = keyframeRefs(story(), shot(), 4, { continuity: [{ id: 'kf-start', kind: 'start', label: 'the first frame of shot 1.4', still: true }] })
    expect(referenceLegend(refs)).toContain(
      'Image 1 is the first frame of this shot — the same camera: keep its framing, lens, place, light and looks exactly; change only what this description says — anything it moves, opens or removes is no longer where it was in image 1, and no copy of it stays there.',
    )
  })

  it('an end frame takes positions only from the shot itself: the start’s are what it changes', () => {
    const s = story()
    s.places![0]!.blocking = 'Maja on the left by the bench, her phone on the floor'
    const refs = [{ id: 'kf-start', kind: 'start' as const, label: 'the first frame of shot 1.4', still: true }]
    expect(looksText(s, shot(), refs, true)).not.toContain('Positions')
    expect(looksText(s, shot({ blocking: 'Maja standing, the phone in her hand' }), refs, true)).toContain('Positions: Maja standing, the phone in her hand')
    expect(imagePrompt(s, shot({ endFrame: 'The phone is in her raised hand' }), refs, true)).not.toContain('on the floor')
    // The keyframe keeps the place's.
    expect(looksText(s, shot(), [])).toContain('Positions: Maja on the left by the bench')
  })

  it('the next keyframe takes the state of things from the previous shot’s last moment, never its picture', () => {
    const refs = keyframeRefs(story(), shot(), 4, { continuity: [{ id: 'end-11', kind: 'previousEnd', label: 'the last moment of shot 1.1' }] })
    // After the cast: as image 1 its composition was copied (Kael 5–7, the same view each time) — and the place's
    // photo still goes: it is no layout of this camera.
    expect(ids(refs)).toEqual(['m-front', 't-front', 'end-11', 'p-1'])
    const legend = referenceLegend(refs)
    expect(legend).toContain(
      'Image 3 is the previous shot’s last moment from another camera: take only the state things are in now — what moved, opened, broke or appeared — never its framing, angle, lens, textures or grain; the place and objects look as in image 4, the people as in their references.',
    )
    expect(legend).not.toContain('earlier moment of the scene')
    // Where the place is: the place, not the end frame (its legend says what to take from it).
    const s = story()
    s.places![0]!.description = 'white station building'
    expect(looksText(s, shot(), refs)).toContain('Location, Peron: white station building')
    expect(looksText(s, shot(), refs)).not.toContain('image 3, as it is at this moment')
  })
})

describe('continuityRefs: the earlier keyframes a shot takes its layout from', () => {
  /** The scene's shots with their stills (ready unless `pending`), and what each keyframe render was made from. */
  function scene(
    shots: StoryShot[],
    opts: { keyframes?: Record<string, string>; ends?: Record<string, string>; madeFrom?: Record<string, unknown>; pending?: string[] } = {},
  ): ContinuityContext {
    const s = story()
    s.shots = shots
    const still = (id?: string) => (id ? { id, status: opts.pending?.includes(id) ? 'processing' : 'ready' } : undefined)
    return { story: s, keyframeOf: (x) => still(opts.keyframes?.[x.id]), endKeyframeOf: (x) => still(opts.ends?.[x.id]), madeFrom: (gid) => opts.madeFrom?.[gid] }
  }
  const at = (id: string, over: Partial<StoryShot> = {}) => shot({ id, sceneId: 'sc', characterIds: [], ...over })

  it('takes the opening wide as the layout of the scene’s later shots', () => {
    const shots = [at('a', { shotType: 'Wide' }), at('b', { shotType: 'Medium' }), at('c', { sceneId: 'other' })]
    const ctx = scene(shots, { keyframes: { a: 'kf-a' } })
    expect(continuityRefs(ctx, shots[1]!)).toEqual([{ id: 'kf-a', kind: 'continuity', label: 'shot 1, the opening shot of this scene', shotId: 'a' }])
    // The opening shot has nothing before it, another scene has its own layout, and a keyframe still processing isn't one.
    expect(continuityRefs(ctx, shots[0]!)).toEqual([])
    expect(continuityRefs(ctx, shots[2]!)).toEqual([])
    expect(continuityRefs(scene(shots, { keyframes: { a: 'kf-a' }, pending: ['kf-a'] }), shots[1]!)).toEqual([])
  })

  it('never takes a close-up, an over-the-shoulder or an insert for the layout while there is a wider shot', () => {
    const shots = [at('a', { shotType: 'Close-up' }), at('b', { shotType: 'Wide' }), at('c', { shotType: 'Over-the-shoulder' }), at('d', { shotType: 'Insert' }), at('e')]
    expect(continuityRefs(scene(shots, { keyframes: { a: 'kf-a', b: 'kf-b', c: 'kf-c', d: 'kf-d' } }), shots[4]!)).toEqual([
      { id: 'kf-b', kind: 'continuity', label: 'shot 2, the wide shot of this scene', shotId: 'b' },
    ])
    // Only close-ups so far (the wide has no keyframe yet): the first of them is all there is.
    expect(continuityRefs(scene(shots, { keyframes: { c: 'kf-c', d: 'kf-d' } }), shots[4]!)).toEqual([
      { id: 'kf-c', kind: 'continuity', label: 'shot 3, an earlier shot of this scene, looking the same way', shotId: 'c' },
    ])
  })

  it('adds the nearest earlier wider shot only when it was itself made from the opening keyframe', () => {
    const shots = [
      at('a', { shotType: 'Wide' }),
      at('b', { shotType: 'Medium', keyframeGenerationId: 'g-b' }),
      at('c', { shotType: 'Close-up', keyframeGenerationId: 'g-c' }),
      at('d'),
    ]
    const keyframes = { a: 'kf-a', b: 'kf-b', c: 'kf-c' }
    const fromOpening = scene(shots, { keyframes, madeFrom: { 'g-b': ['kf-a', 'm-front'], 'g-c': ['kf-a'] } })
    expect(continuityRefs(fromOpening, shots[3]!)).toEqual([
      { id: 'kf-a', kind: 'continuity', label: 'shot 1, the opening shot of this scene', shotId: 'a' },
      { id: 'kf-b', kind: 'continuity', label: 'shot 2, an earlier shot of this scene', shotId: 'b' },
    ])
    // Made before the opening keyframe, or its job is no longer known: it may have the set rearranged.
    expect(ids(continuityRefs(scene(shots, { keyframes, madeFrom: { 'g-b': ['m-front'] } }), shots[3]!))).toEqual(['kf-a'])
    expect(ids(continuityRefs(scene(shots, { keyframes }), shots[3]!))).toEqual(['kf-a'])
    // Drawn after the previous shot's last frame, only the opening goes along.
    expect(ids(continuityRefs(fromOpening, shots[3]!, false))).toEqual(['kf-a'])
  })

  it('a shot looking away from the main view ignores keyframes drawn without that direction’s photo (By the Lake)', () => {
    // 1.2–1.5: reverse shots drawn before the place had its reverse photo have the lake of the main view behind them.
    const shots = [
      at('a', { shotType: 'Wide' }),
      at('b', { shotType: 'Medium', background: 'reverse', keyframeGenerationId: 'g-b' }),
      at('c', { shotType: 'Medium', background: 'reverse', keyframeGenerationId: 'g-c' }),
      at('d', { background: 'reverse' }),
    ]
    const lake = (opts: Parameters<typeof scene>[1]) => {
      const ctx = scene(shots, opts)
      ctx.story.places = [{ id: 'p', name: 'Lakeshore', description: '', refAssetIds: ['main', 'rev'], refNotes: { rev: 'the reverse view' } }]
      return ctx
    }
    const keyframes = { a: 'kf-a', b: 'kf-b', c: 'kf-c' }
    // The opening wide looks the other way: never this shot's layout.
    expect(continuityRefs(lake({ keyframes, madeFrom: { 'g-b': ['main'], 'g-c': ['m-front', 'main'] } }), shots[3]!)).toEqual([])
    // Drawn with the reverse photo — or from a keyframe that was — they are the layout looking that way.
    expect(continuityRefs(lake({ keyframes, madeFrom: { 'g-b': ['rev'], 'g-c': ['kf-b'] } }), shots[3]!)).toEqual([
      { id: 'kf-b', kind: 'continuity', label: 'shot 2, the wide shot of this scene', shotId: 'b' },
      { id: 'kf-c', kind: 'continuity', label: 'shot 3, an earlier shot of this scene', shotId: 'c' },
    ])
    // Their jobs no longer known: nothing says they were drawn the wrong way.
    expect(ids(continuityRefs(lake({ keyframes }), shots[3]!))).toEqual(['kf-b'])
  })

  it('adds the previous shot’s ready end frame to the layout keyframes, never instead of them', () => {
    // The Chase: given only the previous end frame, each keyframe copied its framing and piled up its artefacts.
    const shots = [at('a', { shotType: 'Wide', endFrame: 'The rings half out of the salt' }), at('b')]
    expect(continuityRefs(scene(shots, { keyframes: { a: 'kf-a' }, ends: { a: 'end-a' } }), shots[1]!)).toEqual([
      { id: 'kf-a', kind: 'continuity', label: 'shot 1, the opening shot of this scene', shotId: 'a' },
      { id: 'end-a', kind: 'previousEnd', label: 'the last moment of shot 1', shotId: 'a' },
    ])
    // Not drawn yet: the opening keyframe, as before.
    expect(ids(continuityRefs(scene(shots, { keyframes: { a: 'kf-a' }, ends: { a: 'end-a' }, pending: ['end-a'] }), shots[1]!))).toEqual(['kf-a'])
    // Drawn after the previous take's last frame: that is the moment already.
    expect(ids(continuityRefs(scene(shots, { keyframes: { a: 'kf-a' }, ends: { a: 'end-a' } }), shots[1]!, false))).toEqual(['kf-a'])
    // Only within the scene: the next scene opens on its own.
    const next = [shots[0]!, at('b', { sceneId: 'next' })]
    expect(continuityRefs(scene(next, { keyframes: { a: 'kf-a' }, ends: { a: 'end-a' } }), next[1]!)).toEqual([])
  })

  it('only an end frame measured as a visible change goes along — or one not measured yet', () => {
    const ends = (ssim?: number) => {
      const shots = [
        at('a', { shotType: 'Wide', endFrame: 'The rings half out of the salt', ...(ssim === undefined ? {} : { endCheck: { startId: 'kf-a', endId: 'end-a', ssim } }) }),
        at('b'),
      ]
      return ids(continuityRefs(scene(shots, { keyframes: { a: 'kf-a' }, ends: { a: 'end-a' } }), shots[1]!))
    }
    expect(ends(0.43)).toEqual(['kf-a', 'end-a'])
    expect(ends()).toEqual(['kf-a', 'end-a'])
    // Barely different from its start (it says nothing of the moment), or another composition (the wrong camera).
    expect(ends(0.96)).toEqual(['kf-a'])
    expect(ends(0.14)).toEqual(['kf-a'])
  })

  it('one hop at most: not when the previous keyframe was itself drawn from an end frame', () => {
    const shots = [
      at('a', { shotType: 'Wide', endFrame: 'The car door swings open' }),
      at('b', { shotType: 'Medium', keyframeGenerationId: 'g-b', endFrame: 'The phone is in her raised hand' }),
      at('c'),
    ]
    const stills = { keyframes: { a: 'kf-a', b: 'kf-b' }, ends: { a: 'end-a', b: 'end-b' } }
    // b's keyframe drew on a's end: c would be a picture of a picture of a picture.
    expect(ids(continuityRefs(scene(shots, { ...stills, madeFrom: { 'g-b': ['kf-a', 'end-a'] } }), shots[2]!))).toEqual(['kf-a', 'kf-b'])
    // Drawn from the layout alone, it is one hop.
    expect(ids(continuityRefs(scene(shots, { ...stills, madeFrom: { 'g-b': ['kf-a'] } }), shots[2]!))).toEqual(['kf-a', 'kf-b', 'end-b'])
  })

  it('the end frame, the opening and the direction’s photo go together, the end frame after the people', () => {
    const s = story()
    s.places![0]!.refAssetIds = ['p-1', 'p-rev']
    s.places![0]!.refNotes = { 'p-rev': 'the reverse view' }
    const continuity = [
      { id: 'kf-a', kind: 'continuity' as const, label: 'shot 1, the opening shot of this scene', shotId: 'a' },
      { id: 'end-a', kind: 'previousEnd' as const, label: 'the last moment of shot 1', shotId: 'a' },
    ]
    // With a layout keyframe, only the photos the shot talks about.
    expect(ids(keyframeRefs(s, shot(), 16, { continuity }))).toEqual(['kf-a', 'm-front', 't-front', 'end-a', 'm-2', 't-2', 'm-3'])
    // The end frame alone is no layout: the photo of this direction goes, as the backdrop.
    const refs = keyframeRefs(s, shot({ background: 'reverse' }), 16, { continuity: continuity.slice(1) })
    expect(ids(refs)).toEqual(['m-front', 't-front', 'end-a', 'p-rev', 'm-2', 't-2', 'm-3'])
    expect(refs.find((r) => r.id === 'p-rev')).toMatchObject({ behind: true })
    expect(referenceLegend(refs)).toContain('the place and objects look as in image 4')
    expect(looksText(s, shot({ background: 'reverse' }), refs)).toContain('Behind them, from this camera, the place looks exactly like image 4')
  })

  it('layoutKey: one key per scene and direction; stories from before scenes go by place, else by heading', () => {
    const s = story()
    expect(layoutKey(s, shot({ sceneId: 'sc' }))).toBe('sc\nmain')
    expect(layoutKey(s, shot({ sceneId: 'sc', background: 'main' }))).toBe('sc\nmain')
    expect(layoutKey(s, shot({ sceneId: 'sc', background: 'reverse' }))).toBe('sc\nreverse')
    expect(sceneKey(shot())).toBe('p')
    expect(sceneKey(shot({ placeId: undefined, scene: ' EXT. PERON – DAY ' }))).toBe('EXT. PERON – DAY')
    // Neither: no scene to share a layout with.
    const loose = shot({ id: 'b', placeId: undefined })
    expect(layoutKey(s, loose)).toBeUndefined()
    expect(continuityRefs(scene([shot({ id: 'a', placeId: undefined }), loose], { keyframes: { a: 'kf-a' } }), loose)).toEqual([])
  })
})

describe('imagePrompt', () => {
  const bare = (over: Partial<StoryShot>) => shot({ characterIds: [], placeId: undefined, ...over })

  it('draws the shot’s first moment from its camera: closer than the opening wide when it names no framing', () => {
    const refs = [{ id: 'kf-1', kind: 'continuity' as const, label: 'shot 1, the opening shot of this scene' }]
    const sh = bare({ prompt: 'Jan climbs out, walks over and stops', frame: 'Jan climbs out of the car', view: 'by the boot, looking north' })
    expect(imagePrompt(story(), sh, refs)).toBe(
      'A closer shot than image 1, framed on the people and what they do. Camera: by the boot, looking north. One still frame: the moment the shot begins, each person in it seen once; nobody looks into the camera. Jan climbs out of the car. The place looks exactly like image 1.',
    )
    expect(imagePrompt(story(), bare({ shotType: 'Wide', prompt: 'Jan walks over' }))).toBe(
      'Wide shot. One still frame: the moment the shot begins, each person in it seen once; nobody looks into the camera. Jan walks over.',
    )
  })

  it('an end frame is the moment the shot ends, without the start’s camera position', () => {
    const s = story()
    s.style = 'Shot on 35 mm film.'
    const sh = bare({ shotType: 'Wide', view: 'by the boot, looking north', prompt: 'Jan walks over', endFrame: 'Jan stands in front of Hanka' })
    expect(imagePrompt(s, sh, [], true)).toBe('Wide shot. One still frame: the moment the shot ends, each person in it seen once. Jan stands in front of Hanka. Shot on 35 mm film.')
  })

  it('the legend goes after the prompt, only when references go with it', () => {
    const refs = keyframeRefs(story(), shot(), 3)
    expect(withLegend('A wide shot.', [])).toBe('A wide shot.')
    expect(withLegend('A wide shot. ', refs)).toBe(`A wide shot. ${referenceLegend(refs)}`)
  })

  it('a video reference: the look, then the studio picture of one or more of their pictures', () => {
    expect(videoRefPrompt('Maja: olive bomber jacket', 2)).toMatch(/^Maja: olive bomber jacket\. The same person as in the reference images — /)
    expect(videoRefPrompt('', 1)).toMatch(/^The same person as in the reference image — /)
  })
})
