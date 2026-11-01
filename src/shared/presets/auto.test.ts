import { describe, expect, it } from 'vitest'
import { getModel } from '../models/registry'
import type { ModelSpec } from '../models/types'
import { attachedJob, attachedOf, chooseAuto } from './auto'
import { PRESETS } from './catalog'

const readyOnly = (...providers: string[]) => (m: ModelSpec) => providers.includes(m.provider) && !m.demoOnly
const usual = (id: string) => () => getModel(id)

describe('what is attached', () => {
  it('reads the roles from the form', () => {
    expect(attachedOf({ firstFrame: 'a', lastFrame: '', referenceImages: ['x', 'y'], prompt: 'p' })).toEqual({ start: true, refs: 2 })
    expect(attachedOf({ video: 'clip' })).toEqual({ clip: true })
    expect(attachedOf({})).toEqual({})
  })

  it('maps it to a job', () => {
    expect(attachedJob('video', { start: true })?.presetId).toBe('animate-still')
    expect(attachedJob('video', { start: true, end: true })?.presetId).toBe('start-end')
    expect(attachedJob('video', { clip: true })?.presetId).toBe('extend-clip')
    expect(attachedJob('image', { refs: 2 })?.presetId).toBe('edit-image')
    expect(attachedJob('image', {})).toBeUndefined()
    expect(attachedJob('music', { start: true })).toBeUndefined()
  })
})

describe('Auto', () => {
  it('animates a start frame with the best connected model for it', () => {
    const pick = chooseAuto({ kind: 'video', attached: { start: true }, quality: 'final', isReady: readyOnly('fal'), fallback: usual('mock-video') })
    expect(pick?.model.id).toBe('fal-veo3.1')
    expect(pick?.preset?.id).toBe('animate-still')
    expect(pick?.reason).toMatch(/start frame/)
  })

  it('moves between a start and an end frame with a model that takes both', () => {
    const pick = chooseAuto({ kind: 'video', attached: { start: true, end: true }, quality: 'final', isReady: readyOnly('kling'), fallback: usual('mock-video') })
    expect(pick?.model.id).toBe('kling-3.0')
    expect(pick?.model.params.some((p) => p.key === 'lastFrame')).toBe(true)
  })

  it('extends a clip and edits with references', () => {
    expect(chooseAuto({ kind: 'video', attached: { clip: true }, quality: 'final', isReady: readyOnly('fal'), fallback: () => undefined })?.model.id).toBe('fal-veo3.1-extend')
    const edit = chooseAuto({ kind: 'image', attached: { refs: 1 }, quality: 'final', isReady: readyOnly('fal'), fallback: () => undefined })
    expect(edit?.preset?.id).toBe('edit-image')
    expect(edit?.model.id).toBe('fal-nano-banana-pro')
  })

  it('drafts with the cheap models that take what is attached', () => {
    const plain = chooseAuto({ kind: 'image', attached: {}, quality: 'draft', isReady: readyOnly('fal'), fallback: () => undefined })
    expect(plain?.preset?.id).toBe('image-draft')
    expect(plain?.model.id).toBe('fal-nano-banana-2')
    expect(plain?.params).toMatchObject({ resolution: '0.5K' })
    const animated = chooseAuto({ kind: 'video', attached: { start: true }, quality: 'draft', isReady: readyOnly('fal'), fallback: () => undefined })
    expect(animated?.preset?.id).toBe('video-draft')
    expect(animated?.model.params.some((p) => p.key === 'firstFrame')).toBe(true)
    expect(animated?.reason).toMatch(/^Draft · a start frame/)
  })

  it('falls back to the usual model when nothing attached decides, or nothing for the job is connected', () => {
    const plain = chooseAuto({ kind: 'video', attached: {}, quality: 'final', isReady: readyOnly('fal'), fallback: usual('fal-wan-3.0') })
    expect(plain).toMatchObject({ model: { id: 'fal-wan-3.0' }, params: {} })
    expect(plain?.preset).toBeUndefined()
    const none = chooseAuto({ kind: 'video', attached: { start: true }, quality: 'final', isReady: () => false, fallback: usual('local-ltx-2.5') })
    expect(none?.model.id).toBe('local-ltx-2.5')
    expect(none?.reason).toMatch(/no model for it is connected/)
  })

  it('offers the best model of the job when nothing at all is ready (the picker asks for its key)', () => {
    const pick = chooseAuto({ kind: 'video', attached: { start: true }, quality: 'final', isReady: () => false, fallback: () => undefined })
    expect(pick?.model.id).toBe('fal-veo3.1')
  })

  it('picks the free demo model in demo mode', () => {
    const isReady = (m: ModelSpec) => m.provider === 'mock' || m.provider === 'fal'
    expect(chooseAuto({ kind: 'video', attached: { start: true }, quality: 'final', isReady, demo: true, fallback: () => undefined })?.model.id).toBe('mock-video')
    // The demo video takes no end frame: a model that does is picked.
    expect(chooseAuto({ kind: 'video', attached: { start: true, end: true }, quality: 'final', isReady, demo: true, fallback: () => undefined })?.model.id).not.toBe('mock-video')
    expect(chooseAuto({ kind: 'music', attached: {}, quality: 'final', isReady, demo: true, fallback: () => undefined })?.model.id).toBe('mock-music')
  })

  it('names only presets that exist, with the inputs they need', () => {
    const needs = { 'start-end': ['firstFrame', 'lastFrame'], 'animate-still': ['firstFrame'], 'extend-clip': ['video'], 'edit-image': ['referenceImages'] }
    for (const [id, keys] of Object.entries(needs)) expect(PRESETS.find((p) => p.id === id)?.needs).toEqual(keys)
    for (const id of ['image-draft', 'video-draft']) expect(PRESETS.find((p) => p.id === id)?.group).toBe('Drafts')
  })
})
