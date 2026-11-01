import { describe, expect, it } from 'vitest'
import { getModel } from '../models/registry'
import { brandPromptSuffix, emptyBrand, hasBrand, primaryColor, sanitizeBrand, withBrand, withStyleRefs } from './brand'

const kit = {
  ...emptyBrand(),
  name: 'Roastery',
  styleText: 'flat illustration, warm, lots of white space.',
  avoidText: 'gradients, stock photos',
  colors: [
    { hex: '#c2410c', name: 'Terracotta' },
    { hex: '#fef3c7', name: 'Cream', role: 'background' as const },
    { hex: '#1c1917', role: 'primary' as const },
  ],
}

describe('brand kit', () => {
  it('turns style, palette and avoid-list into a prompt suffix', () => {
    expect(brandPromptSuffix(kit)).toBe(
      'Style: flat illustration, warm, lots of white space. Brand colour palette: Terracotta #c2410c, Cream #fef3c7, #1c1917. Avoid: gradients, stock photos.',
    )
    expect(brandPromptSuffix(emptyBrand())).toBe('')
    expect(brandPromptSuffix(undefined)).toBe('')
  })

  it('appends the suffix once', () => {
    const once = withBrand('A coffee cup', kit)
    expect(once.startsWith('A coffee cup\n\nStyle:')).toBe(true)
    expect(withBrand(once, kit)).toBe(once)
    expect(withBrand('', kit)).toBe(brandPromptSuffix(kit))
    expect(withBrand('Cup', emptyBrand())).toBe('Cup')
  })

  it('knows the primary colour and whether anything is set', () => {
    expect(primaryColor(kit)).toBe('#1c1917')
    expect(primaryColor({ ...kit, colors: [{ hex: '#000000' }] })).toBe('#000000')
    expect(primaryColor(undefined)).toBeUndefined()
    expect(hasBrand(emptyBrand())).toBe(false)
    expect(hasBrand(kit)).toBe(true)
  })

  it('adds style references only where the model follows them', () => {
    const model = (id: string) => getModel(id)!
    // A slot for references to follow: after the user's own, within its limit.
    expect(withStyleRefs(model('fal-nano-banana-pro'), { referenceImages: ['mine'] }, ['s1', 's2']).referenceImages).toEqual(['mine', 's1', 's2'])
    expect((withStyleRefs(model('local-flux-2'), {}, ['a', 'b', 'c', 'd', 'e']).referenceImages as string[]).length).toBe(4)
    // The picture being restyled or edited is not a style reference.
    expect(withStyleRefs(model('or-recraft-v4.1'), {}, ['s1'])).toEqual({})
    // A run-time limit (the OpenRouter model picked in "Any model"): a text-only model takes none.
    expect(withStyleRefs(model('or-image-any'), {}, ['s1'], 0)).toEqual({})
    // A model that would reject them (Krea Turbo takes no style references) is left as it was.
    expect(withStyleRefs(model('fal-krea-2'), { tier: 'turbo' }, ['s1'])).toEqual({ tier: 'turbo' })
    // Video references are characters to keep, not a look.
    expect(withStyleRefs(model('fal-kling-o3'), {}, ['s1'])).toEqual({})
  })

  it('repairs a kit read from disk', () => {
    const out = sanitizeBrand({
      name: 'X',
      colors: [{ hex: '#ABCDEF', role: 'primary' }, { hex: 'red' }, { hex: '#123456', role: 'weird' }, null],
      fonts: [{ family: ' Inter ', role: 'heading' }, { family: '' }, { family: 'Lora', role: 'nope' }],
      logoAssetIds: ['a', 3],
    })!
    expect(out.colors).toEqual([{ hex: '#abcdef', role: 'primary' }, { hex: '#123456' }])
    expect(out.fonts).toEqual([{ family: 'Inter', role: 'heading' }, { family: 'Lora', role: 'body' }])
    expect(out.logoAssetIds).toEqual(['a'])
    expect(out.styleText).toBe('')
    expect(sanitizeBrand(null)).toBeUndefined()
  })
})
