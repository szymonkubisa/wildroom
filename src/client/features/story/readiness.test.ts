import type { StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { placeNote, placeReadiness, shotStatus } from './readiness'

const shot = (id: string, over: Partial<StoryShot> = {}): StoryShot => ({
  id,
  sceneId: 'sc',
  description: '',
  prompt: '',
  duration: 4,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  placeId: 'p',
  ...over,
})

function story(): StoryDoc {
  return {
    script: '',
    style: '',
    characters: [],
    scenes: [{ id: 'sc', title: 'Garage', placeId: 'p' }],
    places: [{ id: 'p', name: 'Garage', description: '' }],
    shots: [shot('a'), shot('b', { background: 'reverse' })],
  }
}

const all = () => true

describe('placeReadiness', () => {
  it('pictures drawn in the look designer, none approved: The Chase’s garage', () => {
    const s = story()
    s.places![0]!.designTakes = [{ generationId: 'g1' }, { generationId: 'g2' }, { generationId: 'g3', angle: 'reverse' }, { generationId: 'g4' }]
    const r = placeReadiness(s, 'sc', all)
    expect(r).toMatchObject({ state: 'unapproved', drawn: 4, views: [], missing: [], needed: [] })
    expect(placeNote(r)).toBe('4 pictures of Garage drawn, none approved — no photo of the place goes with the stills until one is (Cast & Places).')
    // Only the takes that came out count.
    expect(placeReadiness(s, 'sc', all, (gid) => gid !== 'g4').drawn).toBe(3)
    expect(placeReadiness(s, 'sc', all, () => false).state).toBe('none')
  })

  it('no photo, a removed photo, an approved one — and the views its shots need', () => {
    const s = story()
    expect(placeReadiness(s, 'sc', all).state).toBe('none')
    s.places![0]!.refAssetIds = ['main', 'left']
    s.places![0]!.refNotes = { left: 'the view to the left' }
    expect(placeReadiness(s, 'sc', (id) => id !== 'main').state).toBe('removed')
    const r = placeReadiness(s, 'sc', all)
    expect(r).toMatchObject({ state: 'ok', main: 'main', missing: ['reverse', 'right'], needed: ['reverse'] })
    expect(r.views).toEqual([{ view: 'reverse' }, { view: 'left', photo: 'left' }, { view: 'right' }])
    expect(placeNote(r)).toBeUndefined()
  })

  it('a scene without a place has nothing to make ready', () => {
    const s = story()
    delete s.scenes![0]!.placeId
    expect(placeReadiness(s, 'sc', all)).toMatchObject({ state: 'ok', views: [], needed: [] })
    expect(placeReadiness(s, 'gone', all).state).toBe('ok')
  })
})

describe('shotStatus', () => {
  const ended = (over: Partial<StoryShot> = {}) =>
    shot('a', { endFrame: 'The phone is in her raised hand.', endCheck: { startId: 'kf', endId: 'end', ssim: 0.96 }, ...over })

  it('marks the end frame by what becomes of it', () => {
    const s = story()
    expect(shotStatus(s, ended(), { startId: 'kf', endId: 'end' })).toMatchObject({ end: 'same', endText: expect.stringContaining('would freeze') })
    expect(shotStatus(s, ended({ endUse: 'image' }), { startId: 'kf', endId: 'end' })).toMatchObject({ end: 'image', endText: 'Sent as the clip’s last frame — your call' })
    // Made to its voice track: the picture never goes.
    expect(shotStatus(s, ended({ endUse: 'image' }), { startId: 'kf', endId: 'end', lipSync: true })).toMatchObject({ end: 'text', endText: expect.stringContaining('Lip-synced') })
    expect(shotStatus(s, shot('a'), {}).end).toBeUndefined()
  })

  it('counts what to look at: lines that don’t fit, a direction its place has no photo of', () => {
    const s = story()
    const status = shotStatus(s, shot('b', { background: 'reverse' }), { dialogue: { tight: true, spoken: 6.2, available: 4 }, group: 'separate' })
    expect(status.mode).toBe('separate')
    expect(status.warnings).toEqual(['≈6 s of dialogue in a 4 s shot', 'Garage has no photo of its reverse view: the still gets the main view behind them'])
    expect(shotStatus(s, shot('a'), { dialogue: { tight: false, spoken: 2, available: 4 } }).warnings).toEqual([])
  })
})
