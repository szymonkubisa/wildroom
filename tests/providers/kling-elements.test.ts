import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AppDeps, closeDeps, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { ApiError } from '../../src/server/http'
import {
  createKlingAdapter,
  createKlingElement,
  deleteKlingElement,
  klingElementsAuthorization,
  listKlingElements,
} from '../../src/server/providers/kling'
import { ProviderError } from '../../src/server/providers/types'
import { klingRoutes } from '../../src/server/routes/kling'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { klingModels } from '../../src/shared/models/catalog/kling'
import type { ModelSpec } from '../../src/shared/models/types'
import type { CreateKlingElementResponse } from '../../src/shared/types/kling'
import { installFetch, jsonResponse, makeCtx, makeFixtures } from './helpers'

const BASE = 'https://api-singapore.klingai.com'
const ELEMENTS = `${BASE}/v1/general/advanced-custom-elements`
const LEGACY = { accessKey: 'ak-elements', secretKey: 'sk-elements' }
const FAST = { pollIntervalMs: 1, timeoutMs: 2000 }
const fixtures = makeFixtures()
const model = (id: string): ModelSpec => klingModels.find((m) => m.id === id)!
const b64 = (text: string) => Buffer.from(text).toString('base64')
const jwtIssuer = (authorization: string | undefined) =>
  JSON.parse(Buffer.from(authorization!.replace('Bearer ', '').split('.')[1]!, 'base64url').toString('utf8')).iss as string

afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => fixtures.cleanup())

const created = (taskId = 'el-task-1') => jsonResponse({ code: 0, message: 'SUCCEED', data: { task_id: taskId, task_status: 'submitted' } })
const taskState = (status: string, extra: Record<string, unknown> = {}) =>
  jsonResponse({ code: 0, data: { task_id: 'el-task-1', task_status: status, ...extra } })
const finished = (elementId: unknown = 829) =>
  taskState('succeed', { task_result: { elements: [{ element_id: elementId, element_name: 'Mara', status: 'succeed' }] } })

function elementInput() {
  return {
    name: 'Mara',
    description: 'Red-haired lighthouse keeper, 40s, oilskin coat',
    frontal: fixtures.image('front', 'FRONT-PNG'),
    references: [fixtures.image('side', 'SIDE-PNG'), fixtures.image('back', 'BACK-PNG')],
  }
}

describe('createKlingElement', () => {
  it('creates an image element with the legacy JWT and polls until Kling finishes it', async () => {
    const { calls } = installFetch((_call, i) => (i === 0 ? created() : i === 1 ? taskState('processing') : finished(829)))
    const result = await createKlingElement(LEGACY, elementInput(), undefined, FAST)

    expect(result).toEqual({ elementId: '829', taskId: 'el-task-1' })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ url: ELEMENTS, method: 'POST' })
    expect(calls[0]!.headers['content-type']).toBe('application/json')
    expect(calls[0]!.body).toEqual({
      element_name: 'Mara',
      element_description: 'Red-haired lighthouse keeper, 40s, oilskin coat',
      reference_type: 'image_refer',
      element_image_list: { frontal_image: b64('FRONT-PNG'), refer_images: [{ image_url: b64('SIDE-PNG') }, { image_url: b64('BACK-PNG') }] },
      tag_list: [{ tag_id: 'o_102' }],
    })
    for (const call of calls) expect(jwtIssuer(call.headers.authorization)).toBe('ak-elements')
    expect(calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${ELEMENTS}/el-task-1`, `GET ${ELEMENTS}/el-task-1`])
  })

  it('trims names and descriptions to Kling’s limits and keeps at most 3 references', async () => {
    const { calls } = installFetch((_c, i) => (i === 0 ? created() : finished()))
    const refs = ['r1', 'r2', 'r3', 'r4'].map((id) => fixtures.image(id))
    await createKlingElement(
      LEGACY,
      { ...elementInput(), name: 'Captain Bartholomew Longfellow', description: 'word '.repeat(40), references: refs },
      undefined,
      FAST,
    )
    const body = calls[0]!.body as { element_name: string; element_description: string; element_image_list: { refer_images: unknown[] } }
    expect(body.element_name.length).toBeLessThanOrEqual(20)
    expect(body.element_name).toBe('Captain Bartholomew')
    expect(body.element_description.length).toBeLessThanOrEqual(100)
    expect(body.element_image_list.refer_images).toHaveLength(3)
  })

  it('falls back to the API key when no legacy keys are stored', async () => {
    const { calls } = installFetch((_c, i) => (i === 0 ? created() : finished('abc')))
    await expect(createKlingElement({ apiKey: 'kling-key' }, elementInput(), undefined, FAST)).resolves.toMatchObject({ elementId: 'abc' })
    expect(calls.every((c) => c.headers.authorization === 'Bearer kling-key')).toBe(true)
    expect(klingElementsAuthorization({ apiKey: 'k', ...LEGACY }).via).toBe('legacy')
  })

  it('explains missing keys and rejected API keys', async () => {
    const { calls } = installFetch(() => created())
    const missing = await createKlingElement({}, elementInput(), undefined, FAST).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(ProviderError)
    expect((missing as ProviderError).jobError.code).toBe('auth')
    expect((missing as ProviderError).message).toMatch(/Access Key \+ Secret Key.*Settings → Providers/)
    expect(calls).toHaveLength(0)

    installFetch(() => jsonResponse({ code: 1002, message: 'Authorization is invalid' }, 401))
    const rejected = await createKlingElement({ apiKey: 'nope' }, elementInput(), undefined, FAST).catch((e: unknown) => e)
    expect((rejected as ProviderError).jobError.code).toBe('auth')
    expect((rejected as ProviderError).message).toMatch(/legacy Access Key \+ Secret Key/)
  })

  it('validates inputs before sending anything', async () => {
    const { calls } = installFetch(() => created())
    const noRefs = await createKlingElement(LEGACY, { ...elementInput(), references: [] }, undefined, FAST).catch((e: unknown) => e)
    expect((noRefs as ProviderError).jobError.code).toBe('invalid_params')
    const webp = { ...fixtures.image('webp'), mime: 'image/webp' }
    const badMime = await createKlingElement(LEGACY, { ...elementInput(), frontal: webp }, undefined, FAST).catch((e: unknown) => e)
    expect((badMime as ProviderError).message).toMatch(/JPEG or PNG/)
    const missing = { ...fixtures.image('gone'), path: join(fixtures.dir, 'does-not-exist.png') }
    const unreadable = await createKlingElement(LEGACY, { ...elementInput(), references: [missing] }, undefined, FAST).catch((e: unknown) => e)
    expect((unreadable as ProviderError).jobError.code).toBe('invalid_params')
    expect(calls).toHaveLength(0)
  })

  it('maps failed tasks, keeps polling through a not-found and gives up after the timeout', async () => {
    installFetch((_c, i) => (i === 0 ? created() : taskState('failed', { task_status_msg: 'Failure to pass the risk control system' })))
    const moderated = await createKlingElement(LEGACY, elementInput(), undefined, FAST).catch((e: unknown) => e)
    expect((moderated as ProviderError).jobError).toMatchObject({ code: 'moderation', message: 'Kling: Failure to pass the risk control system' })

    installFetch((_c, i) => (i === 0 ? created() : i === 1 ? jsonResponse({ code: 1203, message: 'task not found' }, 404) : finished(7)))
    await expect(createKlingElement(LEGACY, elementInput(), undefined, FAST)).resolves.toMatchObject({ elementId: '7' })

    installFetch((_c, i) => (i === 0 ? created() : taskState('processing')))
    const slow = await createKlingElement(LEGACY, elementInput(), undefined, { pollIntervalMs: 1, timeoutMs: 15 }).catch((e: unknown) => e)
    expect((slow as ProviderError).jobError).toMatchObject({ code: 'provider', retryable: true })
    expect((slow as ProviderError).message).toMatch(/still creating the element \(task el-task-1\)/)
  })

  it('retries once with a suffixed name when the name is taken', async () => {
    const { calls } = installFetch((_c, i) =>
      i === 0 ? jsonResponse({ code: 1201, message: 'element name already exists' }, 400) : i === 1 ? created() : finished(),
    )
    await expect(createKlingElement(LEGACY, elementInput(), undefined, FAST)).resolves.toMatchObject({ elementId: '829' })
    const names = calls.filter((c) => c.method === 'POST').map((c) => (c.body as { element_name: string }).element_name)
    expect(names[0]).toBe('Mara')
    expect(names[1]).toMatch(/^Mara [a-z0-9]{1,4}$/)
  })

  it('stops polling when aborted', async () => {
    installFetch((_c, i) => (i === 0 ? created() : taskState('processing')))
    const controller = new AbortController()
    const pending = createKlingElement(LEGACY, elementInput(), controller.signal, { pollIntervalMs: 50, timeoutMs: 5000 })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('element library listing', () => {
  it('lists finished, non-deleted elements', async () => {
    const { calls } = installFetch(() =>
      jsonResponse({
        code: 0,
        data: [
          {
            task_id: 't1',
            task_status: 'succeed',
            created_at: 1_790_000_000_000,
            task_result: {
              elements: [
                {
                  element_id: 829,
                  element_name: 'Mara',
                  element_description: 'Keeper',
                  reference_type: 'image_refer',
                  element_image_list: { frontal_image: 'https://cdn.kling/front.png' },
                  owned_by: '12345',
                  status: 'succeed',
                },
              ],
            },
          },
          { task_id: 't2', task_status: 'succeed', task_result: { elements: [{ element_id: 830, element_name: 'Old', status: 'deleted' }] } },
          { task_id: 't3', task_status: 'processing' },
        ],
      }),
    )
    const elements = await listKlingElements(LEGACY)
    expect(calls[0]!.url).toBe(`${ELEMENTS}?pageNum=1&pageSize=500`)
    expect(jwtIssuer(calls[0]!.headers.authorization)).toBe('ak-elements')
    expect(elements).toEqual([
      {
        elementId: '829',
        name: 'Mara',
        description: 'Keeper',
        referenceType: 'image_refer',
        status: 'succeed',
        ownedBy: '12345',
        frontalImageUrl: 'https://cdn.kling/front.png',
        createdAt: new Date(1_790_000_000_000).toISOString(),
      },
    ])
  })

  it('lists presets and deletes custom elements', async () => {
    const { calls } = installFetch((_c, i) =>
      i === 0
        ? jsonResponse({ code: 0, data: [{ task_id: 'p', task_status: 'succeed', task_result: { elements: [{ element_id: 1, element_name: 'Grace', owned_by: 'kling' }] } }] })
        : jsonResponse({ code: 0, data: { task_id: 'del', task_status: 'submitted' } }),
    )
    expect(await listKlingElements({ apiKey: 'k' }, { presets: true })).toMatchObject([{ elementId: '1', name: 'Grace', ownedBy: 'kling' }])
    expect(calls[0]!.url).toBe(`${BASE}/v1/general/advanced-presets-elements?pageNum=1&pageSize=500`)
    await deleteKlingElement(LEGACY, '829')
    expect(calls[1]).toMatchObject({ url: `${BASE}/v1/general/delete-advanced-elements`, method: 'POST', body: { element_id: '829' } })
  })
})

describe('elements and multi-shot in video requests', () => {
  const CREDS = { apiKey: 'kling-test-key' }
  const submitWith = async (modelId: string, params: Record<string, unknown>, inputs = {}) => {
    const { calls } = installFetch(() => jsonResponse({ code: 0, data: { id: 'task-9', status: 'submitted' } }))
    const { ctx, records } = makeCtx(model(modelId), params, { credentials: CREDS, inputs })
    const result = await createKlingAdapter().submit(ctx)
    return { call: calls[0]!, result, records }
  }

  it('adds one element entry per character to Kling 3.0 image-to-video contents', async () => {
    const first = fixtures.image('kf', 'KEYFRAME')
    const { call } = await submitWith('kling-3.0', { prompt: '@element_1 waves at @element_2', firstFrame: 'kf', elements: ['829', '830'] }, { firstFrame: first })
    expect(call.url).toBe(`${BASE}/image-to-video/kling-3.0`)
    expect((call.body as { contents: unknown[] }).contents).toEqual([
      { type: 'prompt', text: '@element_1 waves at @element_2' },
      { type: 'first_frame', url: b64('KEYFRAME') },
      { type: 'element', element_id: '829', id: 'element_1' },
      { type: 'element', element_id: '830', id: 'element_2' },
    ])
  })

  it('sends Kling 3.0 Omni to /omni-video with up to 7 elements and an aspect ratio', async () => {
    const elements = ['1', '2', '3', '4', '5', '6', '7']
    const { call, result } = await submitWith('kling-3.0-omni', { prompt: 'The whole cast on the pier', elements, aspectRatio: '9:16' })
    expect(call.url).toBe(`${BASE}/omni-video/kling-3.0-omni`)
    expect(result).toMatchObject({ type: 'async', taskId: 'task-9', meta: { endpoint: '/omni-video/kling-3.0-omni' } })
    const body = call.body as { contents: { type: string; element_id?: string; id?: string }[]; settings: Record<string, unknown> }
    expect(body.contents[0]).toEqual({ type: 'prompt', text: 'The whole cast on the pier' })
    expect(body.contents.slice(1)).toEqual(elements.map((id, i) => ({ type: 'element', element_id: id, id: `element_${i + 1}` })))
    expect(body.settings).toEqual({ resolution: '720p', duration: 5, audio: 'native', aspect_ratio: '9:16', multi_shot: false })
  })

  it('sends Omni start/end frames with elements', async () => {
    const first = fixtures.image('o-first', 'O-FIRST')
    const last = fixtures.image('o-last', 'O-LAST')
    const { call, records } = await submitWith(
      'kling-3.0-omni',
      { prompt: 'p', firstFrame: 'o-first', lastFrame: 'o-last', elements: ['1', '2', '3'], audio: false },
      { firstFrame: first, lastFrame: last },
    )
    const body = call.body as { contents: { type: string }[]; settings: Record<string, unknown> }
    expect(body.contents.map((c) => c.type)).toEqual(['prompt', 'first_frame', 'last_frame', 'element', 'element', 'element'])
    expect(body.settings).toEqual({ resolution: '720p', duration: 5, audio: 'off', multi_shot: false })
    expect(JSON.stringify(records)).not.toContain(b64('O-FIRST'))
  })

  it('enforces element limits in the adapter too', async () => {
    installFetch(() => jsonResponse({ data: { id: 'x' } }))
    const noFrame = makeCtx(model('kling-3.0'), { prompt: 'p' }, { credentials: CREDS }).ctx
    noFrame.params.elements = ['829']
    const error = await createKlingAdapter().submit(noFrame).catch((e: unknown) => e)
    expect((error as ProviderError).jobError).toMatchObject({ code: 'invalid_params' })
    expect((error as ProviderError).message).toMatch(/start frame/)

    const first = fixtures.image('lim', 'LIM')
    const framed = makeCtx(model('kling-3.0-omni'), { prompt: 'p', firstFrame: 'lim' }, { credentials: CREDS, inputs: { firstFrame: first } }).ctx
    framed.params.elements = ['1', '2', '3', '4']
    const tooMany = await createKlingAdapter().submit(framed).catch((e: unknown) => e)
    expect((tooMany as ProviderError).message).toMatch(/up to 3 characters with a start frame/)
  })

  it('turns a friendly shot list into Kling’s native multi-shot prompt and remembers the plan', async () => {
    const prompt = 'Storm at sea.\nShot 1 (3s): wide shot of the lighthouse\nShot 2: close-up of the keeper\n[2s] the lamp flares'
    const { call, result } = await submitWith('kling-3.0', { prompt, duration: 10, multiShot: true })
    expect(call.url).toBe(`${BASE}/text-to-video/kling-3.0`)
    const body = call.body as { prompt: string; settings: Record<string, unknown> }
    expect(body.prompt).toBe('shot 1, 3, Storm at sea. wide shot of the lighthouse; shot 2, 5, close-up of the keeper; shot 3, 2, the lamp flares;')
    expect(body.settings.multi_shot).toBe(true)
    const multiShot = {
      shots: [
        { text: 'Storm at sea. wide shot of the lighthouse', seconds: 3 },
        { text: 'close-up of the keeper', seconds: 5 },
        { text: 'the lamp flares', seconds: 2 },
      ],
      expectedCuts: [3, 8],
    }
    expect(result).toMatchObject({ type: 'async', meta: { multiShot } })

    // The finished video carries the plan (stored on the asset for "Split into shots").
    installFetch(() =>
      jsonResponse({ code: 0, data: [{ id: 'task-9', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.kling/v.mp4', duration: '10' }] }] }),
    )
    const { ctx } = makeCtx(model('kling-3.0'), { prompt, duration: 10, multiShot: true }, {
      credentials: CREDS,
      providerTaskId: 'task-9',
      providerMeta: { multiShot },
    })
    const done = await createKlingAdapter().poll!(ctx)
    expect(done).toMatchObject({ type: 'done', outputs: [{ url: 'https://cdn.kling/v.mp4', meta: { multiShot } }] })
  })

  it('lets Kling plan the cuts when the prompt has no shot list, and leaves single-shot prompts alone', async () => {
    const auto = await submitWith('kling-3.0-omni', { prompt: 'A chase through the market', multiShot: true })
    expect((auto.call.body as { contents: unknown[] }).contents[0]).toEqual({ type: 'prompt', text: 'A chase through the market' })
    expect(auto.result).toMatchObject({ meta: { multiShot: { shots: [], expectedCuts: [], auto: true } } })

    const off = await submitWith('kling-3.0', { prompt: 'Shot 1 (2s): a\nShot 2 (3s): b' })
    expect((off.call.body as { prompt: string }).prompt).toBe('Shot 1 (2s): a\nShot 2 (3s): b')
    expect(off.result).toEqual({ type: 'async', taskId: 'task-9', meta: { endpoint: '/text-to-video/kling-3.0', externalTaskId: 'gen-1' } })
  })

  it('recomputes the plan at poll time for tasks submitted without it', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 't', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.kling/a.mp4' }] }] }))
    const { ctx } = makeCtx(model('kling-3.0'), { prompt: 'Shot 1 (2s): a\nShot 2: b', duration: 5, multiShot: true }, {
      credentials: CREDS,
      providerTaskId: 't',
    })
    const done = await createKlingAdapter().poll!(ctx)
    expect(done).toMatchObject({ type: 'done', outputs: [{ meta: { multiShot: { expectedCuts: [2] } } }] })
  })
})

describe('POST /kling/elements', () => {
  let root: string
  let deps: AppDeps
  let app: Hono
  const ids: Record<string, string> = {}

  const request = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://127.0.0.1/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json()) as CreateKlingElementResponse & { error?: string; elements?: unknown[] } }
  }

  beforeAll(async () => {
    mkdirSync('tests/.tmp', { recursive: true })
    root = await mkdtemp(join('tests/.tmp', 'kling-elements-'))
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7792 }), { secrets: new MemorySecretStore() })
    const project = deps.registry.create({ name: 'Elements' })
    app = new Hono()
    app.onError((err, c) => (err instanceof ApiError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500)))
    app.route('/api', klingRoutes(deps))
    const make = async (name: string, color: string, size: string, ext: string) => {
      const path = join(root, `${name}.${ext}`)
      await runFfmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=0.1`, '-frames:v', '1', '-update', '1', path])
      const asset = await deps.media.importFile(path, { name, source: 'import', projectId: project.id })
      ids[name] = (await deps.media.whenReady(asset.id)).id
    }
    await make('front', 'red', '400x500', 'png')
    await make('side', 'blue', '400x500', 'png')
    await make('tiny', 'green', '200x200', 'png')
    await make('anim', 'yellow', '400x400', 'gif')
  }, 60_000)

  afterAll(async () => {
    if (deps) await closeDeps(deps)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('needs Kling keys', async () => {
    const { status, json } = await request('POST', '/kling/elements', { name: 'Mara', frontalAssetId: ids.front, referenceAssetIds: [ids.side] })
    expect(status).toBe(400)
    expect(json.error).toMatch(/Settings → Providers/)
  })

  it('creates the element from ready image assets and replaces the old one', async () => {
    deps.secrets.set('kling', 'accessKey', LEGACY.accessKey)
    deps.secrets.set('kling', 'secretKey', LEGACY.secretKey)
    const { calls } = installFetch((call) => {
      if (call.url === ELEMENTS) return created('route-task')
      if (call.url.startsWith(`${ELEMENTS}/`)) return finished(4242)
      return jsonResponse({ code: 0, data: { task_id: 'del' } })
    })
    const { status, json } = await request('POST', '/kling/elements', {
      name: 'Mara',
      description: 'Keeper',
      frontalAssetId: ids.front,
      referenceAssetIds: [ids.side, ids.front, ids.side],
      replaceElementId: '100',
    })
    expect(status).toBe(201)
    expect(json).toEqual({ elementId: '4242', taskId: 'route-task', sourceAssetIds: [ids.front, ids.side], replaced: true })
    const createCall = calls.find((c) => c.url === ELEMENTS)!
    const body = createCall.body as { element_image_list: { frontal_image: string; refer_images: { image_url: string }[] } }
    expect(Buffer.from(body.element_image_list.frontal_image, 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect(body.element_image_list.refer_images).toHaveLength(1)
    expect(calls.at(-1)).toMatchObject({ url: `${BASE}/v1/general/delete-advanced-elements`, body: { element_id: '100' } })
  })

  it('converts other image formats to JPEG', async () => {
    const { calls } = installFetch((call) => (call.url === ELEMENTS ? created() : finished(5)))
    const { status } = await request('POST', '/kling/elements', { name: 'Sun', frontalAssetId: ids.anim, referenceAssetIds: [ids.side] })
    expect(status).toBe(201)
    const frontal = (calls[0]!.body as { element_image_list: { frontal_image: string } }).element_image_list.frontal_image
    expect([...Buffer.from(frontal, 'base64').subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  })

  it('rejects unusable references with clear messages', async () => {
    installFetch(() => created())
    const single = await request('POST', '/kling/elements', { name: 'Mara', frontalAssetId: ids.front })
    expect(single.status).toBe(400)
    expect(single.json.error).toMatch(/at least one more reference image/)
    const tiny = await request('POST', '/kling/elements', { name: 'Mara', frontalAssetId: ids.front, referenceAssetIds: [ids.tiny] })
    expect(tiny.status).toBe(400)
    expect(tiny.json.error).toMatch(/at least 300 px/)
    const missing = await request('POST', '/kling/elements', { name: 'Mara', frontalAssetId: 'nope', referenceAssetIds: [ids.side] })
    expect(missing.status).toBe(404)
    const unnamed = await request('POST', '/kling/elements', { name: ' ', frontalAssetId: ids.front, referenceAssetIds: [ids.side] })
    expect(unnamed.status).toBe(400)
  })

  it('maps Kling failures to API errors', async () => {
    installFetch(() => jsonResponse({ code: 1102, message: 'Resource pack exhausted' }, 429))
    const { status, json } = await request('POST', '/kling/elements', { name: 'Mara', frontalAssetId: ids.front, referenceAssetIds: [ids.side] })
    expect(status).toBe(402)
    expect(json.error).toMatch(/resource package/)
  })

  it('lists elements', async () => {
    installFetch(() => jsonResponse({ code: 0, data: [{ task_id: 't', task_status: 'succeed', task_result: { elements: [{ element_id: 9, element_name: 'Mara' }] } }] }))
    const { status, json } = await request('GET', '/kling/elements')
    expect(status).toBe(200)
    expect(json.elements).toEqual([{ elementId: '9', name: 'Mara' }])
  })
})
