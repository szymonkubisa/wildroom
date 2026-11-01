import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedList } from '../../src/server/services/cachedList'

describe('cachedList', () => {
  afterEach(() => vi.useRealTimers())

  it('loads once while fresh, keeps the last good list when a refresh fails', async () => {
    vi.useFakeTimers()
    const list = cachedList<number>(1000)
    const load = vi.fn(async () => [1, 2])
    expect(await Promise.all([list.get(load), list.get(load)])).toEqual([[1, 2], [1, 2]])
    expect(load).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1001)
    expect(await list.get(async () => Promise.reject(new Error('offline')))).toEqual([1, 2])
  })

  it('recovers from a loader that throws synchronously', async () => {
    const list = cachedList<number>(1000)
    await expect(
      list.get(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // The failed load must not stay in flight: the next call loads again.
    expect(await list.get(async () => [3])).toEqual([3])
  })
})
