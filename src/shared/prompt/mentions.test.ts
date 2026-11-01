import { describe, expect, it } from 'vitest'
import { getModel } from '../models/registry'
import type { ModelSpec } from '../models/types'
import type { StoryCharacter, StoryPlace } from '../types/story'
import { compileMentions, completeMention, displayName, matchMentions, mentionHandle, mentionQuery, mentionables, mentionsIn, unmention } from './mentions'

const characters: StoryCharacter[] = [
  {
    id: 'kuba',
    name: 'KUBA',
    description: 'A boy of eight with a mop of red hair; yellow raincoat',
    refAssetId: 'kuba-front',
    refAssetIds: ['kuba-side'],
    kling: { elementId: 'el-kuba', syncedAt: '2026-10-01', sourceAssetIds: ['kuba-front', 'kuba-side'] },
  },
  { id: 'henryk', name: 'Dziadek Henryk', description: 'An old man with a grey beard; flannel shirt' },
]
const places: StoryPlace[] = [{ id: 'jetty', name: 'Jetty', description: 'A wooden jetty on a misty lake at dawn. Reeds on both sides.', refAssetIds: ['jetty-main'] }]
const all = mentionables({ characters, places }, () => true)
const kuba = all.find((m) => m.id === 'kuba')!
const henryk = all.find((m) => m.id === 'henryk')!
const jetty = all.find((m) => m.id === 'jetty')!
const model = (id: string) => getModel(id) as ModelSpec

describe('handles', () => {
  it('writes names in word case without spaces', () => {
    expect(displayName('KUBA')).toBe('Kuba')
    expect(displayName('PANI EWA')).toBe('Pani Ewa')
    expect(displayName('McKenzie')).toBe('McKenzie')
    expect(mentionHandle('Dziadek Henryk')).toBe('DziadekHenryk')
    expect(kuba).toMatchObject({ handle: 'Kuba', views: ['kuba-front', 'kuba-side'], klingElementId: 'el-kuba' })
    expect(henryk.views).toEqual([])
  })

  it('keeps only the pictures that are ready', () => {
    const ready = mentionables({ characters, places }, (id) => id !== 'kuba-front')
    expect(ready.find((m) => m.id === 'kuba')?.views).toEqual(['kuba-side'])
  })
})

describe('typing an @mention', () => {
  it('finds the @word at the caret', () => {
    expect(mentionQuery('a shot of @Ku', 13)).toEqual({ start: 10, query: 'Ku' })
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQuery('mail me at x@y', 14)).toBeUndefined()
    expect(mentionQuery('@Kuba walks', 11)).toBeUndefined()
  })

  it('completes it with the handle and a space', () => {
    expect(completeMention('a shot of @Ku', 13, 'Kuba')).toEqual({ text: 'a shot of @Kuba ', caret: 16 })
    expect(completeMention('@Ku on the jetty', 3, 'Kuba')).toEqual({ text: '@Kuba on the jetty', caret: 6 })
    expect(completeMention('with @Lo', 8, '')).toEqual({ text: 'with ', caret: 5 })
  })

  it('lists matches that start with the query first', () => {
    expect(matchMentions(all, 'h').map((m) => m.id)).toEqual(['henryk'])
    expect(matchMentions(all, 'e').map((m) => m.id)).toEqual(['henryk', 'jetty'])
    expect(matchMentions(all, '').length).toBe(3)
  })

  it('reads the mentions back from the text, in order, once each', () => {
    expect(mentionsIn('@Jetty at dawn, @kuba runs; @Kuba laughs', all).map((m) => m.id)).toEqual(['jetty', 'kuba'])
    expect(mentionsIn('@Kubarek', all)).toEqual([])
    expect(unmention('@Kuba runs to @Kuba', kuba)).toBe('Kuba runs to Kuba')
  })
})

describe('compiling for a model', () => {
  it('gives an image model the pictures as references, with a legend', () => {
    const out = compileMentions({ model: model('mock-image'), values: {}, prompt: '@Kuba fishing on @Jetty', mentioned: [kuba, jetty], characters, places })
    expect(out.params.referenceImages).toEqual(['kuba-front', 'jetty-main'])
    expect(out.prompt).toMatch(/^Kuba fishing on Jetty\. Reference images: image 1 is Kuba; image 2 is the location “Jetty”\./)
    expect(out.notes.map((n) => n.as)).toEqual(['picture', 'picture'])
  })

  it('numbers attached pictures before the mentioned ones', () => {
    const out = compileMentions({
      model: model('mock-image'),
      values: { referenceImages: ['board-1'] },
      prompt: '@Kuba in this style',
      mentioned: [kuba],
      characters,
      places,
      labelOf: () => 'the picture “Mood”',
    })
    expect(out.params.referenceImages).toEqual(['board-1', 'kuba-front'])
    expect(out.prompt).toContain('image 1 is the picture “Mood”; image 2 is Kuba')
  })

  it('describes in words whoever has no picture', () => {
    const out = compileMentions({ model: model('mock-image'), values: {}, prompt: '@DziadekHenryk smiles', mentioned: [henryk], characters, places })
    expect(out.params).toEqual({})
    expect(out.prompt).toBe('Dziadek Henryk smiles. Dziadek Henryk: An old man with a grey beard.')
    expect(out.notes[0]).toMatchObject({ as: 'words', token: 'Dziadek Henryk' })
  })

  it('names LTX references Image n, introduces them, and puts the place behind them', () => {
    const out = compileMentions({ model: model('runpod-ltx-2.5'), values: {}, prompt: '@Kuba runs along @Jetty', mentioned: [kuba, jetty], characters, places })
    expect(out.params).toEqual({ referenceImages: ['kuba-front'], referenceBackground: 'jetty-main' })
    expect(out.prompt).toBe('Image 1: Kuba: A boy of eight with a mop of red hair; yellow raincoat. Image 1 runs along Image 2')
  })

  it('keeps LTX references out beside a start frame (words instead)', () => {
    const out = compileMentions({ model: model('runpod-ltx-2.5'), values: { firstFrame: 'still' }, prompt: '@Kuba runs', mentioned: [kuba], characters, places })
    expect(out.params).toEqual({})
    expect(out.prompt).toBe('Kuba runs. Kuba: A boy of eight with a mop of red hair.')
  })

  it('names Veo ingredients by name', () => {
    const out = compileMentions({ model: model('fal-veo3.1'), values: {}, prompt: '@Kuba waves', mentioned: [kuba], characters, places })
    expect(out.params.referenceImages).toEqual(['kuba-front'])
    expect(out.prompt).toBe('Kuba waves')
  })

  it('gives Seedance the cast and then the place as numbered references, not beside a start frame', () => {
    const out = compileMentions({ model: model('fal-seedance-2.5'), values: {}, prompt: '@Kuba runs along @Jetty', mentioned: [kuba, jetty], characters, places })
    expect(out.params).toEqual({ referenceImages: ['kuba-front', 'jetty-main'] })
    expect(out.prompt).toMatch(/@Image1 runs along @Image2$/)
    const framed = compileMentions({ model: model('fal-seedance-2.5'), values: { firstFrame: 'still' }, prompt: '@Kuba runs', mentioned: [kuba], characters, places })
    expect(framed.params).toEqual({})
  })

  it('sends Kling elements only for characters synced to Kling', () => {
    const out = compileMentions({
      model: model('kling-3.0'),
      values: { firstFrame: 'still' },
      prompt: '@Kuba and @DziadekHenryk on the jetty',
      mentioned: [kuba, henryk],
      characters,
      places,
    })
    expect(out.params).toEqual({ elements: ['el-kuba'] })
    expect(out.prompt).toBe('@element_1 and Dziadek Henryk on the jetty. Dziadek Henryk: An old man with a grey beard.')
  })

  it('leaves Kling 3.0 elements out without a start frame (it takes them only with one)', () => {
    const out = compileMentions({ model: model('kling-3.0'), values: {}, prompt: '@Kuba waves', mentioned: [kuba], characters, places })
    expect(out.params).toEqual({})
    expect(out.notes[0]?.as).toBe('words')
  })

  it('makes fal Kling elements from a front view and another angle', () => {
    const out = compileMentions({ model: model('fal-kling-o3'), values: {}, prompt: '@Kuba on @Jetty', mentioned: [kuba, jetty], characters, places })
    expect(out.params).toMatchObject({ elementImages: ['kuba-front', 'kuba-side'], elementCounts: [2], referenceImages: ['jetty-main'] })
    expect(out.prompt).toBe('@Element1 on @Image1')
  })

  it('writes plain names for a model without a cast slot', () => {
    const out = compileMentions({ model: model('mock-video'), values: {}, prompt: '@Kuba on @Jetty', mentioned: [kuba, jetty], characters, places })
    expect(out.params).toEqual({})
    expect(out.prompt).toBe('Kuba on Jetty. Kuba: A boy of eight with a mop of red hair. Jetty: A wooden jetty on a misty lake at dawn.')
  })

  it('changes nothing without mentions', () => {
    expect(compileMentions({ model: model('mock-image'), values: { referenceImages: ['x'] }, prompt: 'a lake', mentioned: [], characters, places })).toEqual({ prompt: 'a lake', params: {}, notes: [] })
  })
})
