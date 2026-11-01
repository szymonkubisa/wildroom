import { describe, expect, it } from 'vitest'
import { batchTimes, budgetLevel, overBudgetBy } from './budget'

describe('budgetLevel', () => {
  it('is amber above 80 % and over past the budget', () => {
    expect(budgetLevel(2, undefined)).toBeUndefined()
    expect(budgetLevel(2, 0)).toBeUndefined()
    expect(budgetLevel(5, 10)).toEqual({ share: 0.5, level: 'ok' })
    expect(budgetLevel(8, 10)?.level).toBe('ok')
    expect(budgetLevel(8.5, 10)?.level).toBe('near')
    expect(budgetLevel(10.5, 10)?.level).toBe('over')
  })
})

describe('overBudgetBy', () => {
  it('is how far spent plus the estimate goes past the budget', () => {
    expect(overBudgetBy(8, 3, 10)).toBeCloseTo(1)
    expect(overBudgetBy(8, 2, 10)).toBeUndefined()
    expect(overBudgetBy(8, 3, undefined)).toBeUndefined()
    // An unknown price can't be judged.
    expect(overBudgetBy(8, null, 10)).toBeUndefined()
    // Already over: any paid batch is over.
    expect(overBudgetBy(12, 0.5, 10)).toBeCloseTo(2.5)
    expect(overBudgetBy(12, 0, 10)).toBeCloseTo(2)
  })
})

describe('batchTimes', () => {
  it('adds up this Mac and the GPU pod (one job at a time), takes the longest of the parallel cloud', () => {
    expect(
      batchTimes([
        { provider: 'local', seconds: 60 },
        { provider: 'local', seconds: 90 },
        { provider: 'fal', seconds: 120 },
        { provider: 'kling', seconds: 200 },
        { provider: 'fal' },
      ]),
    ).toEqual({ mac: 150, cloud: 200, unknown: 1 })
    expect(batchTimes([{ provider: 'runpod', seconds: 100 }, { provider: 'runpod', seconds: 100 }, { provider: 'fal', seconds: 150 }])).toEqual({
      mac: undefined,
      cloud: 200,
      unknown: 0,
    })
    expect(batchTimes([])).toEqual({ mac: undefined, cloud: undefined, unknown: 0 })
  })
})
