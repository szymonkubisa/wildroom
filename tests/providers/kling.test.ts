import { createHmac } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { klingModels } from '../../src/shared/models/catalog/kling'
import type { ModelSpec } from '../../src/shared/models/types'
import { createKlingAdapter, klingJwt, klingLegacyToken, parseKlingTask } from '../../src/server/providers/kling'
import { ProviderError } from '../../src/server/providers/types'
import { installFetch, jsonResponse, makeCtx, makeFixtures } from './helpers'

const model = (id: string): ModelSpec => klingModels.find((m) => m.id === id)!
const fixtures = makeFixtures()
const CREDS = { apiKey: 'kling-test-key' }
const BASE = 'https://api-singapore.klingai.com'

afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => fixtures.cleanup())

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('klingJwt', () => {
  it('signs an HS256 token the way the legacy API expects', () => {
    const now = 1_790_000_000
    const token = klingJwt('ak-123', 'sk-secret', now)
    const [header, payload, signature] = token.split('.')
    expect(decode(header!)).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decode(payload!)).toEqual({ iss: 'ak-123', exp: now + 1800, nbf: now - 5 })
    const expected = createHmac('sha256', 'sk-secret').update(`${header}.${payload}`).digest('base64url')
    expect(signature).toBe(expected)
    // Wrong secret must not verify.
    expect(createHmac('sha256', 'other').update(`${header}.${payload}`).digest('base64url')).not.toBe(signature)
  })

  it('accepts millisecond timestamps and defaults to now', () => {
    expect(klingJwt('ak', 'sk', 1_790_000_000_000)).toBe(klingJwt('ak', 'sk', 1_790_000_000))
    const { exp, nbf } = decode(klingJwt('ak', 'sk').split('.')[1]!)
    const now = Math.floor(Date.now() / 1000)
    expect(Math.abs(exp - (now + 1800))).toBeLessThanOrEqual(2)
    expect(Math.abs(nbf - (now - 5))).toBeLessThanOrEqual(2)
  })

  it('caches the legacy token for ~25 minutes', () => {
    const t0 = 1_800_000_000_000
    const first = klingLegacyToken('ak-cache', 'sk', t0)
    expect(klingLegacyToken('ak-cache', 'sk', t0 + 24 * 60_000)).toBe(first)
    const renewed = klingLegacyToken('ak-cache', 'sk', t0 + 26 * 60_000)
    expect(renewed).not.toBe(first)
    expect(decode(renewed.split('.')[1]!).exp).toBe(Math.floor((t0 + 26 * 60_000) / 1000) + 1800)
  })
})

describe('Kling submit', () => {
  // Body shapes per https://kling.ai/document-api/api/video/3-0-omni/text-to-video (top-level `prompt`) and
  // …/image-to-video (`contents`, frames as `url` = URL or raw base64); Kling defaults `multi_shot` to true.
  it('sends text-to-video with the new request format', async () => {
    const { calls } = installFetch(() => jsonResponse({ code: 0, message: 'SUCCEED', data: { task_id: 'task-123', status: 'submitted' } }))
    const { ctx, records } = makeCtx(model('kling-3.0'), { prompt: 'A red kite over the dunes' }, { credentials: CREDS })
    const result = await createKlingAdapter().submit(ctx)

    expect(result).toEqual({ type: 'async', taskId: 'task-123', meta: { endpoint: '/text-to-video/kling-3.0', externalTaskId: 'gen-1' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/text-to-video/kling-3.0`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer kling-test-key', 'content-type': 'application/json' })
    expect(calls[0]!.body).toEqual({
      prompt: 'A red kite over the dunes',
      settings: { resolution: '720p', duration: 5, audio: 'native', aspect_ratio: '16:9', multi_shot: false },
      options: { external_task_id: 'gen-1' },
    })
    expect(records).toHaveLength(1)
  })

  it('sends Kling 3.0 image-to-video with first + last frame in order', async () => {
    const first = fixtures.image('first', 'FIRST-FRAME-BYTES')
    const last = fixtures.image('last', 'LAST-FRAME-BYTES')
    const { calls } = installFetch(() => jsonResponse({ data: { id: 'task-i2v' } }))
    const { ctx, records } = makeCtx(
      model('kling-3.0'),
      { prompt: 'She turns to camera', firstFrame: 'first', lastFrame: 'last', duration: 10, resolution: '4k', audio: false, multiShot: true, aspectRatio: '9:16' },
      { credentials: CREDS, inputs: { firstFrame: first, lastFrame: last }, generationId: 'gen-i2v' },
    )
    const result = await createKlingAdapter().submit(ctx)

    expect(result).toMatchObject({ type: 'async', taskId: 'task-i2v' })
    expect(calls[0]!.url).toBe(`${BASE}/image-to-video/kling-3.0`)
    expect(calls[0]!.body).toEqual({
      contents: [
        { type: 'prompt', text: 'She turns to camera' },
        { type: 'first_frame', url: Buffer.from('FIRST-FRAME-BYTES').toString('base64') },
        { type: 'last_frame', url: Buffer.from('LAST-FRAME-BYTES').toString('base64') },
      ],
      // No aspect ratio for image-to-video: the start frame decides.
      settings: { resolution: '4k', duration: 10, audio: 'off', multi_shot: true },
      options: { external_task_id: 'gen-i2v' },
    })
    // The recorded request never contains the raw image data.
    const recorded = JSON.stringify(records[0])
    expect(recorded).not.toContain(Buffer.from('FIRST-FRAME-BYTES').toString('base64'))
    expect(records[0]).toMatchObject({
      endpoint: 'POST /image-to-video/kling-3.0',
      body: {
        contents: [
          { type: 'prompt', text: 'She turns to camera' },
          { type: 'first_frame', url: '<base64 17 bytes>' },
          { type: 'last_frame', url: '<base64 16 bytes>' },
        ],
      },
    })
  })

  it('applies per-model audio rules', async () => {
    const { calls } = installFetch(() => jsonResponse({ task_id: 'x' }))
    const adapter = createKlingAdapter()
    await adapter.submit(makeCtx(model('kling-3.0-turbo'), { prompt: 'p' }, { credentials: CREDS }).ctx)
    await adapter.submit(makeCtx(model('kling-2.6'), { prompt: 'p', resolution: '720p', audio: true }, { credentials: CREDS }).ctx)
    await adapter.submit(makeCtx(model('kling-2.6'), { prompt: 'p', resolution: '1080p' }, { credentials: CREDS }).ctx)
    await adapter.submit(makeCtx(model('kling-2.5-turbo'), { prompt: 'p', duration: 10 }, { credentials: CREDS }).ctx)
    const settings = calls.map((c) => (c.body as { settings: Record<string, unknown> }).settings)
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/text-to-video/kling-3.0-turbo`,
      `${BASE}/text-to-video/kling-2.6`,
      `${BASE}/text-to-video/kling-2.6`,
      `${BASE}/text-to-video/kling-2.5-turbo`,
    ])
    expect(settings[0]).toEqual({ resolution: '720p', duration: 5, audio: 'native', aspect_ratio: '16:9' })
    expect(settings[1]).toEqual({ resolution: '720p', duration: 5, audio: 'off', aspect_ratio: '16:9' })
    expect(settings[2]).toEqual({ resolution: '1080p', duration: 5, audio: 'native', aspect_ratio: '16:9' })
    expect(settings[3]).toEqual({ resolution: '720p', duration: 10, aspect_ratio: '16:9' })
  })

  it('finds the task id in different envelopes', async () => {
    const bodies = [{ data: { task_id: 'a' } }, { data: { id: 'b' } }, { task_id: 'c' }, { data: { tasks: [{ task_id: 'd' }] } }, { data: [{ id: 'e' }] }]
    installFetch((_call, i) => jsonResponse(bodies[i]))
    const adapter = createKlingAdapter()
    const ids: (string | null)[] = []
    for (let i = 0; i < bodies.length; i++) {
      const result = await adapter.submit(makeCtx(model('kling-2.6'), { prompt: 'p' }, { credentials: CREDS }).ctx)
      ids.push(result.type === 'async' ? result.taskId : null)
    }
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('maps business error codes over HTTP status', async () => {
    const cases: [Response, string, boolean][] = [
      [jsonResponse({ code: 1102, message: 'Resource pack exhausted' }, 429), 'insufficient_credits', false],
      [jsonResponse({ code: 1301, message: 'Content security policy triggered' }, 400), 'moderation', false],
      [jsonResponse({ code: 1301, message: 'risk control' }, 200), 'moderation', false],
      [jsonResponse({ code: 1303, message: 'Parallel task limit reached' }, 429), 'rate_limited', true],
      [jsonResponse({ code: 1201, message: 'duration is invalid' }, 400), 'invalid_params', false],
      [jsonResponse({ code: 1002, message: 'Authorization is invalid' }, 401), 'auth', false],
      [jsonResponse({ message: 'Unauthorized' }, 401), 'auth', false],
      [jsonResponse({ code: 5000, message: 'Internal error' }, 500), 'provider', true],
      [jsonResponse({ message: 'Account balance is not enough' }, 400), 'insufficient_credits', false],
    ]
    const adapter = createKlingAdapter()
    for (const [response, code, retryable] of cases) {
      installFetch(() => response)
      const error = await adapter.submit(makeCtx(model('kling-3.0'), { prompt: 'p' }, { credentials: CREDS }).ctx).catch((e: unknown) => e)
      expect(error, code).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).jobError.code).toBe(code)
      expect((error as ProviderError).jobError.retryable).toBe(retryable)
    }
  })

  it('fails clearly when no API key is configured', async () => {
    const error = await createKlingAdapter()
      .submit(makeCtx(model('kling-3.0'), { prompt: 'p' }, { credentials: { accessKey: 'ak', secretKey: 'sk' } }).ctx)
      .catch((e: unknown) => e)
    expect((error as ProviderError).jobError.code).toBe('auth')
  })
})

describe('Kling poll', () => {
  const pollWith = async (body: unknown, status = 200) => {
    const { calls } = installFetch(() => jsonResponse(body, status))
    const { ctx } = makeCtx(model('kling-3.0'), { prompt: 'p' }, { credentials: CREDS, providerTaskId: 'task-123' })
    const result = await createKlingAdapter().poll!(ctx)
    return { result, calls }
  }

  it('queries the tasks endpoint', async () => {
    const { calls, result } = await pollWith({ code: 0, data: { tasks: [{ task_id: 'task-123', status: 'processing' }] } })
    expect(calls[0]!.url).toBe(`${BASE}/tasks?task_ids=task-123`)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.headers.authorization).toBe('Bearer kling-test-key')
    expect(result).toEqual({ type: 'running', progress: undefined })
  })

  it('treats submitted/queued as running and keeps polling unknown or missing tasks', async () => {
    expect((await pollWith({ data: { tasks: [{ task_id: 'task-123', status: 'submitted' }] } })).result.type).toBe('running')
    expect((await pollWith({ data: { tasks: [] } })).result.type).toBe('running')
    expect((await pollWith({ data: [{ task_id: 'task-123', status: 'processing', progress: 40 }] })).result).toEqual({
      type: 'running',
      progress: 0.4,
    })
  })

  it('returns the video URL when succeeded', async () => {
    const { result } = await pollWith({
      data: [
        { task_id: 'other', status: 'processing' },
        { task_id: 'task-123', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.kling/v.mp4', duration: 5.04 }] },
      ],
    })
    expect(result.type).toBe('done')
    if (result.type !== 'done') return
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]).toMatchObject({
      kind: 'url',
      url: 'https://cdn.kling/v.mp4',
      ext: 'mp4',
      meta: { klingTaskId: 'task-123', durationSeconds: 5.04 },
    })
  })

  it('understands the legacy task shape', async () => {
    const { result } = await pollWith({
      code: 0,
      data: { task_id: 'task-123', task_status: 'succeed', task_result: { videos: [{ id: 'v1', url: 'https://cdn.kling/legacy.mp4', duration: '10.0' }] } },
    })
    expect(result).toMatchObject({ type: 'done', outputs: [{ kind: 'url', url: 'https://cdn.kling/legacy.mp4', ext: 'mp4' }] })
  })

  it('maps failures, flagging moderation', async () => {
    const moderated = await pollWith({ data: { tasks: [{ task_id: 'task-123', status: 'failed', status_msg: 'Failure to pass the risk control system' }] } })
    expect(moderated.result).toMatchObject({ type: 'failed', error: { code: 'moderation', message: 'Kling: Failure to pass the risk control system' } })
    const failed = await pollWith({ data: { tasks: [{ task_id: 'task-123', status: 'failed', error: { message: 'Render node crashed' } }] } })
    expect(failed.result).toMatchObject({ type: 'failed', error: { code: 'provider', message: 'Kling: Render node crashed' } })
    const empty = parseKlingTask({ task_id: 't', status: 'succeeded', outputs: [] })
    expect(empty).toMatchObject({ type: 'failed', error: { code: 'provider', maybeCharged: true } })
  })

  it('keeps polling when a fresh task is not found yet', async () => {
    const envelope = await pollWith({ code: 1203, message: 'Task not found' }).catch((e: unknown) => e)
    expect((envelope as ProviderError).jobError).toMatchObject({ code: 'invalid_params', retryable: true })
    const missing = await pollWith({ message: 'Not Found' }, 404).catch((e: unknown) => e)
    expect((missing as ProviderError).jobError.retryable).toBe(true)
  })

  it('throws retryable errors for server trouble and final ones for auth', async () => {
    const serverError = await pollWith({ message: 'bad gateway' }, 502).catch((e: unknown) => e)
    expect((serverError as ProviderError).jobError).toMatchObject({ retryable: true })
    const authError = await pollWith({ code: 1004, message: 'Authorization expired' }, 401).catch((e: unknown) => e)
    expect((authError as ProviderError).jobError).toMatchObject({ code: 'auth', retryable: false })
  })
})

describe('Kling test()', () => {
  it('treats 401 as an invalid key and other answers as reachable', async () => {
    installFetch(() => jsonResponse({ code: 1002, message: 'Authorization is invalid' }, 401))
    expect(await createKlingAdapter().test({ apiKey: 'bad' })).toMatchObject({ ok: false, message: expect.stringContaining('API key rejected') })

    const { calls } = installFetch(() => jsonResponse({ code: 1203, message: 'task not found' }, 404))
    const ok = await createKlingAdapter().test({ apiKey: 'good' })
    expect(ok).toEqual({ ok: true, message: 'API key OK (new format)' })
    expect(calls[0]!.url).toBe(`${BASE}/tasks?task_ids=connection-test`)
    expect(calls[0]!.headers.authorization).toBe('Bearer good')
  })

  it('also checks legacy access/secret keys with a JWT', async () => {
    const { calls } = installFetch(() => jsonResponse({ code: 0, data: [] }))
    const result = await createKlingAdapter().test({ apiKey: 'good', accessKey: 'ak-test', secretKey: 'sk-test' })
    expect(result).toEqual({ ok: true, message: 'API key OK (new format) · access/secret key OK (legacy format)' })
    expect(calls[1]!.url).toBe(`${BASE}/v1/videos/text2video?pageNum=1&pageSize=1`)
    const token = calls[1]!.headers.authorization!.replace('Bearer ', '')
    expect(decode(token.split('.')[1]!).iss).toBe('ak-test')
  })

  it('reports an incomplete legacy key', async () => {
    installFetch(() => jsonResponse({ code: 0 }))
    const result = await createKlingAdapter().test({ apiKey: 'good', accessKey: 'ak-only' })
    expect(result.message).toContain('legacy key incomplete')
  })
})
