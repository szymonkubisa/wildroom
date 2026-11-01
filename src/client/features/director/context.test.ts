import { directorContextSchema } from '@shared/director/plan'
import type { StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { SCRIPT_EXCERPT_CHARS, directorContext } from './context'

const shot = (id: string, sceneId: string, extra: Partial<StoryShot> = {}): StoryShot => ({
  id,
  sceneId,
  description: `Shot ${id}`,
  prompt: `Action ${id}`,
  duration: 4,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...extra,
})

const story = (extra: Partial<StoryDoc> = {}): StoryDoc => ({
  title: 'Pierwsza ryba',
  script: 'EXT. LAKE — DAWN\nKuba casts.',
  style: '35mm film',
  characters: [
    { id: 'kuba', name: 'Kuba', description: 'boy, 9', refAssetId: 'pic', voiceId: 'v1' },
    { id: 'gramp', name: 'Henryk', description: 'old man' },
  ] as StoryDoc['characters'],
  places: [{ id: 'lake', name: 'Lake', description: 'misty lake', refAssetIds: ['l1'] }] as StoryDoc['places'],
  scenes: [
    { id: 'sc1', title: 'Misty lake', placeId: 'lake', time: 'dawn', light: 'soft grey dawn' },
    { id: 'sc2', title: 'The bite' },
  ],
  shots: [
    shot('a', 'sc1', { dialogue: [{ id: 'l1', characterId: 'kuba', text: 'Dziadku!' }, { id: 'l2', text: '  ' }] }),
    shot('b', 'sc1', { description: '', prompt: 'Henryk smiles.', stillStale: true }),
  ],
  outlinedFrom: 'EXT. LAKE — DAWN\nKuba casts.',
  budgetUsd: 15,
  ...extra,
})

const sources = (st: StoryDoc) => ({
  story: st,
  name: 'My film',
  kind: 'film' as const,
  brandOn: true,
  spentUsd: 2.345,
  models: { image: 'Demo Image', video: 'Demo Video' },
  shotName: (x: StoryShot) => (x.id === 'a' ? '1.1' : '1.2'),
  still: (x: StoryShot) => (x.stillStale ? ('redo' as const) : ('ready' as const)),
  take: () => 'none' as const,
  placeViews: (id: string) => (id === 'lake' ? ['main', 'reverse'] : []),
  storyCut: false,
})

describe('what the Director is told about the project', () => {
  it('sums up the scenes and shots with how far each is made, the cast and places with their pictures', () => {
    const ctx = directorContext(sources(story()))
    expect(directorContextSchema.safeParse(ctx).success).toBe(true)
    expect(ctx).toMatchObject({
      name: 'My film',
      kind: 'film',
      title: 'Pierwsza ryba',
      brandOn: true,
      budgetUsd: 15,
      spentUsd: 2.35,
      script: { length: 28, edited: false },
      cast: [
        { id: 'kuba', name: 'Kuba', picture: true, voice: true },
        { id: 'gramp', name: 'Henryk', picture: false, voice: false },
      ],
      places: [{ id: 'lake', name: 'Lake', picture: true, views: ['main', 'reverse'] }],
    })
    expect(ctx.scenes[0]).toEqual({
      id: 'sc1',
      n: 1,
      title: 'Misty lake',
      place: 'Lake',
      time: 'dawn',
      light: 'soft grey dawn',
      shots: [
        { id: 'a', n: '1.1', what: 'Shot a', seconds: 4, lines: 1, still: 'ready', take: 'none' },
        // No description: what it does stands in.
        { id: 'b', n: '1.2', what: 'Henryk smiles.', seconds: 4, lines: 0, still: 'redo', take: 'none' },
      ],
    })
    expect(ctx.scenes[1]).toEqual({ id: 'sc2', n: 2, title: 'The bite', shots: [] })
  })

  it('says when the script was edited since the scenes, and sends only its start', () => {
    const long = `${'A long script line. '.repeat(400)}`
    const ctx = directorContext(sources(story({ script: long })))
    expect(ctx.script).toMatchObject({ length: long.length, edited: true })
    expect(ctx.script.excerpt).toHaveLength(SCRIPT_EXCERPT_CHARS)
    expect(directorContextSchema.safeParse(ctx).success).toBe(true)
  })
})
