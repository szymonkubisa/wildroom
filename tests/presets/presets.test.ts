import { describe, expect, it } from 'vitest'
import { minimalInput } from '../providers/helpers'
import { parseParams } from '../../src/shared/models/params'
import { getModel } from '../../src/shared/models/registry'
import type { ModelSpec } from '../../src/shared/models/types'
import { PRESETS } from '../../src/shared/presets/catalog'
import { presetOptions, presetParams, resolvePreset } from '../../src/shared/presets/resolve'
import type { GenPreset } from '../../src/shared/presets/types'

const all = () => true

describe('preset catalog', () => {
  it('has unique ids and at least one candidate each', () => {
    const ids = PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PRESETS) expect(p.candidates.length, p.id).toBeGreaterThan(0)
  })

  it('only names models that exist, match the kind and take the inputs the job needs', () => {
    for (const preset of PRESETS) {
      for (const c of preset.candidates) {
        const model = getModel(c.modelId)
        expect(model, `${preset.id} → ${c.modelId}`).toBeDefined()
        expect(model?.kind, `${preset.id} → ${c.modelId}`).toBe(preset.kind)
        for (const key of preset.needs ?? []) {
          expect(model?.params.some((p) => p.key === key), `${preset.id} → ${c.modelId} lacks ${key}`).toBe(true)
        }
        expect(c.why.length, `${preset.id} → ${c.modelId}`).toBeGreaterThan(5)
      }
    }
  })

  it('produces valid settings for every candidate', () => {
    for (const preset of PRESETS) {
      for (const option of presetOptions(preset, all)) {
        const { model } = option
        const values = { ...presetParams(preset, option), ...minimalInput(model) }
        for (const key of preset.needs ?? []) values[key] ??= key === 'referenceImages' ? ['asset-ref'] : `asset-${key}`
        const parsed = parseParams(model, values)
        expect(parsed.ok, `${preset.id} → ${model.id}: ${parsed.ok ? '' : parsed.message}`).toBe(true)
      }
    }
  })

  it('applies the settings each preset asks for when the model offers them', () => {
    for (const preset of PRESETS) {
      for (const option of presetOptions(preset, all)) {
        const params = presetParams(preset, option)
        for (const [key, value] of Object.entries(option.candidate.params ?? {})) {
          expect(params[key], `${preset.id} → ${option.model.id}.${key}`).toEqual(value)
        }
      }
    }
  })
})

describe('resolvePreset', () => {
  const preset: GenPreset = {
    id: 'test',
    kind: 'video',
    group: 'Film',
    label: 'Test',
    blurb: 'Test preset',
    params: { aspectRatio: '9:16', audio: false },
    candidates: [
      { modelId: 'fal-veo3.1', why: 'first choice', params: { resolution: '4k' } },
      { modelId: 'kling-3.0', why: 'second choice' },
      { modelId: 'local-ltx-2.5', why: 'third choice' },
      { modelId: 'no-such-model', why: 'missing' },
    ],
  }
  const readyOnly = (...providers: string[]) => (m: ModelSpec) => providers.includes(m.provider)

  it('picks the first ready candidate and fits its settings', () => {
    const r = resolvePreset(preset, all)
    expect(r?.model.id).toBe('fal-veo3.1')
    expect(r?.params).toMatchObject({ aspectRatio: '9:16', audio: false, resolution: '4k' })
    expect(r?.alternatives.map((a) => a.model.id)).toEqual(['kling-3.0', 'local-ltx-2.5'])
  })

  it('falls back past providers that are not connected', () => {
    expect(resolvePreset(preset, readyOnly('kling'))?.model.id).toBe('kling-3.0')
    expect(resolvePreset(preset, readyOnly('local'))?.model.id).toBe('local-ltx-2.5')
  })

  it('returns the top candidate, not ready, when nothing is connected', () => {
    const r = resolvePreset(preset, () => false)
    expect(r?.model.id).toBe('fal-veo3.1')
    expect(r?.ready).toBe(false)
  })

  it('sets only the keys the preset names, leaving the model’s other settings alone', () => {
    const r = resolvePreset(preset, all)!
    expect(Object.keys(r.params).sort()).toEqual(['aspectRatio', 'audio', 'resolution'])
    // A value the model doesn't offer is dropped rather than replaced by the model's default.
    const odd = presetParams({ ...preset, params: { aspectRatio: '5:4' } }, r)
    expect(odd).toEqual({ resolution: '4k' })
  })

  it('keeps a preferred model the user switched to', () => {
    expect(resolvePreset(preset, all, 'kling-3.0')?.model.id).toBe('kling-3.0')
    expect(resolvePreset(preset, all, 'fal-wan-3.0')?.model.id).toBe('fal-veo3.1')
  })

  it('drops candidates without an input the job needs', () => {
    const needsEnd: GenPreset = { ...preset, needs: ['firstFrame', 'lastFrame'], candidates: [{ modelId: 'fal-pixverse-v6', why: 'no end frame' }, ...preset.candidates] }
    expect(presetOptions(needsEnd, all).map((o) => o.model.id)).toEqual(['fal-veo3.1', 'kling-3.0', 'local-ltx-2.5'])
  })

  it('returns undefined when no candidate exists', () => {
    expect(resolvePreset({ ...preset, candidates: [{ modelId: 'nope', why: 'missing' }] }, all)).toBeUndefined()
  })

  it('swaps a model whose provider is not connected for its twin from one that is', () => {
    const image: GenPreset = {
      id: 'twin',
      kind: 'image',
      group: 'Design & text',
      label: 'Twin',
      blurb: 'Twin fallback',
      params: { aspectRatio: '3:4' },
      candidates: [
        { modelId: 'fal-gpt-image-2.5', why: 'first choice', params: { tier: 'sunburst', resolution: '4K' } },
        { modelId: 'fal-nano-banana-pro', why: 'second choice' },
      ],
    }
    const viaOpenRouter = resolvePreset(image, readyOnly('openrouter'))!
    expect(viaOpenRouter.model.id).toBe('or-gpt-image-2.5')
    expect(viaOpenRouter.ready).toBe(true)
    // Settings the twin has carry over; the ones it lacks (no resolution tiers on OpenRouter's GPT Image) drop.
    expect(viaOpenRouter.params).toEqual({ aspectRatio: '3:4', tier: 'sunburst' })
    expect(viaOpenRouter.alternatives.map((a) => a.model.id)).toEqual(['or-nano-banana-pro'])
    expect(resolvePreset(image, readyOnly('fal', 'openrouter'))?.model.id).toBe('fal-gpt-image-2.5')
    expect(resolvePreset(image, () => false)?.model.id).toBe('fal-gpt-image-2.5')
  })
})
