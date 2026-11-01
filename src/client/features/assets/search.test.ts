import type { AssetDTO } from '@shared/types/assets'
import { describe, expect, it } from 'vitest'
import { matchHint, scoreAsset, scoreName, tokenize } from './search'

function asset(p: Partial<AssetDTO>): AssetDTO {
  return {
    id: 'a',
    kind: 'video',
    name: 'Clip',
    status: 'ready',
    source: 'generation',
    hasVideo: true,
    hasAudio: false,
    variants: {},
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: [],
    createdAt: '',
    ...p,
  }
}

describe('asset search', () => {
  it('ignores stop words, plurals and accents', () => {
    expect(tokenize('The dogs on a Beach')).toEqual(['dog', 'beach'])
    expect(tokenize('Łódź')).toEqual(['lodz'])
  })

  it('needs every word to match somewhere and ranks the name above the transcript', () => {
    const byName = asset({ name: 'Beach sunset' })
    const bySpeech = asset({ name: 'Take 3', alignment: { words: [{ text: 'the', start: 0, end: 1 }, { text: 'beach', start: 1, end: 2 }, { text: 'sunset', start: 2, end: 3 }] } })
    const partial = asset({ name: 'Beach party' })
    const q = tokenize('beach sunset')
    expect(scoreAsset(byName, q)).toBeGreaterThan(scoreAsset(bySpeech, q))
    expect(scoreAsset(bySpeech, q)).toBeGreaterThan(0)
    expect(scoreAsset(partial, q)).toBe(0)
  })

  it('finds AI descriptions by word prefix and explains the match', () => {
    const a = asset({ description: 'A woman in a red raincoat walks through neon-lit streets at night.', aiTags: ['night', 'city'] })
    const q = tokenize('raincoat woman')
    expect(scoreAsset(a, q)).toBeGreaterThan(0)
    expect(scoreAsset(a, tokenize('rainc'))).toBeGreaterThan(0)
    expect(matchHint(a, q)).toContain('raincoat')
  })
})

describe('scoreName (timelines in Assets)', () => {
  it('matches every query word against the name, as word prefixes, ignoring case and accents', () => {
    expect(scoreName('Vertical cut — Instagram', tokenize('vert insta'))).toBeGreaterThan(0)
    expect(scoreName('Wersja główna', tokenize('glowna'))).toBeGreaterThan(0)
    expect(scoreName('Main', tokenize('main teaser'))).toBe(0)
    expect(scoreName('Main', [])).toBe(1)
  })
})
