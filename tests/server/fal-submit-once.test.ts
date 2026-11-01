import { ApiError, createFalClient } from '@fal-ai/client'
import { describe, expect, it } from 'vitest'
import { submitOnce } from '../../src/server/providers/fal'

const SUBMIT = 'https://queue.fal.run/fal-ai/flux/dev'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fetch that answers from a script, one entry per call, and counts the calls. */
function scripted(...answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    const next = answers[calls.length - 1]
    if (!next) throw new Error('unexpected call')
    return next()
  }) as typeof fetch
  return { calls, fetchImpl }
}

const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

function client(fetchImpl: typeof fetch) {
  return createFalClient({ credentials: 'fal-test-key', fetch: submitOnce(fetchImpl) })
}

describe('fal queue submit', () => {
  it('sends a submit once when the gateway answers 502: the client does not retry it into a second billed request', async () => {
    const f = scripted(
      () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      () => json({ request_id: 'second' }),
    )
    const err = await client(f.fetchImpl).queue.submit('fal-ai/flux/dev', { input: { prompt: 'x' } }).catch((e: unknown) => e)
    expect(f.calls).toEqual([{ url: SUBMIT, method: 'POST' }])
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ApiError)
    expect((err as Error).message).toMatch(/HTTP 502 while submitting.*may have queued it/)
  })

  it('sends a submit once when the connection drops, also halfway through the answer', async () => {
    const reset = scripted(() => Promise.reject(fetchFailed('ECONNRESET')), () => json({ request_id: 'second' }))
    await expect(client(reset.fetchImpl).queue.submit('fal-ai/flux/dev', { input: { prompt: 'x' } })).rejects.toThrow(/connection dropped while submitting \(ECONNRESET\)/)
    expect(reset.calls).toHaveLength(1)

    const cut = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"request_'))
        controller.error(fetchFailed('UND_ERR_SOCKET'))
      },
    })
    const halfway = scripted(() => new Response(cut, { status: 200, headers: { 'content-type': 'application/json' } }), () => json({ request_id: 'second' }))
    await expect(client(halfway.fetchImpl).queue.submit('fal-ai/flux/dev', { input: { prompt: 'x' } })).rejects.toThrow(/may have queued it/)
    expect(halfway.calls).toHaveLength(1)
  })

  it('still retries what never reached fal (connection refused) and rate limits, and passes the answer through', async () => {
    const refused = scripted(() => Promise.reject(fetchFailed('ECONNREFUSED')), () => json({ request_id: 'req-1' }))
    expect(await client(refused.fetchImpl).queue.submit('fal-ai/flux/dev', { input: { prompt: 'x' } })).toMatchObject({ request_id: 'req-1' })
    expect(refused.calls).toHaveLength(2)

    const limited = scripted(() => json({ detail: 'slow down' }, 429), () => json({ request_id: 'req-2' }))
    expect(await client(limited.fetchImpl).queue.submit('fal-ai/flux/dev', { input: { prompt: 'x' } })).toMatchObject({ request_id: 'req-2' })
    expect(limited.calls).toHaveLength(2)
  })

  it('leaves everything but queue submits alone', async () => {
    const gateway = () => new Response('Bad Gateway', { status: 502 })
    const f = scripted(gateway, gateway)
    const guarded = submitOnce(f.fetchImpl)
    // Status polls (GET) and other hosts get the raw answer: their retries cost nothing.
    expect((await guarded('https://queue.fal.run/fal-ai/flux/requests/r1/status', { method: 'GET' })).status).toBe(502)
    expect((await guarded('https://rest.alpha.fal.ai/storage/upload/initiate', { method: 'POST' })).status).toBe(502)
    expect(f.calls).toHaveLength(2)
  })
})
