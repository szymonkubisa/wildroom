/**
 * A remote list kept for `ttlMs`: one load at a time, and the last good copy survives a failed refresh (only a first
 * load that fails throws). The loader is passed per call so tests can inject their fetch.
 */
export function cachedList<T>(ttlMs: number) {
  let cached: { at: number; items: T[] } | undefined
  let inflight: Promise<T[]> | undefined
  return {
    get(load: () => Promise<T[]>): Promise<T[]> {
      if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.items)
      // Started on a microtask, so even a loader that throws synchronously settles after `inflight` is set.
      inflight ??= Promise.resolve()
        .then(load)
        .then(
          (items) => {
            cached = { at: Date.now(), items }
            return items
          },
          (err: unknown) => {
            if (cached) return cached.items
            throw err
          },
        )
        .finally(() => {
          inflight = undefined
        })
      return inflight
    },
    /** For tests: forget the cached list. */
    reset() {
      cached = undefined
      inflight = undefined
    },
  }
}
