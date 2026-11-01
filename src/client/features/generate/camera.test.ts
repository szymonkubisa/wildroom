import { getModel } from '@shared/models/registry'
import { describe, expect, it } from 'vitest'
import { CAMERA_PRESETS, cameraFamily, cameraMatch, cameraOf, cameraPhrase, cameraSentence, withCamera } from './camera'

const model = (id: string) => {
  const m = getModel(id)
  if (!m) throw new Error(`no model ${id}`)
  return m
}

describe('camera phrasing per model family', () => {
  it('maps models to their prompt dialect', () => {
    expect(cameraFamily(model('local-ltx-2.5'))).toBe('ltx')
    expect(cameraFamily(model('runpod-ltx-2.5'))).toBe('ltx')
    expect(cameraFamily(model('fal-ltx-2.5-pro'))).toBe('ltx')
    expect(cameraFamily(model('fal-veo3.1'))).toBe('veo')
    expect(cameraFamily(model('fal-veo3.1-fast'))).toBe('veo')
    expect(cameraFamily(model('fal-gemini-omni-flash'))).toBe('veo')
    expect(cameraFamily(model('kling-3.0'))).toBe('kling')
    expect(cameraFamily(model('fal-kling-3.0'))).toBe('kling')
    expect(cameraFamily(model('fal-seedance-2.5'))).toBe('seedance')
    expect(cameraFamily(model('fal-wan-3.0'))).toBeUndefined()
    expect(cameraFamily(model('fal-nano-banana-pro'))).toBeUndefined() // Google, but not video
    expect(cameraFamily(undefined)).toBeUndefined()
  })

  it('picks the family wording and falls back to the neutral phrase', () => {
    expect(cameraPhrase('push-in', model('local-ltx-2.5'))).toBe('slow dolly push-in toward the subject')
    expect(cameraPhrase('push-in', model('fal-veo3.1'))).toBe('the camera slowly dollies in toward the subject')
    expect(cameraPhrase('push-in', model('kling-2.6'))).toBe('camera slowly pushes in on the subject')
    expect(cameraPhrase('push-in', model('fal-wan-3.0'))).toBe(CAMERA_PRESETS.find((p) => p.id === 'push-in')!.phrase)
    expect(cameraPhrase('push-in')).toBe('slow dolly push-in towards the subject')
    expect(cameraPhrase('nope')).toBeUndefined()
  })

  it('keeps every phrase free of full stops (the camera sentence ends at the first one)', () => {
    for (const p of CAMERA_PRESETS) for (const s of [p.phrase, ...Object.values(p.phrases ?? {})]) expect(s).not.toContain('.')
  })
})

describe('camera sentence in the prompt', () => {
  it('labels plain phrases and lets "the camera …" phrases stand alone', () => {
    expect(cameraSentence('slow tilt up')).toBe('Camera: slow tilt up.')
    expect(cameraSentence('the camera slowly tilts up')).toBe('The camera slowly tilts up.')
  })

  it('adds, swaps and removes the camera sentence in any wording', () => {
    const veo = cameraPhrase('push-in', model('fal-veo3.1'))!
    const kling = cameraPhrase('orbit', model('kling-3.0'))!
    let p = withCamera('A fox in the snow', veo)
    expect(p).toBe('A fox in the snow. The camera slowly dollies in toward the subject.')
    expect(cameraOf(p)?.id).toBe('push-in')
    expect(cameraMatch(p)?.phrase).toBe(veo)
    p = withCamera(p, kling)
    expect(p).toBe('A fox in the snow. Camera orbits around the subject.')
    expect(cameraOf(p)?.id).toBe('orbit')
    p = withCamera(p, 'slow tilt up')
    expect(p).toBe('A fox in the snow. Camera: slow tilt up.')
    expect(cameraOf(p)?.id).toBe('tilt-up')
    expect(withCamera(p, undefined)).toBe('A fox in the snow.')
  })

  it('still recognises the legacy "Camera: <phrase>." form', () => {
    const legacy = 'A fox. Camera: camera orbits around the subject in a smooth arc.'
    expect(cameraOf(legacy)?.id).toBe('orbit')
    expect(withCamera(legacy, undefined)).toBe('A fox.')
  })

  it('never strips a user sentence that merely starts like a preset', () => {
    const own = 'The camera pans slowly to the left across the valley. A fox runs.'
    expect(cameraOf(own)).toBeUndefined()
    expect(withCamera(own, undefined)).toBe(own)
    const mid = 'She waves while camera pans left. Night.'
    expect(withCamera(mid, undefined)).toBe(mid)
  })
})
