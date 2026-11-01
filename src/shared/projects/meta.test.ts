import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../types/project-doc'
import { emptyStory } from '../types/story'
import { TAGS_MAX, normalizeTag, normalizeTags, projectKindOf, projectStatus } from './meta'

describe('project tags', () => {
  it('keeps one clean spelling of a tag', () => {
    expect(normalizeTag('  #Client  Work ')).toBe('client work')
    expect(normalizeTag('##showreel')).toBe('showreel')
    expect(normalizeTag('   ')).toBe('')
    expect(normalizeTag(42)).toBe('')
    expect(normalizeTag('a'.repeat(40))).toHaveLength(24)
  })

  it('drops repeats and empties, keeps the order, and caps the list', () => {
    expect(normalizeTags(['Client', '#client', '', 'Ads', ' ads '])).toEqual(['client', 'ads'])
    expect(normalizeTags('client')).toEqual([])
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(TAGS_MAX)
  })
})

describe('project kind', () => {
  it('uses the kind the project was made as', () => {
    expect(projectKindOf({ kind: 'ad', doc: createEmptyDoc() })).toBe('ad')
  })

  it('works out older projects: a story is a film, a board alone is social, the rest is an edit', () => {
    const film = { ...createEmptyDoc(), story: { ...emptyStory(), script: 'EXT. LAKE — DAWN' } }
    expect(projectKindOf({ doc: film })).toBe('film')
    const board = { ...createEmptyDoc(), canvas: { boards: [{ id: 'b', name: 'Board', items: [{ id: 'i' }] }] } }
    expect(projectKindOf({ doc: board as never })).toBe('social')
    expect(projectKindOf({ doc: createEmptyDoc() })).toBe('edit')
    expect(projectKindOf({ kind: 'nonsense', doc: { ...createEmptyDoc(), story: emptyStory() } })).toBe('edit')
  })
})

describe('project status', () => {
  it('says where the work is in a few words', () => {
    expect(projectStatus(createEmptyDoc())).toBe('Empty')
    expect(projectStatus({ ...createEmptyDoc(), story: { ...emptyStory(), script: 'An idea' } })).toBe('Script')
    const shots = [
      { id: 'a', videoGenerationIds: ['g'] },
      { id: 'b', videoGenerationIds: [] },
    ]
    const story = { ...emptyStory(), scenes: [{ id: 's' }], shots } as never
    expect(projectStatus({ ...createEmptyDoc(), story })).toBe('1 scene · 2 shots · 1 animated')
  })
})
