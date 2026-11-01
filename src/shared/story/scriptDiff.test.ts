import { describe, expect, it } from 'vitest'
import type { StoryShot } from '../types/story'
import { actionLikeness, diffScript, mergeRewrittenShots, sameText } from './scriptDiff'

const ONE = 'EXT. JETTY — DAWN\nThick mist over the lake. HENRYK walks the jetty with two rods.\nKUBA: Grandpa, the fish are still asleep.'
const TWO = 'EXT. BOAT — MORNING\nThe boat drifts out as the mist lifts. Henryk ties a hook onto Kuba’s line.'
const THREE = 'EXT. LAKE — LATE MORNING\nThe float dips. Kuba pulls hard; a small perch flashes in the sun.\nHENRYK: Your first one.'
const script = (...parts: string[]) => parts.join('\n\n')
const scenes = [
  { id: 's1', title: 'Jetty', script: ONE },
  { id: 's2', title: 'Boat', script: TWO },
  { id: 's3', title: 'Lake', script: THREE },
]

describe('which scenes’ parts of the script changed', () => {
  it('none, when only spacing, case or quotes differ', () => {
    const d = diffScript(script(ONE, TWO.replace('Kuba’s', "Kuba's").replace('drifts out', 'drifts   out'), THREE), scenes)
    expect(d).toEqual({ changed: [], unchanged: ['s1', 's2', 's3'], notCompared: [], newHeadings: [] })
  })

  it('an edited line changes its scene only, with the scene’s part as it is now', () => {
    const two = TWO.replace('ties a hook', 'slowly ties a red hook')
    const d = diffScript(script(ONE, two, THREE), scenes)
    expect(d.changed).toEqual([{ sceneId: 's2', script: two }])
    expect(d.unchanged).toEqual(['s1', 's3'])
  })

  it('a line added at the end of a scene belongs to that scene', () => {
    const one = `${ONE}\nHENRYK: That’s why we’re early.`
    const d = diffScript(script(one, TWO, THREE), scenes)
    expect(d.changed).toEqual([{ sceneId: 's1', script: one }])
  })

  it('says when a new scene heading lands in a scene’s part', () => {
    const extra = 'INT. CAR — DAY\nThey drive home, the perch in a bucket.'
    const d = diffScript(script(ONE, TWO, THREE, extra), scenes)
    expect(d.changed.map((c) => c.sceneId)).toEqual(['s3'])
    expect(d.newHeadings).toEqual([{ sceneId: 's3', heading: 'INT. CAR — DAY' }])
  })

  it('can’t place the scenes once a scene’s opening is rewritten', () => {
    const d = diffScript(script(ONE, TWO.replace('EXT. BOAT — MORNING\nThe boat drifts', 'EXT. ROWING BOAT — MORNING\nA rowing boat glides'), THREE), scenes)
    expect(d.problem).toMatch(/Scene 2’s opening/)
    expect(d.changed).toEqual([])
  })

  it('a heading used twice still finds each scene in order', () => {
    const a = 'INT. KITCHEN — NIGHT\nOne warm bulb over the table.'
    const b = 'INT. KITCHEN — NIGHT\nLater: the bulb flickers out.'
    const list = [
      { id: 'a', title: 'Kitchen', script: a },
      { id: 'b', title: 'Kitchen later', script: b },
    ]
    const d = diffScript(script(a, b.replace('flickers out', 'goes out')), list)
    expect(d.changed).toEqual([{ sceneId: 'b', script: b.replace('flickers out', 'goes out') }])
    expect(d.unchanged).toEqual(['a'])
  })

  it('leaves scenes without a part out, and has nothing to compare without any', () => {
    expect(diffScript(script(ONE, TWO, THREE), [...scenes, { id: 'own', title: 'Mine' }]).notCompared).toEqual(['own'])
    expect(diffScript('Anything', [{ id: 'x', title: 'X' }]).problem).toBeDefined()
  })
})

const shot = (id: string, extra: Partial<StoryShot> = {}): StoryShot => ({
  id,
  description: '',
  prompt: '',
  duration: 4,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...extra,
})

describe('the rewritten shots take over the old ones', () => {
  const old = [
    shot('o1', { description: 'Thick mist over the lake; a narrow jetty runs into the fog.', prompt: 'Mist drifts slowly across the water.', keyframeAssetId: 'k1', videoGenerationIds: ['t1'], chosenAssetId: 'v1' }),
    shot('o2', {
      description: 'Henryk walks along the jetty with two rods and a tin bucket.',
      prompt: 'Henryk walks toward camera, the boards flexing.',
      characterIds: ['h'],
      keyframeAssetId: 'k2',
      dialogue: [{ id: 'l1', characterId: 'h', text: 'Come on.', generationId: 'g1' }],
    }),
    shot('o3', { description: 'Kuba yawns, hugging the tackle box.', prompt: 'Kuba yawns and keeps walking.', characterIds: ['k'], keyframeAssetId: 'k3', light: 'A torch from below' }),
  ]

  it('tells alike actions from different ones', () => {
    expect(actionLikeness(old[0]!, old[0]!)).toBe(1)
    expect(actionLikeness(old[0]!, old[2]!)).toBeLessThan(0.1)
    expect(sameText('A  “B”', 'a "b"')).toBe(true)
  })

  it('keeps the same action as it was (new lines and sound), and gives a rewritten shot the old still, marked stale', () => {
    const written = [
      shot('n1', { description: 'Thick mist over the lake; a narrow jetty runs into the fog.', prompt: 'Mist drifts slowly across the water, left to right.', sfx: 'A loon far away' }),
      shot('n2', {
        description: 'Henryk strides down the jetty carrying rods, a bucket swinging.',
        prompt: 'Henryk strides toward camera along the jetty.',
        characterIds: ['h'],
        dialogue: [
          { id: 'x1', characterId: 'h', text: 'Come on.' },
          { id: 'x2', characterId: 'h', text: 'The fish won’t wait.' },
        ],
      }),
      shot('n3', { description: 'A red float bobs on calm water.', prompt: 'The float twitches, then dips.' }),
    ]
    const m = mergeRewrittenShots(old, written)
    expect([m.kept, m.rewritten, m.added, m.dropped]).toEqual([1, 1, 1, 1])
    const [kept, rewritten, added] = m.shots
    expect(kept).toMatchObject({ id: 'o1', prompt: 'Mist drifts slowly across the water.', keyframeAssetId: 'k1', chosenAssetId: 'v1', sfx: 'A loon far away' })
    expect(kept).not.toHaveProperty('stillStale')
    expect(rewritten).toMatchObject({ id: 'o2', description: 'Henryk strides down the jetty carrying rods, a bucket swinging.', keyframeAssetId: 'k2', stillStale: true })
    // The line said the same keeps its voice; the new one has none yet.
    expect(rewritten!.dialogue.map((l) => [l.id, l.generationId])).toEqual([
      ['l1', 'g1'],
      ['x2', undefined],
    ])
    expect(added).toMatchObject({ id: 'n3' })
    expect(added).not.toHaveProperty('stillStale')
  })

  it('keeps the shots in order, never matching back to one before the last taken', () => {
    const written = [shot('n1', { description: old[2]!.description, prompt: old[2]!.prompt, characterIds: ['k'] }), shot('n2', { description: old[0]!.description, prompt: old[0]!.prompt })]
    const m = mergeRewrittenShots(old, written)
    expect(m.shots.map((x) => x.id)).toEqual(['o3', 'n2'])
    expect(m.shots[0]!.light).toBe('A torch from below')
    expect([m.kept, m.added, m.dropped]).toEqual([1, 1, 2])
  })
})
