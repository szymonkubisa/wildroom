import { describe, expect, it } from 'vitest'
import { enhanceContent } from '../../src/server/services/director'

describe('enhanceContent', () => {
  const input = { prompt: 'look across the street', kind: 'image' as const, model: 'Seedream 5 Pro' }

  it('is plain text without pictures', () => {
    expect(enhanceContent(input, [])).toBe('Target: Seedream 5 Pro, an image model.\nPrompt: look across the street')
  })

  it('labels each picture by its role and name before the prompt', () => {
    const content = enhanceContent(input, [{ ref: { assetId: 'a', role: 'reference', token: 'image 1' }, jpeg: Buffer.from('jpg') }])
    expect(Array.isArray(content)).toBe(true)
    const parts = content as Exclude<typeof content, string>
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'text'])
    expect(parts[0]).toEqual({ type: 'text', text: 'Picture 1 — a reference picture to follow; the prompt names it "image 1":' })
    expect(parts[2]).toMatchObject({ type: 'text', text: expect.stringContaining('Prompt: look across the street') })
  })
})
