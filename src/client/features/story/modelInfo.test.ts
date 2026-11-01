import { getModel } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import { workflowFor } from '@shared/models/workflow'
import { describe, expect, it } from 'vitest'
import {
  capabilityChips,
  castUsage,
  formatPerSecond,
  languageCode,
  modelHint,
  modelSpeaking,
  perSecondUsd,
  shortModelLabel,
  sourceBlocker,
  sourceExplanation,
  sourceLabel,
  speaksLanguage,
  speechWarning,
  storyboardModels,
} from './modelInfo'

const model = (id: string): ModelSpec => {
  const m = getModel(id)
  if (!m) throw new Error(`no model ${id}`)
  return m
}
const wf = (id: string) => workflowFor(model(id))

describe('shortModelLabel', () => {
  it('names takes by family and version, not by where they run', () => {
    expect(shortModelLabel(model('runpod-ltx-2.5'))).toBe('LTX')
    expect(shortModelLabel(model('local-ltx-2.5'))).toBe('LTX')
    expect(shortModelLabel(model('kling-3.0'))).toBe('Kling 3.0')
    expect(shortModelLabel(model('fal-kling-3.0'))).toBe('Kling 3.0')
    expect(shortModelLabel(model('fal-veo3.1'))).toBe('Veo 3.1')
    expect(shortModelLabel(model('fal-veo3.1-fast'))).toBe('Veo 3.1 Fast')
    expect(shortModelLabel(model('fal-happy-horse-1.1'))).toBe('Happy Horse')
  })

  it('works from a recorded label when the model is no longer in the catalog', () => {
    expect(shortModelLabel({ id: 'gone-model', label: 'Gone 2.0 (fal)', provider: 'fal' })).toBe('Gone 2.0')
  })
})

describe('storyboardModels', () => {
  it('leaves out models that can start neither from a keyframe nor from the cast', () => {
    const ids = storyboardModels([model('fal-veo3.1'), model('fal-veo3.1-extend'), model('fal-custom'), model('runpod-ltx-2.5')]).map((m) => m.id)
    expect(ids).toEqual(['fal-veo3.1', 'runpod-ltx-2.5'])
  })
})

describe('identity sources', () => {
  it('labels each source with the model’s own name for its cast', () => {
    expect(sourceLabel('keyframe', wf('fal-veo3.1'))).toBe('First still')
    expect(sourceLabel('references', wf('runpod-ltx-2.5'))).toBe('References (Licon MSR)')
    expect(sourceLabel('references', wf('fal-veo3.1'))).toBe('Ingredients')
    expect(sourceLabel('references', wf('fal-happy-horse-1.1'))).toBe('Characters')
    expect(sourceLabel('references', wf('kling-3.0-omni'))).toBe('Kling elements')
    expect(sourceLabel('both', wf('kling-3.0'))).toBe('Still + Kling elements')
  })

  it('explains each (dialect, source) pair', () => {
    expect(sourceExplanation('keyframe', wf('runpod-ltx-2.5'), 3)).toContain('From shot 3’s still')
    expect(sourceExplanation('keyframe', wf('runpod-ltx-2.5'), 3)).toContain('LTX tends to add cuts of its own')
    expect(sourceExplanation('references', wf('runpod-ltx-2.5'), 3)).toContain('Licon MSR')
    expect(sourceExplanation('both', wf('fal-kling-3.0'), 1)).toBe(
      'The first still starts the clip; characters with extra angles go in as Kling elements and the cuts as Kling’s native shot list.',
    )
    expect(sourceExplanation('references', wf('fal-veo3.1'), 1)).toMatch(/^Up to 3 character pictures; Veo renders exactly 8 s and takes no start frame\./)
    expect(sourceExplanation('references', wf('fal-happy-horse-1.1'), 1)).toMatch(/^Up to 9 character pictures, named character1…; no start frame with references\./)
    expect(sourceExplanation('keyframe', wf('fal-happy-horse-1.1'), 2)).toContain('From shot 2’s still')
    expect(sourceExplanation('keyframe', wf('fal-veo3.1'), 1)).toContain('timestamps')
  })

  it('says what the story is missing for a source', () => {
    expect(sourceBlocker('keyframe', wf('runpod-ltx-2.5'), { first: 3, hasKeyframe: false })).toBe('needs shot 3’s still')
    expect(sourceBlocker('both', wf('fal-kling-3.0'), { first: 1, hasKeyframe: false })).toBe('needs shot 1’s still')
    expect(sourceBlocker('both', wf('fal-kling-3.0'), { first: 1, hasKeyframe: true })).toContain('another angle')
    expect(sourceBlocker('both', wf('kling-3.0'), { first: 1, hasKeyframe: true })).toContain('synced to Kling')
    expect(sourceBlocker('references', wf('runpod-ltx-2.5'), { first: 1, hasKeyframe: true })).toContain('picture of someone')
    expect(sourceBlocker('both', wf('runpod-ltx-2.5'), { first: 1, hasKeyframe: true })).toBe('this model doesn’t offer it')
  })
})

describe('capabilities', () => {
  it('chips shots per clip, the cast, the languages and the price per second', () => {
    const kling = capabilityChips(model('fal-kling-3.0'), { audio: true }).map((c) => c.text)
    expect(kling).toContain('Multi-shot ≤6')
    expect(kling).toContain('Elements 3')
    expect(kling).toContain('EN/ZH speech')
    expect(kling.some((t) => t.endsWith('/s'))).toBe(true)
    expect(capabilityChips(model('fal-veo3.1')).map((c) => c.text)).toContain('Ingredients 3')
    expect(capabilityChips(model('fal-happy-horse-1.1')).map((c) => c.text)).toContain('Refs 9')
    expect(capabilityChips(model('runpod-ltx-2.5')).map((c) => c.text)).toEqual(expect.arrayContaining(['Multi-shot ≤3', 'Refs 4']))
  })

  it('leaves out the languages when the model makes no sound with these settings', () => {
    expect(capabilityChips(model('fal-kling-3.0'), { audio: false }).map((c) => c.text)).not.toContain('EN/ZH speech')
  })

  it('prices a second from the estimate of a clip it renders', () => {
    expect(perSecondUsd(model('local-ltx-2.5'))).toBe(0)
    const veo = perSecondUsd(model('fal-veo3.1'))
    expect(veo).toBeGreaterThan(0)
    expect(formatPerSecond(0)).toBe('Free')
    expect(formatPerSecond(0.4)).toBe('$0.40/s')
    expect(formatPerSecond(0.08)).toBe('$0.08/s')
    expect(formatPerSecond(0.0037)).toBe('$0.004/s')
  })

  it('hints the limits in a Render with… menu', () => {
    expect(modelHint(wf('fal-kling-3.0'), { group: true })).toBe('≤6 shots · 15 s · Elements 3')
    expect(modelHint(wf('runpod-ltx-2.5'))).toBe('≤10 s · Refs 4')
    expect(modelHint(wf('local-ltx-2.5'))).toBe('≤8 s')
  })
})

describe('speech', () => {
  it('codes languages', () => {
    expect(languageCode('English')).toBe('EN')
    expect(languageCode('Chinese')).toBe('ZH')
    expect(languageCode('Klingon')).toBe('KL')
  })

  it('warns when the model doesn’t speak the story’s language', () => {
    expect(speaksLanguage(wf('kling-3.0'), 'Polish')).toBe(false)
    expect(speaksLanguage(wf('kling-3.0'), undefined)).toBe(true)
    expect(speaksLanguage(wf('runpod-ltx-2.5'), 'Polish')).toBe(true)
    expect(speechWarning(model('kling-3.0'), wf('kling-3.0'), 'Polish')).toBe('Kling 3.0 speaks English and Chinese — Polish lines will be translated.')
    expect(speechWarning(model('fal-veo3.1'), wf('fal-veo3.1'), 'Polish')).toBe('Veo 3.1 speaks English — Polish lines will be translated.')
    expect(speechWarning(model('kling-3.0'), wf('kling-3.0'), 'English')).toBeUndefined()
    expect(speechWarning(model('runpod-ltx-2.5'), wf('runpod-ltx-2.5'), 'Polish')).toBeUndefined()
  })

  it('finds a ready model that speaks the language, the story’s first', () => {
    const ltx = model('runpod-ltx-2.5')
    const kling = model('fal-kling-3.0')
    const horse = model('fal-happy-horse-1.1')
    expect(modelSpeaking('Polish', [kling, horse, ltx], { preferred: ltx, except: kling })?.id).toBe('runpod-ltx-2.5')
    expect(modelSpeaking('Polish', [kling, horse, ltx], { except: kling })?.id).toBe('fal-happy-horse-1.1')
    expect(modelSpeaking('Polish', [kling], { except: kling })).toBeUndefined()
  })
})

describe('castUsage', () => {
  it('says how the story’s model uses each character’s pictures', () => {
    expect(castUsage(undefined)).toBeUndefined()
    expect(castUsage(model('kling-3.0'))).toContain('Kling elements: front + 1–3 angles')
    expect(castUsage(model('fal-kling-3.0'))).toBe('Kling elements: front + 1–3 angles, up to 3 characters (characters without angles stay text).')
    expect(castUsage(model('fal-kling-o3'))).toContain('a front view alone goes in as a reference picture')
    expect(castUsage(model('fal-veo3.1'))).toMatch(/^Veo ingredients: up to 3 pictures/)
    expect(castUsage(model('fal-happy-horse-1.1'))).toBe('Happy Horse: up to 9 characters (front views), as character1…')
    expect(castUsage(model('runpod-ltx-2.5'))).toBe('LTX: front view as Image N, up to 4; the voice sample as Audio N.')
    expect(castUsage(model('local-ltx-2.5'))).toBe('LTX takes no character pictures — they shape the stills only.')
  })
})
