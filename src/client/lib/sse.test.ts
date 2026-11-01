import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sources: FakeEventSource[] = []

class FakeEventSource {
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((msg: { data: string }) => void) | null = null
  closed = false
  constructor() {
    sources.push(this)
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
}

describe('server events', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    sources.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens a new stream when the browser gives up on one, and asks the stores to refetch', async () => {
    const { onServerEvent, onServerReconnect } = await import('./sse')
    const events: string[] = []
    let refetches = 0
    onServerEvent((e) => events.push(e.type))
    onServerReconnect(() => refetches++)
    const first = sources[0]!
    first.onopen!()

    // A dropped stream the browser retries itself: nothing to do.
    first.onerror!()
    expect(sources).toHaveLength(1)

    // A retry got an HTTP error (the dev proxy's 502 while the server restarts): the browser closed it for good.
    first.readyState = 2
    first.onerror!()
    expect(first.closed).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(sources).toHaveLength(2)

    const second = sources[1]!
    second.onopen!()
    expect(refetches).toBe(1)
    second.onmessage!({ data: JSON.stringify({ type: 'settings.changed' }) })
    expect(events).toEqual(['settings.changed'])
  })

  it('waits longer after each failed attempt, up to 10 s', async () => {
    const { onServerEvent } = await import('./sse')
    onServerEvent(() => {})
    const fail = () => {
      const s = sources.at(-1)!
      s.readyState = 2
      s.onerror!()
    }
    fail()
    vi.advanceTimersByTime(999)
    expect(sources).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(2)
    fail()
    vi.advanceTimersByTime(1999)
    expect(sources).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(3)
    for (let i = 0; i < 6; i++) {
      fail()
      vi.advanceTimersByTime(10_000)
    }
    expect(sources).toHaveLength(9)
  })

  it('says the server is down once the stream stays away for 4 s, and takes it back when it opens', async () => {
    const { onServerEvent, serverDown, SERVER_DOWN_AFTER_MS } = await import('./sse')
    onServerEvent(() => {})
    const first = sources[0]!
    first.onopen!()

    // A restart (the dev server reloading after an edit): back within a second, never shown.
    first.onerror!()
    vi.advanceTimersByTime(1000)
    first.onopen!()
    vi.advanceTimersByTime(SERVER_DOWN_AFTER_MS)
    expect(serverDown.value).toBe(false)

    // Stopped: the browser keeps retrying and failing.
    first.onerror!()
    vi.advanceTimersByTime(SERVER_DOWN_AFTER_MS - 1)
    first.onerror!()
    expect(serverDown.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(serverDown.value).toBe(true)

    first.onopen!()
    expect(serverDown.value).toBe(false)
  })
})
