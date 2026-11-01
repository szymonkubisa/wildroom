import { describe, expect, it } from 'vitest'
import { RunpodApi, RunpodError, classify } from '../../src/server/providers/runpod/api'
import { createRunpodAdapter } from '../../src/server/providers/runpod/adapter'
import { DEFAULT_RUNPOD_SETTINGS, LTX_GPUS, precisionFor, sanitizeRunpodSettings } from '../../src/shared/types/runpod'
import { type FetchCall, jsonResponse } from './helpers'

type Handler = (call: FetchCall) => Response | Promise<Response>

/** A RunpodApi whose fetch is a handler (no global stub needed). */
function apiWith(handler: Handler) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => (headers[key] = value))
    const call: FetchCall = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { api: new RunpodApi({ apiKey: 'rpa_test', fetchImpl }), calls }
}

describe('RunPod API client', () => {
  it('sends the key as a bearer token and reads volumes in either list shape', async () => {
    const { api, calls } = apiWith(() => jsonResponse({ networkVolumes: [{ id: 'v1', name: 'ltx', size: 150, dataCenter: 'EU-RO-1' }] }))
    expect(await api.listVolumes()).toEqual([{ id: 'v1', name: 'ltx', size: 150, dataCenter: 'EU-RO-1', type: undefined }])
    expect(calls[0]).toMatchObject({ url: 'https://api.runpod.io/v2/network-volumes', method: 'GET' })
    expect(calls[0]!.headers.authorization).toBe('Bearer rpa_test')

    const bare = apiWith(() => jsonResponse([{ id: 'v2', name: 'x', size: 50, dataCenterId: 'EU-SE-1' }]))
    expect((await bare.api.listVolumes())[0]).toMatchObject({ id: 'v2', dataCenter: 'EU-SE-1' })
  })

  it('creates pods with the v2 body and reads the pod back', async () => {
    const { api, calls } = apiWith(() => jsonResponse({ id: 'pod1', name: 'wildroom-x', status: 'provisioning', cost: 2.09, gpu: { id: LTX_GPUS[0]!.id, count: 1 } }, 201))
    const pod = await api.createPod({
      name: 'wildroom-x',
      image: 'runpod/comfyui:1.4.0-comfyuiv0.35.0-cuda12.8',
      gpu: { id: LTX_GPUS[0]!.id, count: 1, minCudaVersion: '12.8' },
      cloud: 'SECURE',
      dataCenterIds: ['EU-RO-1'],
      mounts: { network: [{ volumeId: 'v1', path: '/workspace' }] },
      disk: 50,
      ports: ['8188/http'],
      env: { COMFY_AUTH_TOKEN: 't' },
    })
    expect(pod).toMatchObject({ id: 'pod1', status: 'PROVISIONING', cost: 2.09 })
    expect(calls[0]).toMatchObject({ url: 'https://api.runpod.io/v2/pods', method: 'POST' })
    expect(calls[0]!.body).toMatchObject({ mounts: { network: [{ volumeId: 'v1', path: '/workspace' }] }, ports: ['8188/http'] })
  })

  it('treats a missing pod as gone, both when reading and when deleting it', async () => {
    const { api } = apiWith(() => jsonResponse({ title: 'Not Found', status: 404, detail: 'pod not found' }, 404))
    expect(await api.getPod('nope')).toBeUndefined()
    await expect(api.deletePod('nope')).resolves.toBeUndefined()
  })

  it('pages through pods', async () => {
    const { api, calls } = apiWith((call) =>
      call.url.includes('cursor=c2')
        ? jsonResponse({ pods: [{ id: 'b', name: 'wildroom-b', status: 'RUNNING' }], pagination: { hasNextPage: false } })
        : jsonResponse({ pods: [{ id: 'a', name: 'wildroom-a', status: 'EXITED' }], pagination: { hasNextPage: true, nextCursor: 'c2' } }),
    )
    expect((await api.listPods()).map((p) => p.id)).toEqual(['a', 'b'])
    expect(calls).toHaveLength(2)
  })

  it('reads the balance over GraphQL and surfaces GraphQL errors', async () => {
    const ok = apiWith(() => jsonResponse({ data: { myself: { clientBalance: 14.2, currentSpendPerHr: 0 } } }))
    expect(await ok.api.account()).toEqual({ clientBalance: 14.2, currentSpendPerHr: 0 })
    expect(ok.calls[0]!.url).toBe('https://api.runpod.io/graphql')

    const bad = apiWith(() => jsonResponse({ errors: [{ message: 'Unauthorized' }] }))
    await expect(bad.api.account()).rejects.toMatchObject({ kind: 'auth' })
  })

  it('reads GPU stock per data center', async () => {
    const { api } = apiWith(() =>
      jsonResponse([{ id: 'EU-RO-1', name: 'Romania', gpuAvailability: [{ id: LTX_GPUS[0]!.id, availability: 'high' }, { id: 'X', stockStatus: 'weird' }] }]),
    )
    const [dc] = await api.datacenters()
    expect(dc!.gpuAvailability).toEqual([
      { id: LTX_GPUS[0]!.id, name: undefined, availability: 'HIGH' },
      { id: 'X', name: undefined, availability: 'NONE' },
    ])
  })

  it('reads data centers in the documented {dataCenters} shape with their volume tiers', async () => {
    const { api, calls } = apiWith(() =>
      jsonResponse({ dataCenters: [{ id: 'EU-FR-1', name: 'France', region: 'EUROPE', networkVolumeTypes: ['HIGH_PERFORMANCE'], gpuAvailability: [] }] }),
    )
    expect(await api.datacenters()).toEqual([{ id: 'EU-FR-1', name: 'France', region: 'EUROPE', networkVolumeTypes: ['HIGH_PERFORMANCE'], gpuAvailability: [] }])
    expect(calls[0]!.url).toBe('https://api.runpod.io/v2/catalog/datacenters?include=GPU_AVAILABILITY')
  })

  it('reads GPU stock on hosts with the CUDA version the pod needs, per data center', async () => {
    const { api, calls } = apiWith(() =>
      jsonResponse({
        gpus: [{ id: LTX_GPUS[0]!.id, name: 'RTX PRO 6000', memory: 96, price: { secure: 2.09, community: 0 }, availability: 'LOW', dataCenters: [{ id: 'US-CO-1', availability: 'LOW' }] }],
      }),
    )
    const stock = await api.stockIn('US-CO-1', '13.0')
    expect([...stock]).toEqual([[LTX_GPUS[0]!.id, 'LOW']])
    expect(calls[0]!.url).toContain('/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&minCudaVersion=13.0')
  })

  it('classifies failures so callers know whether to try another GPU, stop or wait', () => {
    expect(classify(400, JSON.stringify({ detail: 'There are no longer any instances available' }))).toMatchObject({ kind: 'rejected', message: expect.stringContaining('no longer any instances') })
    expect(classify(401, '')).toMatchObject({ kind: 'auth' })
    expect(classify(402, '{"detail":"balance too low"}')).toMatchObject({ kind: 'balance' })
    expect(classify(429, '', '7')).toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 })
    expect(classify(503, 'upstream')).toMatchObject({ kind: 'server' })
    expect(classify(422, '{"title":"Unprocessable"}')).toBeInstanceOf(RunpodError)
  })

  it('reports network failures as RunpodError', async () => {
    const { api } = apiWith(() => {
      throw new TypeError('fetch failed')
    })
    await expect(api.listVolumes()).rejects.toMatchObject({ kind: 'network' })
  })
})

describe('RunPod adapter test()', () => {
  it('reports the volume count and balance, or a clear key error', async () => {
    const adapter = createRunpodAdapter()
    const realFetch = globalThis.fetch
    try {
      globalThis.fetch = (async (input: string | URL | Request) =>
        String(input).includes('graphql')
          ? jsonResponse({ data: { myself: { clientBalance: 9.876 } } })
          : jsonResponse({ networkVolumes: [{ id: 'v1', name: 'ltx', size: 150, dataCenter: 'EU-RO-1' }] })) as typeof fetch
      expect(await adapter.test({ apiKey: 'k' })).toMatchObject({ ok: true, message: 'Connected — 1 network volume.', credits: { remaining: 9.88, unit: 'USD' } })
      globalThis.fetch = (async () => jsonResponse({ title: 'Unauthorized' }, 401)) as typeof fetch
      expect(await adapter.test({ apiKey: 'bad' })).toEqual({ ok: false, message: 'Invalid API key' })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('RunPod settings', () => {
  it('repairs bad values and keeps known GPUs in a stable order', () => {
    expect(sanitizeRunpodSettings(undefined)).toEqual(DEFAULT_RUNPOD_SETTINGS)
    const repaired = sanitizeRunpodSettings({ volumeId: '../etc', gpuIds: ['bogus', LTX_GPUS[2]!.id, LTX_GPUS[2]!.id], idleSeconds: 0, maxHours: 99 })
    expect(repaired.volumeId).toBe('')
    expect(repaired.gpuIds).toEqual([LTX_GPUS[2]!.id])
    expect(repaired.idleSeconds).toBe(15)
    // Settings from before seconds (idleMinutes) start at the 30 s default.
    expect(sanitizeRunpodSettings({ idleMinutes: 5 }).idleSeconds).toBe(30)
    expect(repaired.maxHours).toBe(24)
    // An empty GPU list falls back to the default instead of leaving nothing to rent.
    expect(sanitizeRunpodSettings({ gpuIds: [] }).gpuIds).toEqual(DEFAULT_RUNPOD_SETTINGS.gpuIds)
  })

  it('picks bf16 for 80 GB+ cards and int8 below', () => {
    expect(precisionFor(96)).toBe('bf16')
    expect(precisionFor(80)).toBe('bf16')
    expect(precisionFor(48)).toBe('int8')
    for (const g of LTX_GPUS) expect(g.precision).toBe(precisionFor(g.vramGb))
  })
})
