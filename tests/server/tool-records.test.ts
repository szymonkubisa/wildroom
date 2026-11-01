import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { describeMedia, locateSubjects } from '../../src/server/services/director'
import { elevenIsolate, elevenTranscribe } from '../../src/server/services/analysis'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { MemorySecretStore } from '../../src/server/services/keychain'
import type { ProjectDetail, ProjectSpendDTO } from '../../src/shared/types/api'
import type { AssetDTO } from '../../src/shared/types/assets'
import type { GenerationDTO, GenerationDetails } from '../../src/shared/types/jobs'

// The paid providers never run in tests: the calls the tool routes make are stubbed here.
vi.mock('../../src/server/services/analysis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/services/analysis')>()),
  elevenIsolate: vi.fn(),
  elevenTranscribe: vi.fn(),
  frameJpeg: vi.fn(async () => Buffer.from('jpeg')),
}))
vi.mock('../../src/server/services/director', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/services/director')>()),
  describeMedia: vi.fn(),
  locateSubjects: vi.fn(),
}))
vi.mock('../../src/server/services/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/services/llm')>()),
  resolveTarget: vi.fn(async () => ({ via: 'anthropic', model: 'anthropic/claude-opus-5.5', providerModel: 'claude-opus-5-5' })),
}))

const ORIGIN = 'http://127.0.0.1:5180'
const HOST = '127.0.0.1:5180'
const ELEVEN_KEY = 'sk-eleven-test-key'

describe('paid editor tools: one project, and a generation record per call', () => {
  let root: string
  let deps: AppDeps
  let secrets: MemorySecretStore
  let app: ReturnType<typeof createApp>
  let a: ProjectDetail
  let b: ProjectDetail
  let toneA: AssetDTO
  let toneB: AssetDTO
  let stillA: AssetDTO
  let tonePath: string

  const req = (method: string, path: string, body?: unknown) =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, ...(method !== 'GET' ? { origin: ORIGIN, 'x-studio': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const generations = async (projectId: string) => (await (await req('GET', `/api/projects/${projectId}/generations`)).json()) as GenerationDTO[]
  const spend = async (projectId: string) => (await (await req('GET', `/api/projects/${projectId}/spend`)).json()) as ProjectSpendDTO

  async function importReady(projectId: string, path: string, name: string): Promise<AssetDTO> {
    const asset = await deps.media.importFile(path, { name, source: 'import', projectId })
    return deps.media.whenReady(asset.id)
  }

  beforeAll(async () => {
    // Nothing here may reach the network.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network in tests'))))
    mkdirSync('tests/.tmp', { recursive: true })
    root = resolve(await mkdtemp(join('tests/.tmp', 'tool-records-')))
    secrets = new MemorySecretStore()
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7781 }), { secrets })
    app = createApp(deps)
    a = (await (await req('POST', '/api/projects', { name: 'Tools A' })).json()) as ProjectDetail
    b = (await (await req('POST', '/api/projects', { name: 'Tools B' })).json()) as ProjectDetail
    tonePath = join(root, 'tone.mp3')
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', tonePath])
    const otherTone = join(root, 'other.mp3')
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=550:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', otherTone])
    const still = join(root, 'still.png')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', still])
    toneA = await importReady(a.id, tonePath, 'Interview')
    toneB = await importReady(b.id, otherTone, 'Other project line')
    stillA = await importReady(a.id, still, 'Poster')
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await closeDeps(deps)
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.mocked(elevenIsolate).mockReset()
    vi.mocked(elevenTranscribe).mockReset()
    vi.mocked(describeMedia).mockReset()
    vi.mocked(locateSubjects).mockReset()
    secrets.set('elevenlabs', 'apiKey', ELEVEN_KEY)
    secrets.delete('anthropic', 'apiKey')
    deps.settings.update({ demoMode: false })
  })

  it("won't use another project's asset: 404, nothing sent, nothing recorded", async () => {
    secrets.set('anthropic', 'apiKey', 'sk-ant-test')
    expect((await req('POST', `/api/projects/${a.id}/assets/${toneB.id}/isolate-voice`)).status).toBe(404)
    expect((await req('POST', `/api/projects/${a.id}/assets/${toneB.id}/reverse`)).status).toBe(404)
    expect((await req('POST', `/api/projects/${a.id}/voice-sample`, { speechAssetId: toneA.id, bedAssetId: toneB.id })).status).toBe(404)
    // Frames of one request come from one project.
    const mixed = { items: [{ assetId: stillA.id, seconds: 0 }, { assetId: toneB.id, seconds: 0 }] }
    expect((await req('POST', '/api/director/subjects', mixed)).status).toBe(404)
    expect((await req('POST', '/api/analysis/frame-stats', mixed)).status).toBe(404)
    const cut = { cut: 1, outgoing: { assetId: stillA.id, seconds: 0 }, incoming: { assetId: toneB.id, seconds: 0 } }
    expect((await req('POST', '/api/director/continuity', { cuts: [cut] })).status).toBe(404)
    expect(elevenIsolate).not.toHaveBeenCalled()
    expect(locateSubjects).not.toHaveBeenCalled()
    expect(await generations(a.id)).toEqual([])
    expect(await generations(b.id)).toEqual([])
  })

  it('records a paid voice isolation as a finished generation, and the spend counts it', async () => {
    vi.mocked(elevenIsolate).mockResolvedValue(readFileSync(tonePath))
    const before = await spend(a.id)
    const res = await req('POST', `/api/projects/${a.id}/assets/${toneA.id}/isolate-voice`)
    expect(res.status).toBe(201)
    const voice = (await res.json()) as AssetDTO
    expect(voice).toMatchObject({ source: 'derived', parentIds: [toneA.id], projectIds: [a.id] })

    const [record, ...others] = (await generations(a.id)).filter((g) => g.modelId === 'elevenlabs-audio-isolation')
    expect(others).toEqual([])
    expect(record).toMatchObject({
      projectId: a.id,
      provider: 'elevenlabs',
      status: 'succeeded',
      outputAssetIds: [voice.id],
      params: { tool: 'Voice isolation', input: 'Interview' },
    })
    expect(record!.label).toContain('Interview')
    expect(record!.finishedAt).toBeTruthy()
    // Saved in the bundle, with what was sent and no key.
    const file = join(deps.registry.mounted(a.id)!.root, 'Generations', `${record!.id}.json`)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain(ELEVEN_KEY)
    const details = (await (await req('GET', `/api/generations/${record!.id}/details`)).json()) as GenerationDetails
    expect(details.request).toMatchObject({ endpoint: 'POST /v1/audio-isolation', audio: { assetId: toneA.id } })

    const after = await spend(a.id)
    expect(after.count).toBe(before.count + 1)
    expect(after.byModel['elevenlabs-audio-isolation']).toEqual({ usd: 0, count: 1 })
    // ElevenLabs bills credits: no USD figure to add.
    expect(after.totalUsd).toBe(before.totalUsd)
    expect(await spend(b.id)).toMatchObject({ count: 0 })
  })

  it('records a transcription and an AI description in the asset’s own project', async () => {
    secrets.set('anthropic', 'apiKey', 'sk-ant-test')
    vi.mocked(elevenTranscribe).mockResolvedValue({ words: [{ text: 'Hello', start: 0.1, end: 0.4 }], language: 'en', text: 'Hello' })
    vi.mocked(describeMedia).mockResolvedValue({ description: 'A red square.', tags: ['red'] })
    const before = await spend(a.id)

    const transcribed = (await (await req('POST', `/api/assets/${toneA.id}/transcribe`)).json()) as AssetDTO
    expect(transcribed.alignment?.words).toHaveLength(1)
    const described = (await (await req('POST', `/api/assets/${stillA.id}/describe`)).json()) as AssetDTO
    expect(described.description).toBe('A red square.')

    const list = await generations(a.id)
    expect(list.find((g) => g.modelId === 'elevenlabs-scribe-v1')).toMatchObject({ provider: 'elevenlabs', status: 'succeeded', outputAssetIds: [], params: { tool: 'Transcription' } })
    expect(list.find((g) => g.params.tool === 'AI description')).toMatchObject({
      modelId: 'anthropic/claude-opus-5.5',
      provider: 'anthropic',
      kind: 'image',
      status: 'succeeded',
    })
    const after = await spend(a.id)
    expect(after.count).toBe(before.count + 2)
    expect(after.byModel['anthropic/claude-opus-5.5']?.count).toBe(1)
  })

  it('records nothing for the free local stand-ins (demo mode)', async () => {
    secrets.delete('elevenlabs', 'apiKey')
    deps.settings.update({ demoMode: true })
    const before = (await generations(a.id)).length
    expect((await req('POST', `/api/assets/${toneA.id}/transcribe`)).status).toBe(200)
    expect((await req('POST', '/api/director/subjects', { items: [{ assetId: stillA.id, seconds: 0 }] })).status).toBe(200)
    expect(elevenTranscribe).not.toHaveBeenCalled()
    expect(locateSubjects).not.toHaveBeenCalled()
    expect(await generations(a.id)).toHaveLength(before)
  })
})
