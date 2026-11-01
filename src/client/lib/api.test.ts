import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiRequestError, SERVER_UNREACHABLE } from './api'

function reply(status: number, body: string, contentType = 'text/plain') {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

async function failure(call: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await call
  } catch (err) {
    if (err instanceof ApiRequestError) return err
    throw err
  }
  throw new Error('expected the call to fail')
}

describe('api requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('says the local server is not answering instead of the browser’s "Failed to fetch"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const err = await failure(api.health())
    expect(err.status).toBe(0)
    expect(err.message).toBe(SERVER_UNREACHABLE)
  })

  it('says the same for the dev proxy’s bare 502 while the API server is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(502, '')))
    const err = await failure(api.health())
    expect(err.status).toBe(502)
    expect(err.message).toBe(SERVER_UNREACHABLE)
  })

  it('keeps the server’s own message, also on a 502 it sent itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(502, JSON.stringify({ error: 'The provider is down' }), 'application/json')))
    expect((await failure(api.health())).message).toBe('The provider is down')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(500, '')))
    expect((await failure(api.health())).message).toBe('500 ')
  })

  it('lets an abort through as an abort', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    await expect(api.health()).rejects.toBe(abort)
  })
})
