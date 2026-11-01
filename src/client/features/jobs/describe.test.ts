import { describe, expect, it } from 'vitest'
import { describeParams, promptText, renderMs } from './describe'

describe('describeParams', () => {
  it('uses the model labels, option names and units, and keeps assets as ids', () => {
    const rows = describeParams({
      modelId: 'local-ltx-2.5',
      params: { prompt: 'A woman by a window', firstFrame: 'asset-1', duration: 4, quality: 'fullhd', mode: 'quality', audio: false, seed: 42 },
    })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey.prompt).toBeUndefined()
    expect(byKey.firstFrame).toMatchObject({ label: 'Start frame', assetIds: ['asset-1'] })
    expect(byKey.duration).toMatchObject({ label: 'Duration', value: '4 s' })
    expect(byKey.quality).toMatchObject({ label: 'Resolution', value: 'Full HD' })
    expect(byKey.mode).toMatchObject({ label: 'Mode', value: 'Quality' })
    expect(byKey.audio?.value).toBe('Off')
    expect(byKey.seed?.value).toBe('42')
    // Model order: the start frame comes before the duration.
    expect(rows.findIndex((r) => r.key === 'firstFrame')).toBeLessThan(rows.findIndex((r) => r.key === 'duration'))
  })

  it('still shows settings of unknown models or removed params, as sent', () => {
    expect(describeParams({ modelId: 'gone-model', params: { prompt: 'x', strength: 0.4, tags: ['a', 'b'] } })).toEqual([
      { key: 'strength', label: 'strength', value: '0.4' },
      { key: 'tags', label: 'tags', value: '["a","b"]' },
    ])
  })
})

describe('promptText / renderMs', () => {
  it('reads prompts, scripts and dialogue lines', () => {
    expect(promptText({ prompt: 'p' })).toBe('p')
    expect(promptText({ text: 'script' })).toBe('script')
    expect(promptText({ lines: [{ text: 'Hi' }, { text: 'Hello' }] })).toBe('Hi\nHello')
    expect(promptText({})).toBe('')
  })

  it('measures start to finish', () => {
    expect(renderMs({ startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:06:30.000Z' })).toBe(390_000)
    expect(renderMs({ startedAt: '2026-10-01T10:00:00.000Z' })).toBeUndefined()
  })
})
