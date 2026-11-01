import { describe, expect, it } from 'vitest'
import {
  type RawOutline,
  breakdownSystem,
  demoOutline,
  improveLook,
  improveLookSystem,
  outlineScript,
  outlineSystem,
  placeFor,
  placeViewSystem,
  sanitizeOutline,
  sceneShotsSystem,
  sceneShotsUserPrompt,
  sliceScript,
  type structuredCall,
  writeSceneShots,
  writeScript,
  writePlaceView,
  writeScriptSystem,
} from '../../src/server/services/director'
import { getModel } from '../../src/shared/models/registry'
import type { SceneShotsRequest } from '../../src/shared/types/story'

const SCRIPT = `EXT. ROADSIDE PAST WŁOSZCZOWA — DUSK
The Nissan stops on the shoulder. Everyone gets out.

JAN: [quietly] Look. Smoke.
HANKA: Over the forest?

INT. FARMHOUSE KITCHEN - NIGHT
Hanka puts the kettle on. Zosia sleeps on the bench.

JAN: We leave at dawn.`

const scene = (extra: Partial<RawOutline['chapters'][number]['scenes'][number]> = {}) => ({
  heading: 'Scene',
  place: '',
  time: '',
  light: '',
  blocking: '',
  characters: [],
  summary: 'Something happens.',
  opening: '',
  seconds: 30,
  continuesPrevious: false,
  ...extra,
})

describe('the script cut into scenes', () => {
  it('finds each opening in order, whatever the spacing, case and quotes', () => {
    const parts = sliceScript(SCRIPT, ['EXT. ROADSIDE', 'int. farmhouse   kitchen - night hanka puts'])
    expect(parts[0]).toMatch(/^EXT\. ROADSIDE[\s\S]*Over the forest\?$/)
    expect(parts[1]).toMatch(/^INT\. FARMHOUSE KITCHEN[\s\S]*We leave at dawn\.$/)
  })

  it('a scene whose opening isn’t found gets no part; its text stays with the scene before', () => {
    const parts = sliceScript(SCRIPT, ['EXT.', 'This line is not in the script at all', 'INT. FARMHOUSE KITCHEN'])
    expect(parts[1]).toBe('')
    expect(parts[0]).toContain('Over the forest?')
    expect(parts[2]).toContain('We leave at dawn.')
  })

  it('matches the first five words when the model strays further in, and never goes back', () => {
    const parts = sliceScript(SCRIPT, ['x', 'Hanka puts the kettle on and sings', 'EXT. ROADSIDE PAST'])
    // Copied from below its heading: the heading comes along (it isn't the end of the scene before).
    expect(parts[0]).toMatch(/Over the forest\?$/)
    expect(parts[1]).toMatch(/^INT\. FARMHOUSE KITCHEN - NIGHT\nHanka puts the kettle on\./)
    expect(parts[2]).toBe('')
  })

  it('never finds a later scene’s opening in the first scene’s own (the same heading twice)', () => {
    const script = 'INT. KITCHEN — NIGHT\nAnna makes tea.\n\nINT. KITCHEN — NIGHT\nAnna washes up.\n\nEXT. GARDEN — DAY\nThe dog barks.'
    // Scene 2's opening strays after its first five words — and those are scene 1's too.
    const parts = sliceScript(script, ['INT. KITCHEN — NIGHT Anna makes tea.', 'INT. KITCHEN — NIGHT Anna washes the dishes', 'EXT. GARDEN — DAY The dog barks.'])
    expect(parts).toEqual(['INT. KITCHEN — NIGHT\nAnna makes tea.', 'INT. KITCHEN — NIGHT\nAnna washes up.', 'EXT. GARDEN — DAY\nThe dog barks.'])
  })

  it('knows Polish scene headings (WN. / ZEW. / PL. / WN./PL.), in capitals only: “Pl.” also opens an address', () => {
    const script = 'WN. SALON — DZIEŃ\nAnna czyta.\nPl. Zbawiciela widać za oknem.\n\nZEW. OGRÓD — NOC\nPies szczeka.\n\nWN./PL. GANEK — NOC\nAnna wychodzi.'
    expect(sliceScript(script, ['x', 'Pies szczeka.', 'Anna wychodzi.'])).toEqual([
      'WN. SALON — DZIEŃ\nAnna czyta.\nPl. Zbawiciela widać za oknem.',
      'ZEW. OGRÓD — NOC\nPies szczeka.',
      'WN./PL. GANEK — NOC\nAnna wychodzi.',
    ])
    const scenes = demoOutline({ script }).chapters[0]!.scenes
    expect(scenes.map((s) => [s.place, s.time])).toEqual([
      ['Salon', 'dzień'],
      ['Ogród', 'noc'],
      ['Ganek', 'noc'],
    ])
  })
})

describe('outline (pass one)', () => {
  it('sanitizes: known cast only, every scene a place, clamped lengths, no continuing first scene, script parts attached', () => {
    const o = sanitizeOutline(
      {
        title: ' Smoke ',
        logline: 'A family sees smoke.',
        characters: [{ name: 'Jan', description: 'father', voice: '' }, { name: ' ', description: '', voice: '' }],
        places: [{ name: 'Roadside', description: 'asphalt', blocking: 'Jan left', light: '' }],
        chapters: [
          { title: '', summary: '', scenes: [] },
          {
            title: 'Arrival',
            summary: 'They stop.',
            scenes: [
              scene({ heading: 'Roadside — dusk', place: 'roadside', characters: ['JAN', 'Ghost'], opening: 'EXT. ROADSIDE', seconds: 9999, continuesPrevious: true }),
              scene({ heading: 'Kitchen', place: 'Nowhere', opening: 'INT. FARMHOUSE KITCHEN - NIGHT', seconds: 0 }),
            ],
          },
        ],
      },
      SCRIPT,
    )
    expect(o.title).toBe('Smoke')
    expect(o.characters).toEqual([{ name: 'Jan', description: 'father' }])
    // A place the list doesn't have is added, so the scene still gets a look and a photo in Cast & Places.
    expect(o.places).toEqual([{ name: 'Roadside', description: 'asphalt', blocking: 'Jan left' }, { name: 'Nowhere', description: '' }])
    expect(o.chapters).toHaveLength(1)
    const [a, b] = o.chapters[0]!.scenes
    expect(a).toMatchObject({ place: 'Roadside', characters: ['Jan'], seconds: 900, continuesPrevious: false })
    expect(b).toMatchObject({ place: 'Nowhere', seconds: 30 })
    expect(a!.script).toContain('Over the forest?')
    expect(b!.script).toMatch(/^INT\. FARMHOUSE/)
  })

  it('drops a place no scene is set in (the same location listed twice under two names)', () => {
    const o = sanitizeOutline(
      {
        title: 'One Bar',
        logline: '',
        characters: [],
        places: [
          { name: 'Mountain hut common room', description: 'dark timber, a heavy beam', blocking: '', light: '' },
          { name: 'Mountain Hut', description: 'plank walls, low beams', blocking: '', light: '' },
        ],
        chapters: [{ title: 'Night', summary: '', scenes: [scene({ heading: 'Mountain Hut — night', place: 'Mountain Hut', opening: 'EXT. ROADSIDE' })] }],
      },
      SCRIPT,
    )
    expect(o.places.map((p) => p.name)).toEqual(['Mountain Hut'])
    expect(o.chapters[0]!.scenes[0]!.place).toBe('Mountain Hut')
  })

  it('demo rules: headings start scenes, their place and time come from the heading, NAME: lines name the cast', () => {
    const raw = demoOutline({ script: SCRIPT })
    const o = sanitizeOutline(raw, SCRIPT)
    expect(o.places.map((p) => p.name)).toEqual(['Roadside Past Włoszczowa', 'Farmhouse Kitchen'])
    expect(o.characters.map((c) => c.name)).toEqual(['Jan', 'Hanka'])
    const scenes = o.chapters[0]!.scenes
    expect(scenes.map((s) => [s.place, s.time])).toEqual([
      ['Roadside Past Włoszczowa', 'dusk'],
      ['Farmhouse Kitchen', 'night'],
    ])
    expect(scenes[1]!.script).toMatch(/^INT\. FARMHOUSE KITCHEN - NIGHT[\s\S]*dawn\.$/)
  })

  it('finds a scene’s place by its name, a part of it, or the words of its look; else adds it', () => {
    const places = [
      { name: 'Misty Lakeshore', description: 'Damp grass and tall reeds around the landward end of a small weathered wooden pier.' },
      { name: 'Farmhouse Kitchen', description: 'Low beams, a stove.' },
    ]
    expect(placeFor('misty lakeshore', places)).toEqual({ place: 'Misty Lakeshore' })
    expect(placeFor('Kitchen', places)).toEqual({ place: 'Farmhouse Kitchen' })
    // The Lake's Invitation: "EXT. WOODEN PIER" scenes came back without a place — no photo, look or blocking.
    expect(placeFor('Wooden Pier', places)).toEqual({ place: 'Misty Lakeshore' })
    expect(placeFor('Railway Station', places)).toEqual({ place: 'Railway Station', added: { name: 'Railway Station', description: '' } })
    expect(placeFor(' ', places)).toEqual({ place: '' })
  })

  it('the outline prompt keeps the staging lessons; the classic prompt is untouched by the split', async () => {
    const system = outlineSystem()
    expect(system).toContain('never through a car window')
    expect(system).toContain('"opening"')
    expect(system).toContain('exactly as written in "places"')
    expect(system).toContain('A location seen in several scenes is one place')
    expect(system).toContain('(180° rule)')
    expect(breakdownSystem()).toContain('"scene": the scene heading')
    let user = ''
    const call = (async (_c: unknown, _s: string, u: string) => {
      user = u
      return { result: demoOutline({ script: SCRIPT }), via: 'anthropic', model: 'fake' }
    }) as unknown as typeof structuredCall
    const res = await outlineScript({ script: SCRIPT, characters: [{ name: 'Jan', description: 'father, 40' }] }, { anthropic: 'k' }, false, call)
    expect(user).toContain('Existing characters')
    expect(res.outline.chapters[0]!.scenes).toHaveLength(2)
  })
})

describe('a scene’s shots (pass two)', () => {
  const req: SceneShotsRequest = {
    script: 'Hanka puts the kettle on.\n\nJAN: We leave at dawn.',
    targetModelId: 'runpod-ltx-2.5',
    scene: { heading: 'Farmhouse kitchen — night', summary: 'Jan decides to leave.', time: 'night', light: 'one warm bulb over the table' },
    place: { name: 'Farmhouse kitchen', description: 'low beams; the window to the yard behind the table', blocking: 'Hanka at the stove on the left', photos: ['the stove and the window'] },
    characters: [
      { name: 'Jan', description: 'father, 40', voice: 'deep male voice' },
      { name: 'Hanka', description: 'mother, 38' },
    ],
    previous: { heading: 'Roadside — dusk', summary: 'They see smoke.', samePlace: false, lastShot: { shotType: 'WIDE', description: 'The family by the car', prompt: '' } },
    next: { heading: 'Dawn road', summary: 'They drive off.' },
    targetShots: 4,
  }

  it('the prompt carries the scene, its place, cast, neighbours and its part of the script', () => {
    const user = sceneShotsUserPrompt(req)
    for (const text of ['Farmhouse kitchen — night (night)', 'Light: one warm bulb over the table', 'Blocking at the start of the scene, seen from the establishing camera: Hanka at the stove on the left', 'Its reference photos show: the stove and the window', '- Jan: father, 40 Voice: deep male voice', 'It ends on: WIDE — The family by the car', 'The scene after: Dawn road', 'Aim for about 4 shots', 'We leave at dawn.']) {
      expect(user).toContain(text)
    }
    const system = sceneShotsSystem(getModel('runpod-ltx-2.5'))
    expect(system).toContain('Shot 1 is a WIDE establishing shot')
    expect(system).toContain('A keyframe is one moment')
    expect(system).toContain('never as left or right')
    expect(system).toContain('"view": where the camera stands')
    expect(system).toContain('names whose shoulder')
    expect(system).toContain('"frame": the shot\'s first moment as one still picture')
    expect(system).toContain('the same hands')
    // What made the Kael group hard to read: percentages, compass backgrounds, the same reveal three times.
    expect(system).toContain('Never percentages, multiples or heights')
    expect(system).toContain('never by compass directions')
    expect(system).toContain('moves the action on to its next state')
    expect(system).toContain('about one clear action per 2–3 seconds of the shot')
    // A reveal or transformation gets a set end, in stages; the next shot opens on that moment. From the same camera,
    // a change seen at a glance: an end like the start froze the clip (The Last Road 4, 5), another composition cut it
    // in two (Impossible Worlds 4); The Chase's end frames kept the moved phones where they were.
    expect(system).toContain('"endFrame": only when the shot ends on a large, clearly visible change its first frame can\'t show')
    expect(system).toContain('seen from exactly the same camera as "frame" (the same framing and lens, nothing recomposed)')
    expect(system).toContain('Its first sentence says what changed and what is no longer where it was ("The phone is no longer on the floor; it is in her raised hand.")')
    expect(system).toContain('an end that barely differs from the start freezes the clip, and one from another camera cuts in the middle of it')
    expect(system).toContain('Never for a shot where someone speaks.')
    // Neon Miami: a drone flight with an end frame grew a tower out of the water.
    expect(system).toContain('Never for a camera move')
    // Kael 5–7: the same view, only higher each time.
    expect(system).toContain('never the same view again from a little higher')
    expect(system).toContain('it begins, it spreads, it completes')
    expect(system).toContain('The shot after one with an endFrame opens on that same moment')
    // A shot with an endFrame always plays on its own (soloEndFrameShots): the prompt mustn't invite grouping its stages.
    expect(system).toContain('A shot with an endFrame plays on its own: its "group" is 0.')
    expect(system).toContain('each stage a clip of its own (group 0)')
    expect(system).not.toContain('next state (it begins')
    expect(system).toContain('"background": which of the place\'s four views lies behind the subject')
    expect(system).toContain('never keep the main view behind everyone')
    expect(sceneShotsUserPrompt({ ...req, place: { ...req.place!, views: ['main', 'reverse'] } })).toContain('It has a photo of these views: main, reverse')
    expect(sceneShotsUserPrompt({ ...req, place: { ...req.place!, views: ['main'] } })).toContain('It has a photo of only its main view')
    expect(system).not.toContain('"scene": the scene heading')
  })

  it('writes for LTX shot by shot, from each keyframe, with what the renders got wrong ruled out', () => {
    const system = sceneShotsSystem(getModel('runpod-ltx-2.5'))
    // Every native multi-shot take failed; single shots from their own keyframe were the best.
    expect(system).toContain('Every shot is rendered as its own image-to-video clip from its keyframe')
    expect(system).toContain('- "group": always 0 — every shot is rendered as a clip of its own. Each shot moves the action on')
    // What is behind the subject goes into the keyframe's picture; the prompt rendered from it says only what happens.
    expect(system).toContain('The "frame" already shows who is where and what is behind them: the prompt says only what happens next.')
    expect(system).not.toContain('End with what is seen behind the subject')
    expect(system).toContain('their expression; then what is seen behind the subject from this camera position')
    // Keyframes looked into the lens.
    expect(system).toContain('Everyone looks at a person or a landmark, never into the lens.')
    expect(system).toContain('what they look at (a person or a landmark, never the lens)')
    // Impossible Worlds 5: "flakes" came out as snow.
    expect(system).toContain('"grey ash flakes" every time — never just "flakes", which was drawn as snow')
    // The Chase: the hidden man leaked into the opening and came out lit.
    expect(system).toContain('showing everyone who is there when the scene starts, already in place and in plain view')
    expect(system).toContain('Someone who arrives or is revealed later is left out of it — or, when they are already there unseen, listed in "hidden".')
    expect(system).toContain('- "hidden": who is in the frame only as an unreadable dark outline or silhouette')
    // The Chase: headlights that come on in one shot were on in all eleven keyframes.
    expect(system).toContain('only a light that switches on or goes out in this shot, which is part of its action')
    expect(system).toContain('The light is a steady state: a light that switches on or goes out (headlights, a lamp) does so in one shot\'s prompt')
    expect(system).toContain('"sfx": the ambience and effects as 2–3 concrete sound sources')
    expect(system).toContain('for lines a moment before the first word and after the last, a quarter second between two lines, and a second for every 2.5 spoken words (two lines of 9 words: 9 seconds)')
  })

  it('Kling keeps its multi-shot groups and the Kling guidance', () => {
    const system = sceneShotsSystem(getModel('kling-3.0'))
    expect(system).toContain('2 to 6 shots, at most 15 seconds together, usually an exchange of lines in one place')
    expect(system).toContain('Each shot of a group moves the action on')
    expect(system).not.toContain('"group": always 0')
    expect(system).not.toContain('image-to-video clip')
  })

  it('the light is a steady state with no distant landmarks — those are the place’s geography', () => {
    for (const system of [outlineSystem(), breakdownSystem()]) {
      expect(system).toContain('It is a steady state that holds in every shot: no events (headlights that come on are an action of the shot they come on in) and no distant landmarks (they are in the description).')
      expect(system).toContain('Distant landmarks (a smoke column on the horizon, planets in the sky) belong to the geography too, on the side where they are.')
    }
    expect(outlineSystem()).toContain('"light": the light in this scene — source, direction, colour — true to the place and the time of day; a steady state with no events')
  })

  it('fills in the heading and place; on LTX every shot is a clip of its own, whatever groups the reply numbered', async () => {
    const call = (async () => ({
      result: {
        shots: [
          { description: 'wide', shotType: 'WIDE', camera: 'static', prompt: 'Hanka at the stove.', durationSeconds: 3, characters: ['Hanka'], partial: [], dialogue: [], sfx: '', group: 1 },
          { description: 'pours', shotType: 'INSERT', camera: 'static', prompt: 'Hanka pours the water.', durationSeconds: 3, characters: [], partial: ['Hanka'], dialogue: [], sfx: '', group: 1 },
          { description: 'line', shotType: 'MEDIUM', camera: 'static', prompt: 'Jan speaks.', durationSeconds: 3, characters: ['Jan'], partial: [], dialogue: [{ character: 'Jan', text: 'We leave at dawn.' }], sfx: '', group: 2 },
        ],
      },
      via: 'anthropic',
      model: 'fake',
    })) as unknown as typeof structuredCall
    const res = await writeSceneShots(req, { anthropic: 'k' }, false, call)
    expect(res.shots.map((s) => [s.scene, s.place, s.group])).toEqual([
      ['Farmhouse kitchen — night', 'Farmhouse kitchen', 0],
      ['Farmhouse kitchen — night', 'Farmhouse kitchen', 0],
      ['Farmhouse kitchen — night', 'Farmhouse kitchen', 0],
    ])
    // The two silent shots stay one clip on Kling.
    const kling = await writeSceneShots({ ...req, targetModelId: 'kling-3.0' }, { anthropic: 'k' }, false, call)
    expect(kling.shots.map((s) => s.group)).toEqual([1, 1, 0])
  })

  it('a shot gets the seconds its lines need; someone hidden in the dark is named as hidden only', async () => {
    const nine = 'You were never supposed to find this place, Claire.'
    const call = (async () => ({
      result: {
        shots: [
          {
            description: 'garage',
            shotType: 'WIDE',
            camera: 'static',
            prompt: 'Claire steps out of the lift.',
            durationSeconds: 5,
            characters: ['Hanka', 'Jan'],
            partial: [],
            hidden: [' jan ', 'Jan', ''],
            dialogue: [
              { character: 'Hanka', text: nine },
              { character: 'Hanka', text: `[quietly] ${nine}` },
            ],
            sfx: '',
            group: 0,
          },
          { description: 'line', shotType: 'MEDIUM', camera: 'static', prompt: 'Jan speaks.', durationSeconds: 4, characters: ['Jan'], partial: [], hidden: [], dialogue: [], sfx: '', group: 0 },
        ],
      },
      via: 'anthropic',
      model: 'fake',
    })) as unknown as typeof structuredCall
    const [a, b] = (await writeSceneShots(req, { anthropic: 'k' }, false, call)).shots
    // Two lines of 9 words: 8.35 s laid out (secondsForLines) — 9 s, not the 5 s asked for.
    expect(a!.durationSeconds).toBe(9)
    expect(b!.durationSeconds).toBe(4)
    // Names stay names (the storyboard maps them to the cast); a hidden one is out of "characters".
    expect(a).toMatchObject({ characters: ['Hanka'], hidden: ['jan'] })
    expect(b).not.toHaveProperty('hidden')
  })

  it('keeps each shot’s camera position and first frame, trimmed; empty ones are left out', async () => {
    const call = (async () => ({
      result: {
        shots: [
          { description: 'wide', shotType: 'WIDE', view: ' at the door, looking in ', frame: ' Hanka at the stove, back to us. ', background: 'Main', camera: 'static', prompt: 'Hanka at the stove.', durationSeconds: 3, characters: ['Hanka'], partial: [], dialogue: [], sfx: '', group: 0 },
          { description: 'line', shotType: 'MEDIUM', view: '', frame: ' ', background: 'sideways', camera: 'static', prompt: 'Jan speaks.', durationSeconds: 3, characters: ['Jan'], partial: [], dialogue: [], sfx: '', group: 0 },
        ],
      },
      via: 'anthropic',
      model: 'fake',
    })) as unknown as typeof structuredCall
    const [a, b] = (await writeSceneShots(req, { anthropic: 'k' }, false, call)).shots
    expect(a).toMatchObject({ view: 'at the door, looking in', frame: 'Hanka at the stove, back to us.', background: 'main' })
    expect(b).not.toHaveProperty('view')
    expect(b).not.toHaveProperty('frame')
    // Only the place's four views: anything else is dropped (the shot then looks the main way).
    expect(b).not.toHaveProperty('background')
  })

  it('a shot with an end frame keeps it, trimmed, and renders on its own — never in a group', async () => {
    const call = (async () => ({
      result: {
        shots: [
          { description: 'activation', shotType: 'HIGH-ANGLE MEDIUM FULL', view: '', frame: 'Kael stands on the salt.', endFrame: ' The first glowing ring circles his boots. ', background: 'main', camera: 'static', prompt: 'A ring of light rises around Kael.', durationSeconds: 4, characters: ['Hanka'], partial: [], dialogue: [], sfx: '', group: 1 },
          { description: 'spread', shotType: 'AERIAL WIDE', view: '', frame: 'The ring seen from above.', endFrame: '', background: 'main', camera: 'static', prompt: 'More rings emerge.', durationSeconds: 4, characters: [], partial: [], dialogue: [], sfx: '', group: 1 },
        ],
      },
      via: 'anthropic',
      model: 'fake',
    })) as unknown as typeof structuredCall
    const [a, b] = (await writeSceneShots({ ...req, targetModelId: 'runpod-ltx-2.5' }, { anthropic: 'k' }, false, call)).shots
    expect(a).toMatchObject({ endFrame: 'The first glowing ring circles his boots.', group: 0 })
    expect(b).not.toHaveProperty('endFrame')
    expect(b!.group).toBe(0)
  })

  it('demo rules open on a wide; a scene with neither script nor summary is refused', async () => {
    const demo = await writeSceneShots(req, {}, true)
    expect(demo.shots[0]!.shotType).toBe('WIDE')
    expect(demo.via).toBe('demo')
    await expect(writeSceneShots({ ...req, script: '', scene: { heading: 'X' } }, {}, true)).rejects.toThrow(/no script or summary/)
  })
})

describe('the look designer and the idea → script', () => {
  it('improves a look in the form the scenes read it, with the story for context', async () => {
    let system = ''
    let user = ''
    const call = (async (_c: unknown, s: string, u: string) => {
      system = s
      user = u
      return { result: { description: '  Jan, 40s, lean, short dark-blond hair; grey zip-up jacket.  ' }, via: 'anthropic', model: 'fake' }
    }) as unknown as typeof structuredCall
    const res = await improveLook({ kind: 'character', name: 'Jan', description: 'father', style: '35mm', script: SCRIPT }, { anthropic: 'k' }, false, call)
    expect(res.description).toBe('Jan, 40s, lean, short dark-blond hair; grey zip-up jacket.')
    expect(system).toContain('"Name, age, build, face and hair; clothing and distinguishing features"')
    expect(user).toContain('What the user wrote: father')
    expect(user).toContain('EXT. ROADSIDE')
    expect(improveLookSystem('place')).toContain('what lies on each side')
    await expect(improveLook({ kind: 'place', name: ' ', description: '' }, {}, true)).rejects.toThrow(/name or a few words/)
  })

  it('writes a filmable screenplay from an idea (demo rules: one scene with the idea)', async () => {
    expect(writeScriptSystem()).toContain('never through a car window')
    expect(writeScriptSystem()).toContain('in the language of the idea')
    // What the camera needs comes from the script: the place's layout, who faces where, who holds what.
    expect(writeScriptSystem()).toContain('what is on each side of where the action happens')
    expect(writeScriptSystem()).toContain('who holds which prop')
    const demo = await writeScript({ idea: 'Rodzina widzi dym nad lasem' }, {}, true)
    expect(demo.script).toMatch(/^EXT\. SOMEWHERE — DAY\nRodzina widzi dym nad lasem$/)
    await expect(writeScript({ idea: '  ' }, {}, true)).rejects.toThrow(/idea/)
  })
})

describe('a place’s other directions, written before they are drawn', () => {
  const lake = { name: 'Misty Lakeshore', description: 'From the southern bank looking north: the pier projects into the lake; dense reeds to the west.', light: 'pale dawn from the east' }

  it('describes what the turned camera sees, not the main view', () => {
    const system = placeViewSystem('left')
    expect(system).toContain('turned 90° to the left of the main view')
    expect(system).toContain('Things in the middle of the main view are now at the edge of this frame or out of sight')
    expect(placeViewSystem('reverse')).toContain('facing back toward where the main view')
  })

  it('asks the text model with the look, light and style (quickly), and answers offline in demo mode', async () => {
    let user = ''
    let effort = ''
    const call = (async (_c: unknown, _s: string, u: string, _schema: unknown, _shape: string, e: string) => {
      user = u
      effort = e
      return { result: { description: ' Reeds fill the frame; the pier enters at the right edge. ' }, via: 'openrouter', model: 'fake' }
    }) as unknown as typeof structuredCall
    const res = await writePlaceView({ ...lake, view: 'left', style: '35mm film' }, { openrouter: 'k' }, false, call)
    expect(res.description).toBe('Reeds fill the frame; the pier enters at the right edge.')
    expect(user).toContain('Its look and geography, from the main view: From the southern bank')
    expect(user).toContain('Light: pale dawn from the east')
    expect(effort).toBe('low')
    expect((await writePlaceView({ ...lake, view: 'right' }, {}, true)).description).toBe('Misty Lakeshore, turned 90° to the right of the main view.')
    await expect(writePlaceView({ ...lake, description: ' ', view: 'left' }, {}, true)).rejects.toThrow(/Describe the place/)
  })
})
