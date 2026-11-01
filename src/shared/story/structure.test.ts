import { describe, expect, it } from 'vitest'
import type { StoryDoc, StoryScene, StoryShot } from '../types/story'
import {
  addScene,
  assemblyMarks,
  blockingOf,
  deriveScenes,
  insertShot,
  lightOf,
  mergeCast,
  mergePlaces,
  mergeWithPrevious,
  moveScene,
  moveShot,
  normalizeStory,
  outlineToStory,
  removeChapter,
  removeScene,
  replaceSceneShots,
  cleanPicks,
  sanitizeStory,
  sceneLightOf,
  setScenePlace,
  shotLabel,
  splitSceneAt,
  steadyLight,
  validGroups,
} from './structure'

const shot = (id: string, extra: Partial<StoryShot> = {}): StoryShot => ({
  id,
  description: '',
  prompt: '',
  duration: 3,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...extra,
})
const story = (extra: Partial<StoryDoc> = {}): StoryDoc => ({ script: '', style: '', characters: [], shots: [], ...extra })
const scene = (id: string, extra: Partial<StoryScene> = {}): StoryScene => ({ id, title: id.toUpperCase(), ...extra })
const ids = (s: StoryDoc) => s.shots.map((x) => x.id)
const scenesOf = (s: StoryDoc) => s.shots.map((x) => x.sceneId)
let n = 0
const newId = () => `n${++n}`

describe('scenes from stories made before them', () => {
  it('groups runs of shots by place, else by heading, with ids from their first shot', () => {
    const s = story({
      places: [{ id: 'road', name: 'Roadside', description: '' }],
      shots: [
        shot('a', { scene: 'S01 · Station', characterIds: ['jan'] }),
        shot('b', { scene: 'S01 · Station', partialIds: ['hanka'] }),
        shot('c', { placeId: 'road', scene: 'S02' }),
        shot('d', { placeId: 'road', scene: 'S02 again' }),
        shot('e', { scene: 'S01 · Station' }),
        shot('f'),
      ],
    })
    const { scenes, sceneIds } = deriveScenes(s)
    expect(scenes.map((x) => [x.id, x.title, x.placeId])).toEqual([
      ['sc_a', 'S01 · Station', undefined],
      ['sc_c', 'S02', 'road'],
      ['sc_e', 'S01 · Station', undefined],
      ['sc_f', 'Scene 4', undefined],
    ])
    expect(scenes[0]!.castIds).toEqual(['jan', 'hanka'])
    expect(sceneIds).toEqual(['sc_a', 'sc_a', 'sc_c', 'sc_c', 'sc_e', 'sc_f'])
  })

  it('never splits a multi-shot group across two headings', () => {
    const s = story({
      shots: [shot('a', { scene: 'One' }), shot('b', { scene: 'Two' }), shot('c', { scene: 'Two' })],
      multishots: [{ id: 'g', shotIds: ['a', 'b'], videoGenerationIds: ['take'] }],
    })
    expect(deriveScenes(s).sceneIds).toEqual(['sc_a', 'sc_a', 'sc_c'])
  })

  it('sanitizeStory upgrades a copy once, then has nothing to do', () => {
    const old = story({ shots: [shot('a', { scene: 'One' }), shot('b', { scene: 'Two' })] })
    const fixed = sanitizeStory(old)!
    expect(old.scenes).toBeUndefined()
    expect(old.shots[0]!.sceneId).toBeUndefined()
    expect(fixed.scenes!.map((x) => x.id)).toEqual(['sc_a', 'sc_b'])
    expect(scenesOf(fixed)).toEqual(['sc_a', 'sc_b'])
    expect(sanitizeStory(fixed)).toBeUndefined()
    expect(sanitizeStory(story())).toBeUndefined()
  })
})

describe('fields added later (picks, a shot’s light, a stale still, the script the scenes came from, the Story cut)', () => {
  const current = () =>
    story({
      outlinedFrom: 'EXT. LAKE — DAWN',
      cutTimelineId: 'cut1',
      cutSignature: 'abc123',
      characters: [{ id: 'h', name: 'Henryk', description: 'Man, 70s.', picks: { who: 'Man', age: '70s', face: ['Stubble'] } }],
      places: [{ id: 'p', name: 'Jetty', description: 'Lake, exterior.', picks: { type: 'Lake' } }],
      scenes: [scene('x')],
      shots: [shot('a', { sceneId: 'x', light: 'A torch beam', stillStale: true })],
    })

  it('a project without them, or with them as saved, opens unchanged', () => {
    expect(sanitizeStory(story({ scenes: [scene('x')], shots: [shot('a', { sceneId: 'x' })] }))).toBeUndefined()
    expect(sanitizeStory(current())).toBeUndefined()
  })

  it('drops or trims what isn’t their shape, in a copy', () => {
    const bad = current() as unknown as Record<string, unknown> & StoryDoc
    Object.assign(bad, { outlinedFrom: 42, cutTimelineId: '', cutSignature: null })
    Object.assign(bad.characters[0]!, { picks: { who: 'Man', age: 7, face: ['Stubble', 3, ''], hair: [] } })
    Object.assign(bad.places![0]!, { picks: 'Lake' })
    Object.assign(bad.shots[0]!, { light: 5, stillStale: 'yes' })
    const fixed = sanitizeStory(bad)!
    expect(fixed).toBeDefined()
    expect(fixed).not.toHaveProperty('outlinedFrom')
    expect(fixed).not.toHaveProperty('cutTimelineId')
    expect(fixed).not.toHaveProperty('cutSignature')
    expect(fixed.characters[0]!.picks).toEqual({ who: 'Man', face: ['Stubble'] })
    expect(fixed.places![0]).not.toHaveProperty('picks')
    expect(fixed.shots[0]).not.toHaveProperty('light')
    expect(fixed.shots[0]).not.toHaveProperty('stillStale')
    // The loaded document isn't touched.
    expect(bad.outlinedFrom).toBe(42)
    expect(bad.shots[0]!.light).toBe(5)
    expect(sanitizeStory(fixed)).toBeUndefined()
  })

  it('cleanPicks keeps words and lists of words only', () => {
    expect(cleanPicks({ who: 'Woman', wears: ['Coat', 'Scarf'] })).toEqual({ who: 'Woman', wears: ['Coat', 'Scarf'] })
    expect(cleanPicks({ who: ' ', wears: [] })).toBeUndefined()
    expect(cleanPicks(['Woman'])).toBeUndefined()
    expect(cleanPicks(undefined)).toBeUndefined()
  })
})

describe('normalizeStory', () => {
  it('keeps each scene’s shots together, in scene order; a shot without a scene joins the one before it', () => {
    const s = story({
      scenes: [scene('x'), scene('y')],
      shots: [shot('a', { sceneId: 'y' }), shot('b', { sceneId: 'x' }), shot('c'), shot('d', { sceneId: 'gone' })],
    })
    expect(normalizeStory(s)).toBe(true)
    expect(ids(s)).toEqual(['b', 'c', 'd', 'a'])
    expect(scenesOf(s)).toEqual(['x', 'x', 'x', 'y'])
    expect(normalizeStory(s)).toBe(false)
  })

  it('gives every scene a chapter once there are chapters, and orders scenes by chapter', () => {
    const s = story({
      chapters: [
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Two' },
      ],
      scenes: [scene('x', { chapterId: 'c2' }), scene('y'), scene('z', { chapterId: 'c1' }), scene('w', { chapterId: 'nope' })],
    })
    normalizeStory(s)
    expect(s.scenes!.map((x) => [x.id, x.chapterId])).toEqual([
      ['z', 'c1'],
      ['w', 'c1'],
      ['x', 'c2'],
      ['y', 'c2'],
    ])
  })

  it('keeps empty scenes (an outline before its shots are written)', () => {
    const s = story({ scenes: [scene('x'), scene('y')] })
    expect(normalizeStory(s)).toBe(false)
    expect(s.scenes).toHaveLength(2)
  })
})

describe('labels and inherited settings', () => {
  it('numbers shots within their scene once there are two or more scenes', () => {
    const s = story({ scenes: [scene('x'), scene('y')], shots: [shot('a', { sceneId: 'x' }), shot('b', { sceneId: 'y' }), shot('c', { sceneId: 'y' })] })
    expect(s.shots.map((x) => shotLabel(s, x))).toEqual(['1.1', '2.1', '2.2'])
    const one = story({ scenes: [scene('x')], shots: [shot('a', { sceneId: 'x' }), shot('b', { sceneId: 'x' })] })
    expect(one.shots.map((x) => shotLabel(one, x))).toEqual(['1', '2'])
  })

  it('blocking: the shot’s, else the scene’s, else the place’s; light: the scene’s, else the place’s', () => {
    const s = story({
      places: [{ id: 'p', name: 'P', description: '', blocking: 'place blocking', light: 'place light' }],
      scenes: [scene('x', { placeId: 'p' }), scene('y', { placeId: 'p', blocking: 'scene blocking', light: 'scene light' })],
    })
    const inX = shot('a', { sceneId: 'x', placeId: 'p' })
    const inY = shot('b', { sceneId: 'y', placeId: 'p' })
    expect([blockingOf(s, inX), lightOf(s, inX)]).toEqual(['place blocking', 'place light'])
    expect([blockingOf(s, inY), lightOf(s, inY)]).toEqual(['scene blocking', 'scene light'])
    expect(blockingOf(s, { ...inY, blocking: 'own' })).toBe('own')
  })

  it('a shot’s own light replaces the scene’s, as written; the scene’s is still what it would get', () => {
    const s = story({ scenes: [scene('y', { light: 'Dusk. When the car arrives, its headlights sweep the yard.' })] })
    const own = shot('b', { sceneId: 'y', light: 'A torch beam from below, when he looks up.' })
    expect(lightOf(s, own)).toBe('A torch beam from below, when he looks up.')
    expect(sceneLightOf(s, own)).toBe('Dusk.')
    expect(lightOf(s, { ...own, light: '  ' })).toBe('Dusk.')
  })
})

describe('the light as a steady state', () => {
  // The scenes' and places' light as the outline wrote them (The Chase, The Last Road, Impossible Worlds).
  const garage =
    'Cold cyan neon pours in from screen-right and reflects across the rain-slick floor; when the Porsche activates, its white headlights project screen-left toward the woman and the impact pillar.'
  const garagePlace =
    'Nighttime cyan neon enters from the eastern ramp on screen-right, creating hard blue edges, deep contrast and long reflections across the wet floor; the Porsche headlights later add a sudden white beam along the same east-to-west axis.'
  const moor =
    'Flat, cold overcast light from the grey sky, subtly brighter from the west behind the establishing camera; soft, nearly shadowless faces and a stark black smoke column on the eastern horizon.'
  const kethra =
    'Soft diffused daylight fills the pale violet sky; a distant white sun from screen right lights the three planets and casts long, faint shadows toward screen left through the atmospheric haze.'

  it('drops what happens: the headlights come on in their shot, not in every keyframe', () => {
    expect(steadyLight(garage)).toBe('Cold cyan neon pours in from screen-right and reflects across the rain-slick floor.')
    expect(steadyLight(garagePlace)).toBe('Nighttime cyan neon enters from the eastern ramp on screen-right, creating hard blue edges, deep contrast and long reflections across the wet floor.')
    expect(steadyLight('As soon as the lamp comes on, warm light fills the room; cold moonlight from the window.')).toBe('Cold moonlight from the window.')
  })

  it('drops far landmarks after the first clause, keeping what comes before them', () => {
    // The smoke column and the planets stood behind every shot, whichever way the camera looked.
    expect(steadyLight(moor)).toBe('Flat, cold overcast light from the grey sky, subtly brighter from the west behind the establishing camera; soft, nearly shadowless faces.')
    expect(steadyLight(kethra)).toBe('Soft diffused daylight fills the pale violet sky.')
  })

  it('a steady light stays exactly as written', () => {
    expect(steadyLight(' one warm bulb over the table ')).toBe('one warm bulb over the table')
    expect(steadyLight('Low golden evening sun from the left, long soft shadows; warm bounce from the sand.')).toBe('Low golden evening sun from the left, long soft shadows; warm bounce from the sand.')
    expect(steadyLight('')).toBe('')
  })

  it('lightOf reads it so; a scene light that is only an event leaves the place’s', () => {
    const s = story({
      places: [{ id: 'p', name: 'Garage', description: '', light: garagePlace }],
      scenes: [scene('x', { placeId: 'p', light: garage }), scene('y', { placeId: 'p', light: 'When the Porsche activates, headlights flood the lane.' })],
    })
    expect(lightOf(s, shot('a', { sceneId: 'x', placeId: 'p' }))).toBe(steadyLight(garage))
    expect(lightOf(s, shot('b', { sceneId: 'y', placeId: 'p' }))).toBe(steadyLight(garagePlace))
  })
})

describe('edits', () => {
  const twoScenes = () =>
    story({
      scenes: [scene('x', { placeId: 'px' }), scene('y', { placeId: 'py' })],
      shots: [shot('a', { sceneId: 'x', placeId: 'px' }), shot('b', { sceneId: 'x', placeId: 'px' }), shot('c', { sceneId: 'y', placeId: 'py' })],
    })

  it('moveShot swaps inside a scene and crosses into the neighbouring scene at its edge, taking its place', () => {
    const s = twoScenes()
    moveShot(s, 'a', 1)
    expect(ids(s)).toEqual(['b', 'a', 'c'])
    moveShot(s, 'a', 1)
    expect(ids(s)).toEqual(['b', 'a', 'c'])
    expect(s.shots[1]).toMatchObject({ sceneId: 'y', scene: 'Y', placeId: 'py' })
    moveShot(s, 'b', -1)
    expect(ids(s)).toEqual(['b', 'a', 'c'])
  })

  it('moveShot hops over a whole multi-shot group', () => {
    const s = story({
      scenes: [scene('x')],
      shots: ['a', 'b', 'c', 'd'].map((id) => shot(id, { sceneId: 'x' })),
      multishots: [{ id: 'g', shotIds: ['b', 'c'], videoGenerationIds: [] }],
    })
    moveShot(s, 'a', 1)
    expect(ids(s)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('groups are valid only within one scene', () => {
    const s = twoScenes()
    s.multishots = [{ id: 'g', shotIds: ['b', 'c'], videoGenerationIds: [] }]
    expect(validGroups(s)).toEqual([])
  })

  it('insertShot adds at the scene’s end (also into an empty scene) with its heading and place', () => {
    const s = twoScenes()
    s.scenes!.splice(1, 0, scene('empty', { placeId: 'pe' }))
    insertShot(s, 'empty', shot('n'))
    insertShot(s, 'x', shot('m'))
    expect(ids(s)).toEqual(['a', 'b', 'm', 'n', 'c'])
    expect(s.shots[3]).toMatchObject({ sceneId: 'empty', scene: 'EMPTY', placeId: 'pe' })
  })

  it('insertShot after a shot inside a multi-shot group adds after the whole group, which stays whole', () => {
    // Between b and c the group stopped being valid, and the next edit that saved validGroups dropped it with its takes.
    const s = story({
      scenes: [scene('x')],
      shots: ['a', 'b', 'c', 'd'].map((id) => shot(id, { sceneId: 'x' })),
      multishots: [{ id: 'g', shotIds: ['a', 'b', 'c'], videoGenerationIds: ['take'] }],
    })
    insertShot(s, 'x', shot('n'), 'b')
    expect(ids(s)).toEqual(['a', 'b', 'c', 'n', 'd'])
    expect(validGroups(s).map((g) => g.id)).toEqual(['g'])
    insertShot(s, 'x', shot('m'), 'n')
    expect(ids(s)).toEqual(['a', 'b', 'c', 'n', 'm', 'd'])
  })

  it('setScenePlace moves the shots that had the old place or none, not ones set elsewhere', () => {
    const s = twoScenes()
    s.shots[1]!.placeId = 'elsewhere'
    s.shots.splice(1, 0, shot('z', { sceneId: 'x' }))
    setScenePlace(s, 'x', 'new')
    expect(s.shots.slice(0, 3).map((x) => x.placeId)).toEqual(['new', 'new', 'elsewhere'])
    expect(s.scenes![0]!.placeId).toBe('new')
  })

  it('replaceSceneShots swaps a scene’s shots in place and drops the groups over the old ones', () => {
    const s = twoScenes()
    s.multishots = [{ id: 'g', shotIds: ['a', 'b'], videoGenerationIds: [] }]
    replaceSceneShots(s, 'x', [shot('n1'), shot('n2')], [{ id: 'h', shotIds: ['n1', 'n2'], videoGenerationIds: [] }])
    expect(ids(s)).toEqual(['n1', 'n2', 'c'])
    expect(s.shots[0]).toMatchObject({ sceneId: 'x', scene: 'X', placeId: 'px' })
    expect(s.multishots!.map((g) => g.id)).toEqual(['h'])
    replaceSceneShots(s, 'y', [])
    expect(ids(s)).toEqual(['n1', 'n2'])
  })

  it('splitSceneAt makes the rest of the scene a new scene after it; mergeWithPrevious undoes it', () => {
    const s = twoScenes()
    expect(splitSceneAt(s, 'a', newId)).toBeUndefined()
    const made = splitSceneAt(s, 'b', newId)!
    expect(s.scenes!.map((x) => x.id)).toEqual(['x', made, 'y'])
    expect(scenesOf(s)).toEqual(['x', made, 'y'])
    expect(mergeWithPrevious(s, made)).toBe(true)
    expect(s.scenes!.map((x) => x.id)).toEqual(['x', 'y'])
    expect(scenesOf(s)).toEqual(['x', 'x', 'y'])
  })

  it('splitSceneAt won’t cut through a multi-shot group', () => {
    const s = twoScenes()
    s.multishots = [{ id: 'g', shotIds: ['a', 'b'], videoGenerationIds: [] }]
    expect(splitSceneAt(s, 'b', newId)).toBeUndefined()
  })

  it('moveScene reorders scenes and their shots follow; at a chapter’s edge it changes chapter', () => {
    const s = twoScenes()
    moveScene(s, 'y', -1)
    expect(ids(s)).toEqual(['c', 'a', 'b'])
    const c = story({
      chapters: [
        { id: 'c1', title: '1' },
        { id: 'c2', title: '2' },
      ],
      scenes: [scene('x', { chapterId: 'c1' }), scene('y', { chapterId: 'c2' })],
    })
    moveScene(c, 'y', -1)
    expect(c.scenes!.map((x) => [x.id, x.chapterId])).toEqual([
      ['x', 'c1'],
      ['y', 'c1'],
    ])
  })

  it('addScene, removeScene and removeChapter', () => {
    const s = story({
      chapters: [
        { id: 'c1', title: '1' },
        { id: 'c2', title: '2' },
      ],
      scenes: [scene('x', { chapterId: 'c1' })],
    })
    addScene(s, scene('y'), 'x')
    addScene(s, scene('z'))
    expect(s.scenes!.map((x) => [x.id, x.chapterId])).toEqual([
      ['x', 'c1'],
      ['y', 'c1'],
      ['z', 'c2'],
    ])
    removeChapter(s, 'c2')
    expect(s.scenes!.map((x) => x.chapterId)).toEqual(['c1', 'c1', 'c1'])
    s.shots = [shot('a', { sceneId: 'y' }), shot('b', { sceneId: 'z' })]
    s.multishots = [{ id: 'g', shotIds: ['a'], videoGenerationIds: [] }]
    removeScene(s, 'y')
    expect(ids(s)).toEqual(['b'])
    expect(s.multishots).toEqual([])
  })
})

describe('timeline marks', () => {
  it('marks chapters at their first shot, else scenes when there are two or more', () => {
    const shots = [shot('a', { sceneId: 'x' }), shot('b', { sceneId: 'x' }), shot('c', { sceneId: 'z' })]
    const chaptered = story({
      chapters: [
        { id: 'c1', title: 'Arrival' },
        { id: 'c2', title: 'Empty' },
        { id: 'c3', title: 'Night' },
      ],
      scenes: [scene('x', { chapterId: 'c1' }), scene('y', { chapterId: 'c2' }), scene('z', { chapterId: 'c3' })],
      shots,
    })
    expect(assemblyMarks(chaptered)).toEqual([
      { shotId: 'a', kind: 'chapter', name: '1 · Arrival' },
      { shotId: 'c', kind: 'chapter', name: '3 · Night' },
    ])
    expect(assemblyMarks(story({ scenes: [scene('x'), scene('z')], shots }))).toEqual([
      { shotId: 'a', kind: 'standard', name: '1 · X' },
      { shotId: 'c', kind: 'standard', name: '2 · Z' },
    ])
    expect(assemblyMarks(story({ scenes: [scene('x')], shots: shots.slice(0, 2) }))).toEqual([])
  })
})

describe('the outline as the story’s structure', () => {
  it('merges cast and places by name, replaces chapters, scenes and shots, keeps only the scene light that differs', () => {
    const s = story({
      characters: [{ id: 'j', name: 'Jan', description: 'set by hand' }],
      scenes: [scene('old')],
      shots: [shot('a', { sceneId: 'old' })],
      multishots: [{ id: 'g', shotIds: ['a'], videoGenerationIds: [] }],
    })
    outlineToStory(
      s,
      {
        title: 'Smoke',
        logline: 'A family sees smoke.',
        characters: [{ name: 'jan', description: 'from the outline' }, { name: 'Hanka', description: 'mother' }],
        places: [{ name: 'Road', description: 'asphalt', light: 'dusk sun' }],
        chapters: [
          {
            title: 'Arrival',
            summary: '',
            scenes: [
              { heading: 'Road', place: 'Road', time: 'dusk', light: 'dusk sun', blocking: '', characters: ['Jan', 'Hanka', 'Ghost'], summary: 'They stop.', script: 'EXT. ROAD', seconds: 30, continuesPrevious: false },
              { heading: 'Road, later', place: 'Road', time: 'night', light: 'headlights', blocking: 'Jan left', characters: [], summary: '', script: '', seconds: 20, continuesPrevious: true },
            ],
          },
        ],
      },
      newId,
    )
    expect(s.characters.map((c) => [c.name, c.description])).toEqual([
      ['Jan', 'set by hand'],
      ['Hanka', 'mother'],
    ])
    expect([s.title, s.shots, s.multishots, s.chapters!.map((c) => c.title)]).toEqual(['Smoke', [], [], ['Arrival']])
    const [a, b] = s.scenes!
    expect(a).toMatchObject({ title: 'Road', time: 'dusk', castIds: ['j', s.characters[1]!.id], placeId: s.places![0]!.id, script: 'EXT. ROAD' })
    expect(a!.light).toBeUndefined()
    expect(b).toMatchObject({ light: 'headlights', blocking: 'Jan left', continuesPrevious: true, chapterId: s.chapters![0]!.id })
  })
})

describe('cast and places by name', () => {
  it('adds the new ones and only fills gaps in the ones the story has', () => {
    const s = story({
      characters: [{ id: 'j', name: 'Jan', description: 'kept', voice: '' }],
      places: [{ id: 'r', name: 'Road', description: '', light: 'kept light' }],
    })
    const cast = mergeCast(s, [{ name: 'JAN', description: 'new', voice: 'low' }, { name: 'Zosia', description: 'girl' }], newId)
    expect(s.characters.map((c) => [c.name, c.description, c.voice])).toEqual([
      ['Jan', 'kept', 'low'],
      ['Zosia', 'girl', undefined],
    ])
    expect(cast.get('zosia')?.id).toBe(s.characters[1]!.id)
    mergePlaces(s, [{ name: 'road', description: 'asphalt', light: 'dusk' }, { name: 'Forest', description: 'birches' }], newId)
    expect(s.places!.map((p) => [p.name, p.description, p.light])).toEqual([
      ['Road', 'asphalt', 'kept light'],
      ['Forest', 'birches', undefined],
    ])
  })
})
