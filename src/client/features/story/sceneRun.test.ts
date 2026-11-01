import type { StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { continuesBlocker, continuing, planSceneRun, sceneUnits } from './sceneRun'

const shot = (id: string, sceneId: string, extra: Partial<StoryShot> = {}): StoryShot => ({
  id,
  sceneId,
  description: '',
  prompt: '',
  duration: 3,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...extra,
})
const story = (shots: StoryShot[], multishots: StoryDoc['multishots'] = []): StoryDoc => ({
  script: '',
  style: '',
  characters: [],
  scenes: [
    { id: 'x', title: 'X' },
    { id: 'y', title: 'Y' },
  ],
  shots,
  multishots,
})

describe('a scene run', () => {
  const s = story(
    [
      shot('a', 'x', { continues: true }),
      shot('b', 'y', { continues: true }),
      shot('c', 'y'),
      shot('d', 'y'),
      shot('e', 'y', { continues: true }),
      shot('f', 'y', { continues: true }),
    ],
    [{ id: 'g', shotIds: ['c', 'd'], videoGenerationIds: [] }],
  )

  it('renders the scene’s shots and groups in order; a continuing shot waits, unless it can’t continue', () => {
    const units = sceneUnits(s, 'y')
    expect(units.map((u) => [u.id, u.continues])).toEqual([
      ['b', false],
      ['g', false],
      ['e', true],
      ['f', true],
    ])
    expect(continuesBlocker(s, s.shots[0]!)).toMatch(/first shot/)
    expect(continuesBlocker(s, s.shots[1]!)).toMatch(/another scene/)
    expect(continuesBlocker(s, s.shots[3]!)).toMatch(/multi-shot/)
    // What the cards, the batches and the stills go by: the flag, where the shot can continue.
    expect(s.shots.map((x) => continuing(s, x))).toEqual([false, false, false, false, true, true])
  })

  it('a group rendered shot by shot is its shots, each a render', () => {
    const units = sceneUnits(s, 'y', (g) => g.id === 'g')
    expect(units.map((u) => u.id)).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect(units.find((u) => u.id === 'd')!.continues).toBe(false)
  })

  it('a group rendered shot by shot whose one clip is already chosen stays one unit, covered by it — never rendered again', () => {
    // LTX projects from before shots rendered separately: their group takes still stand for those shots.
    const units = sceneUnits(s, 'y', (g) => g.id === 'g', (g) => g.id === 'g')
    expect(units.map((u) => [u.id, Boolean(u.covered)])).toEqual([
      ['b', false],
      ['g', true],
      ['e', false],
      ['f', false],
    ])
    expect(planSceneRun(units, () => false).now.map((u) => u.id)).toEqual(['b'])
    // A one-clip group isn't "covered": it renders as itself.
    expect(sceneUnits(s, 'y', () => false, () => true).find((u) => u.id === 'g')!.covered).toBeUndefined()
  })

  it('skips what already has a take (pressing it again picks up what is left)', () => {
    const units = sceneUnits(s, 'y')
    const run = planSceneRun(units, (u) => u.id === 'g' || u.id === 'e')
    expect(run.now.map((u) => u.id)).toEqual(['b'])
    expect(run.waiting.map((u) => u.id)).toEqual(['f'])
  })
})
