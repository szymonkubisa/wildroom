import { describe, expect, it } from 'vitest'
import { COVERAGE_ANGLES, DEFAULT_COVERAGE, coverageAngle, coveragePrompt } from './coverage'

describe('coverage', () => {
  it('keeps the moment and moves only the camera', () => {
    const p = coveragePrompt(coverageAngle('close')!, 'Daniel watches the smoke. ')
    expect(p).toMatch(/^The same moment as in the reference picture, seen from another camera: a close-up/)
    expect(p).toContain('only the camera has moved')
    expect(p).toMatch(/What happens: Daniel watches the smoke\.$/)
  })

  it('says nothing about what happens without a description', () => {
    expect(coveragePrompt(coverageAngle('wide')!)).not.toContain('What happens')
  })

  it('starts with angles that exist, and ids are unique', () => {
    expect(DEFAULT_COVERAGE.every((id) => coverageAngle(id))).toBe(true)
    expect(new Set(COVERAGE_ANGLES.map((a) => a.id)).size).toBe(COVERAGE_ANGLES.length)
  })
})
