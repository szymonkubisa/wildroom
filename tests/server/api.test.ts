import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { setDesktopTrash } from '../../src/server/services/desktopBridge'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { readJsonFile, writeJsonSync } from '../../src/server/storage/atomicFile'
import { type AssetRecord, type GenerationRecord, type ProjectFile, RECORD_ID_RE, normalizeAssetRecord } from '../../src/server/storage/records'
import { sweepUploadTemp } from '../../src/server/routes/assets'
import { UnsafeSvgError, rasterizeSvg, stripExternalRefs } from '../../src/server/services/svg'
import type { AssetDTO } from '../../src/shared/types/assets'
import type { GenerationDTO, GenerationDetails } from '../../src/shared/types/jobs'
import type { ProjectDetail, ProjectEntry } from '../../src/shared/types/api'

const ORIGIN = 'http://127.0.0.1:5180'
const HOST = '127.0.0.1:5180'

let root: string
let deps: AppDeps
let app: ReturnType<typeof createApp>

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = {
    method,
    headers: {
      host: HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-studio': '1' } : {}),
      ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body),
  }
  return app.request(`http://${HOST}${path}`, init)
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  root = resolve(await mkdtemp(join('tests/.tmp', 'api-')))
  deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7777 }), { secrets: new MemorySecretStore() })
  app = createApp(deps)
  deps.worker.start()
  // Never touch the real Trash from tests.
  setDesktopTrash(async (path) => rmSync(path, { recursive: true, force: true }))
})

afterAll(async () => {
  setDesktopTrash(undefined)
  await closeDeps(deps)
  rmSync(root, { recursive: true, force: true })
})

describe('local API security', () => {
  it('rejects foreign hosts, foreign origins and mutations without X-Studio', async () => {
    expect((await app.request('http://evil.test/api/health', { headers: { host: 'evil.test' } })).status).toBe(403)
    expect((await req('GET', '/api/health', undefined, { origin: 'https://evil.example' })).status).toBe(403)
    const res = await app.request(`http://${HOST}/api/projects`, {
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(403)
    expect((await req('GET', '/api/health')).status).toBe(200)
  })
})

describe('generate → ingest → media → export', () => {
  let project: ProjectDetail
  let asset: AssetDTO

  it('creates a project', async () => {
    const res = await req('POST', '/api/projects', { name: 'Test film', settings: { width: 1280, height: 720 } })
    expect(res.status).toBe(201)
    project = (await res.json()) as ProjectDetail
    expect(project.doc.spine).toEqual([])
    expect(project.revision).toBe(1)
    // A self-contained bundle in the projects folder.
    expect(project.path).toBe(join(deps.appState.projectsDir, 'Test film.wildroom'))
    expect(readdirSync(project.path).sort()).toEqual(['.lock', 'Assets', 'Generations', 'Media', 'project.json'])
    expect(readJsonFile<ProjectFile>(join(project.path, 'project.json'))?.value).toMatchObject({ id: project.id, name: 'Test film', format: 1 })
  })

  it('rejects stale autosaves with 409', async () => {
    const ok = await req('PUT', `/api/projects/${project.id}/doc`, { doc: project.doc, baseRevision: 1 })
    expect(ok.status).toBe(200)
    expect(readJsonFile<ProjectFile>(join(project.path, 'project.json'))?.value.revision).toBe(2)
    const stale = await req('PUT', `/api/projects/${project.id}/doc`, { doc: project.doc, baseRevision: 1 })
    expect(stale.status).toBe(409)
  })

  it('saves documents with several timelines and refuses malformed timeline lists', async () => {
    const settings = { ...project.doc.settings, width: 1080, height: 1920 }
    const entry = { id: 'v', name: 'Vertical', createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:00.000Z', settings, durationFrames: 0, spine: [], connected: [], markers: [] }
    const main = { ...entry, id: 'main', name: 'Main', settings: project.doc.settings, spine: undefined, connected: undefined, markers: undefined }
    const doc = { ...project.doc, timelines: [main, entry], activeTimelineId: 'main' }
    const ok = await req('PUT', `/api/projects/${project.id}/doc`, { doc, baseRevision: 2 })
    expect(ok.status).toBe(200)
    expect(readJsonFile<ProjectFile>(join(project.path, 'project.json'))?.value.doc.timelines?.map((t) => t.name)).toEqual(['Main', 'Vertical'])
    const dup = await req('PUT', `/api/projects/${project.id}/doc`, { doc: { ...doc, timelines: [entry, entry] }, baseRevision: 3 })
    expect(dup.status).toBe(400)
    const fps = await req('PUT', `/api/projects/${project.id}/doc`, { doc: { ...doc, timelines: [{ ...entry, settings: { ...settings, fps: 23 } }] }, baseRevision: 3 })
    expect(fps.status).toBe(400)
  })

  it('validates params and refuses unconfigured providers', async () => {
    const bad = await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-video', params: {} })
    expect(bad.status).toBe(400)
    const kling = await req('POST', '/api/generations', { projectId: project.id, modelId: 'kling-3.0', params: { prompt: 'x' } })
    expect(kling.status).toBe(400)
    expect(((await kling.json()) as { error: string }).error).toMatch(/Settings/)
  })

  it('runs a mock generation through the worker into a ready asset', async () => {
    const res = await req('POST', '/api/generations', {
      projectId: project.id,
      modelId: 'mock-video',
      params: { prompt: 'Sunrise over a lake', duration: 3, fps: 24 },
      variants: 2,
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as GenerationDTO[]
    expect(created).toHaveLength(2)
    expect(created[0]!.batchId).toBeDefined()

    const done = await waitFor(async () => {
      const g = (await (await req('GET', `/api/generations/${created[0]!.id}`)).json()) as GenerationDTO
      return g.status === 'succeeded' ? g : g.status === 'failed' ? Promise.reject(new Error(g.error?.message)) : undefined
    })
    expect(done.outputAssetIds).toHaveLength(1)
    asset = await deps.media.whenReady(done.outputAssetIds[0]!)
    expect(asset.status).toBe('ready')
    expect(asset.generation?.modelId).toBe('mock-video')
    expect(asset.projectIds).toContain(project.id)
    expect(asset.variants.proxy && asset.variants.audio && asset.variants.poster).toBe(true)

    const list = (await (await req('GET', `/api/projects/${project.id}/assets`)).json()) as AssetDTO[]
    expect(list.map((a) => a.id)).toContain(asset.id)
    // The generation's history and its output live in the bundle.
    const record = readJsonFile<GenerationRecord>(join(project.path, 'Generations', `${done.id}.json`))?.value
    expect(record).toMatchObject({ status: 'succeeded', outputAssetIds: [asset.id], modelId: 'mock-video' })
    expect(record?.params).toMatchObject({ prompt: 'Sunrise over a lake' })
    const assetRecord = readJsonFile<AssetRecord>(join(project.path, 'Assets', `${asset.id}.json`))?.value
    expect(existsSync(join(project.path, 'Media', `${assetRecord?.sha256}.${assetRecord?.ext}`))).toBe(true)
  })

  it('names a render and its media after the label it was given (the storyboard: the shot description)', async () => {
    const label = 'Valentina emerges from the party and discovers Mateo waiting across the courtyard.'
    const res = await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-image', params: { prompt: 'A multi-shot sequence of 3 shots' }, label })
    const [job] = (await res.json()) as GenerationDTO[]
    expect(job!.label).toBe(label)
    const done = await waitFor(async () => {
      const g = (await (await req('GET', `/api/generations/${job!.id}`)).json()) as GenerationDTO
      return g.status === 'succeeded' ? g : g.status === 'failed' ? Promise.reject(new Error(g.error?.message)) : undefined
    })
    expect(deps.media.get(done.outputAssetIds[0]!)?.name).toBe(label)
  })

  it('keeps what was sent to the provider, long prompts whole (right-click → What was sent)', async () => {
    // Keyframe prompts run past 2 000 characters: they were stored as "<2185 chars>".
    const prompt = `A wide shot by the lake. ${'Stefan stands at the pier, the reeds behind him. '.repeat(45)}`.trim()
    const res = await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-image', params: { prompt } })
    const [job] = (await res.json()) as GenerationDTO[]
    await waitFor(async () => {
      const g = (await (await req('GET', `/api/generations/${job!.id}`)).json()) as GenerationDTO
      return g.status === 'succeeded' ? g : g.status === 'failed' ? Promise.reject(new Error(g.error?.message)) : undefined
    })
    const details = (await (await req('GET', `/api/generations/${job!.id}/details`)).json()) as GenerationDetails
    expect(prompt.length).toBeGreaterThan(2000)
    expect((details.request as { params: { prompt: string } }).params.prompt).toBe(prompt)
    expect(details.params.prompt).toBe(prompt)
    expect(details.status).toBe('succeeded')
    expect((await req('GET', '/api/generations/no-such-job/details')).status).toBe(404)
  })

  it('serves media with HTTP Range', async () => {
    const res = await req('GET', `/media/${asset.id}/proxy`, undefined, { range: 'bytes=0-99' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-99\//)
    expect((await res.arrayBuffer()).byteLength).toBe(100)
    const full = await req('GET', `/media/${asset.id}/poster`)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('image/jpeg')
  })

  it('grabs an exact frame as a derived image asset', async () => {
    const res = await req('POST', `/api/projects/${project.id}/assets/${asset.id}/frame`, { seconds: 1.5 })
    expect(res.status).toBe(201)
    const frame = (await res.json()) as AssetDTO
    expect(frame.kind).toBe('image')
    expect(frame.parentIds).toEqual([asset.id])
  })

  it('finalizes an export: mux + exact audio length + loudness', async () => {
    const dir = join(root, 'export-src')
    mkdirSync(dir, { recursive: true })
    const video = join(dir, 'v.mp4')
    const audio = join(dir, 'a.wav')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5:sample_rate=48000', '-ac', '2', audio])

    const created = await req('POST', '/api/exports', { projectId: project.id, name: 'Render test', fps: 24, frames: 48 })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const bytes = new Uint8Array(readFileSync(video))
    // Upload out of order to exercise positional writes.
    const half = Math.floor(bytes.length / 2)
    expect((await req('PUT', `/api/exports/${id}/video?position=${half}`, bytes.slice(half), { 'content-type': 'application/octet-stream' })).status).toBe(200)
    expect((await req('PUT', `/api/exports/${id}/video?position=0`, bytes.slice(0, half), { 'content-type': 'application/octet-stream' })).status).toBe(200)
    expect((await req('PUT', `/api/exports/${id}/audio`, new Uint8Array(readFileSync(audio)), { 'content-type': 'audio/wav' })).status).toBe(200)
    const fin = await req('POST', `/api/exports/${id}/finalize`, { loudness: -14 })
    expect(fin.status).toBe(201)
    const render = (await fin.json()) as AssetDTO
    expect(render.source).toBe('render')
    const ready = await deps.media.whenReady(render.id)
    expect(ready.hasVideo && ready.hasAudio).toBe(true)
    // Audio is padded to exactly the picture length (2 s).
    expect(Math.abs((ready.durationFlicks ?? 0) / 705_600_000 - 2)).toBeLessThan(0.05)
  })
})

describe('render queue', () => {
  const get = async (id: string) => (await (await req('GET', `/api/generations/${id}`)).json()) as GenerationDTO

  it('holds jobs while paused, reorders them across projects, then runs cloud jobs one at a time in queue order', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Queue', settings: { width: 640, height: 360 } })).json()) as ProjectDetail
    const other = (await (await req('POST', '/api/projects', { name: 'Queue B', settings: { width: 640, height: 360 } })).json()) as ProjectDetail
    expect((await req('PATCH', '/api/settings', { queuePaused: true })).status).toBe(200)
    let jobs: GenerationDTO[]
    let otherJob: GenerationDTO
    try {
      const make = async (prompt: string, projectId = project.id) =>
        ((await (await req('POST', '/api/generations', { projectId, modelId: 'mock-image', params: { prompt } })).json()) as GenerationDTO[])[0]!
      jobs = [await make('first'), await make('second')]
      otherJob = await make('other project', other.id)
      jobs.push(await make('third'))
      expect(otherJob.projectName).toBe('Queue B')

      // Paused: the worker ticks every 400 ms but starts nothing.
      await new Promise((r) => setTimeout(r, 1200))
      expect((await Promise.all(jobs.map((j) => get(j.id)))).map((j) => j.status)).toEqual(['queued', 'queued', 'queued'])
      // The shared queue lists them for every project's panel.
      const active = (await (await req('GET', '/api/generations/active')).json()) as GenerationDTO[]
      expect([...jobs, otherJob].every((j) => active.some((a) => a.id === j.id))).toBe(true)
      expect(active.find((a) => a.id === otherJob.id)?.projectName).toBe('Queue B')

      // One queue for every project: moves pass jobs of other projects.
      expect((await req('POST', `/api/generations/${jobs[2]!.id}/move`, { to: 'top' })).status).toBe(200)
      expect((await req('POST', `/api/generations/${jobs[2]!.id}/move`, { to: 'sideways' })).status).toBe(400)
      expect((await req('POST', `/api/generations/${otherJob.id}/move`, { to: 'up' })).status).toBe(200)
      const queued = await Promise.all([...jobs, otherJob].map((j) => get(j.id)))
      expect(queued.sort((x, y) => x.queueOrder! - y.queueOrder!).map((j) => j.label)).toEqual(['third', 'first', 'other project', 'second'])
    } finally {
      // Never leave the shared worker paused for the tests that follow.
      await req('PATCH', '/api/settings', { queuePaused: false })
    }

    let maxActive = 0
    const done = await waitFor(async () => {
      const now = await Promise.all(jobs.map((j) => get(j.id)))
      maxActive = Math.max(maxActive, now.filter((j) => !['queued', 'succeeded', 'failed', 'canceled', 'needs_attention'].includes(j.status)).length)
      return now.every((j) => j.status === 'succeeded') ? now : undefined
    })
    expect(maxActive).toBeLessThanOrEqual(1)
    expect(done.every((j) => j.startedAt && j.finishedAt)).toBe(true)
    expect(done.sort((x, y) => (x.startedAt! < y.startedAt! ? -1 : 1)).map((j) => j.label)).toEqual(['third', 'first', 'second'])
    // Finished jobs of every project stay listed for the shared panel, with their project's name.
    await waitFor(async () => ((await get(otherJob.id)).status === 'succeeded' ? true : undefined))
    const recent = (await (await req('GET', '/api/generations/recent')).json()) as GenerationDTO[]
    expect(recent.find((j) => j.id === otherJob.id)).toMatchObject({ status: 'succeeded', projectName: 'Queue B' })
    expect(jobs.every((j) => recent.some((r) => r.id === j.id))).toBe(true)
  })
})

/** A closed project bundle with hand-written generation records (what a previous run left behind). */
function bundleWith(name: string, records: Array<Partial<GenerationRecord> & { id: string }>, savedBy?: ProjectFile['savedBy']): string {
  const store = deps.registry.create({ name })
  const path = store.root
  expect(deps.registry.close(store.id)).toBe(true)
  const now = new Date().toISOString()
  for (const rec of records) {
    const full: GenerationRecord = {
      modelId: 'mock-image',
      provider: 'mock',
      kind: 'image',
      status: 'queued',
      progress: null,
      label: 'x',
      params: {},
      providerTaskId: null,
      providerMeta: {},
      requestJson: null,
      responseJson: null,
      adapterVersion: null,
      error: null,
      costEstimateUsd: null,
      costUsd: null,
      outputAssetIds: [],
      variant: 0,
      batchId: null,
      queueOrder: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      ...rec,
    }
    writeJsonSync(join(path, 'Generations', `${rec.id}.json`), full)
  }
  if (savedBy) {
    const file = readJsonFile<ProjectFile>(join(path, 'project.json'))!.value
    writeJsonSync(join(path, 'project.json'), { ...file, savedBy })
  }
  return path
}

describe('job resume safety', () => {
  it('never re-submits a paid job that was mid-submission when the app stopped', async () => {
    const path = bundleWith('Stuck', [{ id: 'stuck-kling', modelId: 'kling-3.0', provider: 'kling', kind: 'video', status: 'submitting' }])
    const store = deps.registry.open(path)
    const row = store.generations.get('stuck-kling')!
    expect(row.status).toBe('needs_attention')
    expect(JSON.parse(row.errorJson!).maybeCharged).toBe(true)
    // Written back to the bundle right away.
    expect(readJsonFile<GenerationRecord>(join(path, 'Generations', 'stuck-kling.json'))?.value.status).toBe('needs_attention')
  })

  it('puts a local render that was running at shutdown back in the queue, in its place', async () => {
    await req('PATCH', '/api/settings', { queuePaused: true })
    try {
      const path = bundleWith('Overnight', [
        {
          id: 'running-local',
          modelId: 'local-ltx-2.5',
          provider: 'local',
          kind: 'video',
          status: 'running',
          label: 'overnight render',
          providerTaskId: 'task-from-the-old-process',
          progress: 0.4,
          queueOrder: 1,
          startedAt: new Date().toISOString(),
        },
      ])
      const row = deps.registry.open(path).generations.get('running-local')!
      expect(row).toMatchObject({ status: 'queued', providerTaskId: null, progress: null, startedAt: null, queueOrder: 1 })
      // Unfinished work keeps the project open (and is remembered for the next start).
      expect(deps.registry.close(row.projectId)).toBe(false)
      expect(deps.appState.recentById(row.projectId)?.hasActiveJobs).toBe(true)
      await req('POST', `/api/generations/${row.id}/cancel`)
    } finally {
      await req('PATCH', '/api/settings', { queuePaused: false })
    }
  })

  it('does not run jobs of a project last saved on another machine', async () => {
    const path = bundleWith('From the other Mac', [{ id: 'queued-elsewhere', status: 'queued' }], {
      machineId: 'm_other_machine',
      host: 'studio-mac.local',
      at: new Date().toISOString(),
    })
    const row = deps.registry.open(path).generations.get('queued-elsewhere')!
    expect(row.status).toBe('needs_attention')
    expect(JSON.parse(row.errorJson!)).toMatchObject({ code: 'other_machine', retryable: true })
    expect(JSON.parse(row.errorJson!).message).toMatch(/studio-mac/)
  })

  it('writes "submitting" to the bundle before the request leaves', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Write-ahead' })).json()) as ProjectDetail
    const adapter = deps.adapters.mock
    const original = adapter.submit
    let seen: string | undefined
    adapter.submit = async (ctx) => {
      seen = readJsonFile<GenerationRecord>(join(project.path, 'Generations', `${ctx.generationId}.json`))?.value.status
      return original.call(adapter, ctx)
    }
    try {
      const [job] = (await (await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-image', params: { prompt: 'wal' } })).json()) as GenerationDTO[]
      await waitFor(async () => {
        const g = (await (await req('GET', `/api/generations/${job!.id}`)).json()) as GenerationDTO
        return ['succeeded', 'failed'].includes(g.status) ? g : undefined
      })
      expect(seen).toBe('submitting')
    } finally {
      adapter.submit = original
    }
  })
})

describe('waiting for a machine (submit gate, requeue)', () => {
  const get = async (id: string) => (await (await req('GET', `/api/generations/${id}`)).json()) as GenerationDTO

  it('keeps a job queued with a reason while its provider is not ready, without counting an attempt', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Gate' })).json()) as ProjectDetail
    const adapter = deps.adapters.mock
    let ready = false
    adapter.beforeSubmit = () => (ready ? { ready: true } : { ready: false, retryInMs: 100, detail: 'Starting GPU…' })
    try {
      const [job] = (await (await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-image', params: { prompt: 'gated' } })).json()) as GenerationDTO[]
      const waiting = await waitFor(async () => {
        const g = await get(job!.id)
        return g.statusDetail ? g : undefined
      })
      expect(waiting).toMatchObject({ status: 'queued', statusDetail: 'Starting GPU…' })
      expect(waiting.startedAt).toBeUndefined()
      // Waiting is machine-local: nothing about it reaches the bundle.
      const onDisk = readJsonFile<GenerationRecord>(join(project.path, 'Generations', `${job!.id}.json`))!.value
      expect(onDisk).toMatchObject({ status: 'queued', attempts: 0, startedAt: null })
      expect(onDisk).not.toHaveProperty('statusDetail')

      ready = true
      const done = await waitFor(async () => {
        const g = await get(job!.id)
        return g.status === 'succeeded' ? g : undefined
      })
      expect(done.statusDetail).toBeUndefined()
    } finally {
      delete adapter.beforeSubmit
    }
  })

  it('fails a job when its provider says it cannot run at all', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Gate error' })).json()) as ProjectDetail
    const adapter = deps.adapters.mock
    adapter.beforeSubmit = () => ({ ready: false, error: { code: 'insufficient_credits', message: 'Balance too low', retryable: false, maybeCharged: false } })
    try {
      const [job] = (await (await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-image', params: { prompt: 'broke' } })).json()) as GenerationDTO[]
      const failed = await waitFor(async () => {
        const g = await get(job!.id)
        return g.status === 'failed' ? g : undefined
      })
      expect(failed.error).toMatchObject({ code: 'insufficient_credits' })
    } finally {
      delete adapter.beforeSubmit
    }
  })

  it('puts a running job back in the queue when the machine running it went away', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Requeue' })).json()) as ProjectDetail
    const adapter = deps.adapters.mock
    const original = adapter.poll!
    const originalSubmit = adapter.submit
    let requeued = false
    let submits = 0
    adapter.submit = async (ctx) => {
      submits++
      return originalSubmit.call(adapter, ctx)
    }
    adapter.poll = async (ctx) => {
      if (!requeued) {
        requeued = true
        return { type: 'requeue', detail: 'GPU session ended — queued again' }
      }
      return original.call(adapter, ctx)
    }
    try {
      const [job] = (await (await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-image', params: { prompt: 'again' } })).json()) as GenerationDTO[]
      const done = await waitFor(async () => {
        const g = await get(job!.id)
        return g.status === 'succeeded' ? g : undefined
      })
      expect(requeued).toBe(true)
      expect(submits).toBe(2)
      expect(done.outputAssetIds).toHaveLength(1)
    } finally {
      adapter.poll = original
      adapter.submit = originalSubmit
    }
  })

  it('gives up on a job whose machine keeps losing it, instead of rendering it again forever', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Requeue loop' })).json()) as ProjectDetail
    const adapter = deps.adapters.mock
    const original = adapter.poll!
    let lost = 0
    adapter.poll = async () => {
      lost++
      return { type: 'requeue', detail: 'The GPU lost this render — queued again' }
    }
    try {
      const [job] = (await (await req('POST', '/api/generations', { projectId: project.id, modelId: 'mock-image', params: { prompt: 'cursed' } })).json()) as GenerationDTO[]
      const failed = await waitFor(async () => {
        const g = await get(job!.id)
        return g.status === 'failed' ? g : undefined
      })
      expect(lost).toBe(5)
      expect(failed.error).toMatchObject({ code: 'provider', message: expect.stringContaining('Gave up after 5 tries') })
    } finally {
      adapter.poll = original
    }
  })
})

describe('job engine hardening', () => {
  const get = async (id: string) => (await (await req('GET', `/api/generations/${id}`)).json()) as GenerationDTO
  const create = async (name: string) => (await (await req('POST', '/api/projects', { name })).json()) as ProjectDetail
  const generate = async (projectId: string, body: Record<string, unknown> = {}) => {
    const res = await req('POST', '/api/generations', { projectId, modelId: 'mock-video', params: { prompt: 'Harbour at dawn', duration: 3, fps: 24 }, ...body })
    expect(res.status).toBe(201)
    return ((await res.json()) as GenerationDTO[])[0]!
  }
  const until = (id: string, statuses: string[]) => waitFor(async () => {
    const g = await get(id)
    return statuses.includes(g.status) ? g : undefined
  })

  it('refuses a job for a project whose folder is gone, instead of a 201 for a job that is never saved or run', async () => {
    const p = await create('Gone before the render')
    rmSync(p.path, { recursive: true, force: true })
    const res = await req('POST', '/api/generations', { projectId: p.id, modelId: 'mock-image', params: { prompt: 'x' } })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { details: { code: string } }).details.code).toBe('missing')
  })

  it('keeps the name a render was given when it is retried', async () => {
    const p = await create('Retry keeps the label')
    const job = await generate(p.id, { label: 'Shot 3 — the harbour' })
    await until(job.id, ['succeeded', 'failed'])
    const res = await req('POST', `/api/generations/${job.id}/retry`)
    expect(res.status).toBe(201)
    const retried = (await res.json()) as GenerationDTO
    expect(retried.label).toBe('Shot 3 — the harbour')
    await until(retried.id, ['succeeded', 'failed'])
  })

  it('marks a job canceled before asking the provider, so a poll landing meanwhile cannot finish it', async () => {
    const p = await create('Cancel order')
    const adapter = deps.adapters.mock
    const original = adapter.cancel!
    let statusWhileCanceling: string | undefined
    adapter.cancel = async (ctx) => {
      statusWhileCanceling = (await get(ctx.generationId)).status
      return original.call(adapter, ctx)
    }
    try {
      const job = await generate(p.id)
      await until(job.id, ['running'])
      const canceled = (await (await req('POST', `/api/generations/${job.id}/cancel`)).json()) as GenerationDTO
      expect(statusWhileCanceling).toBe('canceled')
      expect(canceled.status).toBe('canceled')
      expect((await get(job.id)).status).toBe('canceled')
    } finally {
      adapter.cancel = original
    }
  })

  it('withdraws a job that ran out of time at the provider (a hung render keeps a rented GPU billing)', async () => {
    const p = await create('Timeout')
    const adapter = deps.adapters.mock
    const original = adapter.cancel!
    const withdrawn: string[] = []
    adapter.cancel = async (ctx) => {
      withdrawn.push(ctx.generationId)
      return original.call(adapter, ctx)
    }
    adapter.maxRunMs = 1
    try {
      const job = await generate(p.id)
      const parked = await until(job.id, ['needs_attention', 'succeeded', 'failed'])
      expect(parked.status).toBe('needs_attention')
      expect(parked.error?.code).toBe('timeout')
      expect(withdrawn).toEqual([job.id])
    } finally {
      adapter.cancel = original
      delete adapter.maxRunMs
    }
  })

  it('never imports an output twice when saving the results is retried, and gives up on a failure that repeats', async () => {
    const p = await create('Download retries')
    const good = join(root, 'output-good.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.5', '-r', '24', '-pix_fmt', 'yuv420p', good])
    const broken = join(root, 'output-broken.mp4')
    writeFileSync(broken, 'not a video')
    const adapter = deps.adapters.mock
    const original = adapter.poll!
    let polls = 0
    adapter.poll = async () => {
      polls++
      return { type: 'done', outputs: [{ kind: 'file', path: good, ext: 'mp4' }, { kind: 'file', path: broken, ext: 'mp4' }], costUsd: 0 }
    }
    try {
      const job = await generate(p.id)
      const parked = await waitFor(async () => {
        const row = deps.registry.generationOwner(job.id)?.generations.get(job.id)
        // Each failure waits 10 s before the results are fetched again: no need to here.
        if (row?.status === 'running' && row.nextPollAt && row.nextPollAt > Date.now()) row.nextPollAt = 0
        const g = await get(job.id)
        return ['needs_attention', 'succeeded', 'failed'].includes(g.status) ? g : undefined
      })
      expect(parked.status).toBe('needs_attention')
      expect(polls).toBe(3)
      const outputs = deps.media.list(p.id).filter((a) => a.generation?.generationId === job.id)
      expect(outputs).toHaveLength(1)
      expect(parked.outputAssetIds).toEqual([outputs[0]!.id])
    } finally {
      adapter.poll = original
    }
  })

  it('does not fail (or crash) a job because app.json could not be written', async () => {
    const p = await create('App state on a full disk')
    const original = deps.registry.setActiveJobs
    deps.registry.setActiveJobs = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    try {
      const job = await generate(p.id)
      expect((await until(job.id, ['succeeded', 'failed', 'needs_attention'])).status).toBe('succeeded')
    } finally {
      deps.registry.setActiveJobs = original
    }
  })
})

describe('closing while media is processed', () => {
  it('closes the project once the ingest it waited for is done', async () => {
    const p = (await (await req('POST', '/api/projects', { name: 'Close after ingest' })).json()) as ProjectDetail
    const clip = join(root, 'close-after-ingest.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', clip])
    const res = await req('POST', `/api/projects/${p.id}/assets/upload?name=clip.mp4`, new Uint8Array(readFileSync(clip)), { 'content-type': 'application/octet-stream' })
    expect(res.status).toBe(201)
    // Still processing its media: the close is deferred…
    expect(await (await req('POST', `/api/projects/${p.id}/close`)).json()).toEqual({ closed: false })
    // …and completes (releasing the folder) once that is done.
    await waitFor(async () => (deps.registry.mounted(p.id) ? undefined : true), 30_000)
    expect(existsSync(join(p.path, '.lock'))).toBe(false)
  })
})

describe('project bundles', () => {
  const list = async () => (await (await req('GET', '/api/projects')).json()) as ProjectEntry[]
  const create = async (name: string) => (await (await req('POST', '/api/projects', { name })).json()) as ProjectDetail

  it('lists open and closed projects with their state', async () => {
    const p = await create('Listed')
    let entry = (await list()).find((e) => e.path === p.path)
    expect(entry).toMatchObject({ id: p.id, name: 'Listed', state: 'ok', open: true, recent: true })
    expect((await req('POST', `/api/projects/${p.id}/close`)).status).toBe(200)
    entry = (await list()).find((e) => e.path === p.path)
    expect(entry).toMatchObject({ state: 'ok', open: false })
    expect(existsSync(join(p.path, '.lock'))).toBe(false)
  })

  it('gives the card the timeline’s length, a transition overlapping only as far as the editor plays it', async () => {
    const p = await create('Card length')
    const title = (id: string, duration: number) => ({ kind: 'title', id, duration, enabled: true, template: 'basic', text: id, style: {}, animation: 'none' })
    // 30 frames of dissolve between two 10-frame titles: the editor overlaps them by 9, so the cut is 11 frames long.
    const spine = [{ ...title('a', 10), transitionOut: { type: 'dissolve', duration: 30 } }, title('b', 10)]
    expect((await req('PUT', `/api/projects/${p.id}/doc`, { doc: { ...p.doc, spine }, baseRevision: 1 })).status).toBe(200)
    expect(((await (await req('GET', `/api/projects/${p.id}`)).json()) as ProjectDetail).durationFrames).toBe(11)
  })

  it('renames the project and its folder', async () => {
    const p = await create('Old name')
    const res = await req('PATCH', `/api/projects/${p.id}`, { name: 'New: name' })
    expect(res.status).toBe(200)
    const renamed = (await res.json()) as ProjectDetail
    expect(basename(renamed.path)).toBe('New- name.wildroom')
    expect(existsSync(p.path)).toBe(false)
    expect(readJsonFile<ProjectFile>(join(renamed.path, 'project.json'))?.value.name).toBe('New: name')
    // Saving still works at the new place.
    expect((await req('PUT', `/api/projects/${p.id}/doc`, { doc: p.doc, baseRevision: 1 })).status).toBe(200)
    expect((await list()).some((e) => e.path === p.path)).toBe(false)
  })

  it('duplicates into an independent bundle with new ids', async () => {
    const p = await create('Original')
    const bytes = new Uint8Array(readFileSync(join(root, 'export-src', 'v.mp4')))
    const up = await req('POST', `/api/projects/${p.id}/assets/upload?name=clip.mp4`, bytes, { 'content-type': 'application/octet-stream' })
    expect(up.status).toBe(201)
    const asset = (await up.json()) as AssetDTO
    const res = await req('POST', `/api/projects/${p.id}/duplicate`)
    expect(res.status).toBe(201)
    const copy = (await res.json()) as ProjectEntry
    expect(copy.name).toBe('Original copy')
    expect(copy.id).not.toBe(p.id)
    expect(copy.path).toBe(join(dirname(p.path), 'Original copy.wildroom'))
    expect(existsSync(join(copy.path, '.lock'))).toBe(false)
    const opened = (await (await req('POST', '/api/projects/open', { path: copy.path })).json()) as ProjectDetail
    const copiedAssets = (await (await req('GET', `/api/projects/${opened.id}/assets`)).json()) as AssetDTO[]
    expect(copiedAssets).toHaveLength(1)
    expect(copiedAssets[0]!.id).not.toBe(asset.id)
    expect(copiedAssets[0]!.name).toBe('clip')
    expect(readdirSync(join(copy.path, 'Media'))).toEqual(readdirSync(join(p.path, 'Media')))
  })

  it('gives a folder copied in Finder its own identity when the original is open', async () => {
    const p = await create('Finder copy')
    const elsewhere = join(root, 'elsewhere', 'Finder copy.wildroom')
    cpSync(p.path, elsewhere, { recursive: true })
    const res = await req('POST', '/api/projects/open', { path: elsewhere })
    expect(res.status).toBe(200)
    const opened = (await res.json()) as ProjectDetail
    expect(opened.id).not.toBe(p.id)
    expect(opened.path).toBe(elsewhere)
    expect(readJsonFile<ProjectFile>(join(elsewhere, 'project.json'))?.value.id).toBe(opened.id)
  })

  it('follows a project moved in Finder and asks before opening one open on another machine', async () => {
    const p = await create('Traveller')
    await req('POST', `/api/projects/${p.id}/close`)
    const moved = join(root, 'moved', 'Traveller.wildroom')
    mkdirSync(dirname(moved), { recursive: true })
    renameSync(p.path, moved)
    expect((await list()).find((e) => e.path === p.path)?.state).toBe('missing')
    expect((await req('GET', `/api/projects/${p.id}`)).status).toBe(404)

    // The other machine has it open.
    writeFileSync(
      join(moved, '.lock'),
      JSON.stringify({ pid: 4242, startedAt: new Date().toISOString(), host: 'studio-mac.local', machineId: 'm_other_machine' }),
    )
    const locked = await req('POST', '/api/projects/open', { path: moved })
    expect(locked.status).toBe(409)
    expect(((await locked.json()) as { details: { code: string; lockedBy: { foreign: boolean; host: string } } }).details).toMatchObject({
      code: 'locked',
      lockedBy: { foreign: true, host: 'studio-mac.local' },
    })
    const forced = await req('POST', '/api/projects/open', { path: moved, force: true })
    expect(forced.status).toBe(200)
    expect(((await forced.json()) as ProjectDetail).id).toBe(p.id) // a move keeps the identity
    const entries = await list()
    expect(entries.some((e) => e.path === p.path)).toBe(false)
    expect(entries.find((e) => e.path === moved)).toMatchObject({ id: p.id, open: true })
  })

  it('takes the name of a folder renamed in Finder', async () => {
    const p = await create('Before')
    await req('POST', `/api/projects/${p.id}/close`)
    const renamed = join(dirname(p.path), 'After rename.wildroom')
    renameSync(p.path, renamed)
    expect((await list()).find((e) => e.path === renamed)?.name).toBe('After rename')
    const opened = (await (await req('POST', '/api/projects/open', { path: renamed })).json()) as ProjectDetail
    expect(opened).toMatchObject({ id: p.id, name: 'After rename' })
    expect(readJsonFile<ProjectFile>(join(renamed, 'project.json'))?.value.name).toBe('After rename')
  })

  it('stops saving into a folder that vanished instead of re-creating it', async () => {
    const p = await create('Vanishing')
    rmSync(p.path, { recursive: true, force: true })
    const res = await req('PUT', `/api/projects/${p.id}/doc`, { doc: p.doc, baseRevision: 1 })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { details: { code: string } }).details.code).toBe('missing')
    expect(existsSync(p.path)).toBe(false)
  })

  it('remembers what a project was made as, and works it out for older ones', async () => {
    const ad = (await (await req('POST', '/api/projects', { name: 'Bakery ad', kind: 'ad' })).json()) as ProjectDetail
    expect(readJsonFile<ProjectFile>(join(ad.path, 'project.json'))?.value.kind).toBe('ad')
    expect((await list()).find((e) => e.path === ad.path)).toMatchObject({ kind: 'ad', tags: [], status: 'Empty' })
    const old = await create('Older edit')
    expect(readJsonFile<ProjectFile>(join(old.path, 'project.json'))?.value.kind).toBeUndefined()
    expect((await list()).find((e) => e.path === old.path)?.kind).toBe('edit')
    expect((await req('POST', '/api/projects', { name: 'x', kind: 'poster' })).status).toBe(400)
  })

  it('tags open and closed projects in their project.json, without opening them or touching “last edited”', async () => {
    const p = await create('Tagged')
    const tag = (path: string, tags: unknown) => req('POST', '/api/projects/tags', { path, tags })
    // Open: through the open store (the editor's autosaves keep them).
    let res = await tag(p.path, ['#Client', 'client', ' Showreel '])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: ['client', 'showreel'] })
    expect((await req('PUT', `/api/projects/${p.id}/doc`, { doc: p.doc, baseRevision: 1 })).status).toBe(200)
    expect(readJsonFile<ProjectFile>(join(p.path, 'project.json'))?.value.tags).toEqual(['client', 'showreel'])

    // Closed: written in place, still closed, same "last edited".
    await req('POST', `/api/projects/${p.id}/close`)
    const before = (await list()).find((e) => e.path === p.path)!
    res = await tag(p.path, ['client'])
    expect(res.status).toBe(200)
    const after = (await list()).find((e) => e.path === p.path)!
    expect(after).toMatchObject({ open: false, tags: ['client'], updatedAt: before.updatedAt, lastOpenedAt: before.lastOpenedAt })
    expect(existsSync(join(p.path, '.lock'))).toBe(false)

    // They travel with the folder.
    const copy = (await (await req('POST', `/api/projects/${(await (await req('POST', '/api/projects/open', { path: p.path })).json()).id}/duplicate`)).json()) as ProjectEntry
    expect(copy.tags).toEqual(['client'])

    // No tags left: the field goes, as in projects made before tags.
    expect((await tag(p.path, [])).status).toBe(200)
    expect(readJsonFile<ProjectFile>(join(p.path, 'project.json'))?.value).not.toHaveProperty('tags')

    expect((await tag(p.path, 'client')).status).toBe(400)
    expect((await tag(join(root, 'nowhere.wildroom'), ['x'])).status).toBe(404)
  })

  it('never tags a project open on another computer', async () => {
    const p = await create('Elsewhere')
    await req('POST', `/api/projects/${p.id}/close`)
    writeFileSync(join(p.path, '.lock'), JSON.stringify({ pid: 4242, startedAt: new Date().toISOString(), host: 'other.local', machineId: 'm_other_machine' }))
    const res = await req('POST', '/api/projects/tags', { path: p.path, tags: ['x'] })
    expect(res.status).toBe(409)
    expect(readJsonFile<ProjectFile>(join(p.path, 'project.json'))?.value.tags).toBeUndefined()
    rmSync(join(p.path, '.lock'))
  })

  it('moves a project to the Trash', async () => {
    const p = await create('Doomed')
    expect((await req('POST', '/api/projects/trash', { path: p.path })).status).toBe(200)
    expect(existsSync(p.path)).toBe(false)
    expect((await list()).some((e) => e.path === p.path)).toBe(false)
  })
})

describe('canvas exports (write-file)', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)
  const put = (dir: string, name: string, body: string, overwrite = false) =>
    req('PUT', `/api/system/write-file?${new URLSearchParams({ dir, name, ...(overwrite ? { overwrite: '1' } : {}) })}`, bytes(body), {
      'content-type': 'application/octet-stream',
    })

  it('writes into a chosen folder without replacing anything unless asked', async () => {
    const dir = join(root, 'exports')
    mkdirSync(dir, { recursive: true })
    const first = (await (await put(dir, 'og.png', 'one')).json()) as { path: string }
    const second = (await (await put(dir, 'og.png', 'two')).json()) as { path: string }
    expect(basename(first.path)).toBe('og.png')
    expect(basename(second.path)).toBe('og (2).png')
    expect(readFileSync(first.path, 'utf8')).toBe('one')
    await put(dir, 'og.png', 'three', true)
    expect(readFileSync(first.path, 'utf8')).toBe('three')
    // No temp files left behind.
    expect(readdirSync(dir).sort()).toEqual(['og (2).png', 'og.png'])
  })

  it('never writes through a symlink sitting at the target name', async () => {
    const dir = join(root, 'exports-link')
    mkdirSync(dir, { recursive: true })
    const victim = join(root, 'victim.png')
    const { symlinkSync } = await import('node:fs')
    symlinkSync(victim, join(dir, 'logo.png')) // dangling: the victim doesn't exist
    const res = (await (await put(dir, 'logo.png', 'payload')).json()) as { path: string }
    expect(basename(res.path)).toBe('logo (2).png')
    expect(existsSync(victim)).toBe(false)
  })

  it('refuses app folders, unknown file types and relative paths', async () => {
    expect((await put(deps.env.appDataDir, 'x.png', 'x')).status).toBe(400)
    expect((await put(join(root, 'exports'), 'evil.sh', 'x')).status).toBe(400)
    expect((await put('relative/dir', 'x.png', 'x')).status).toBe(400)
  })
})

describe('media hardening', () => {
  const create = async (name: string) => (await (await req('POST', '/api/projects', { name })).json()) as ProjectDetail
  const upload = async (projectId: string, name: string, bytes: Uint8Array) =>
    req('POST', `/api/projects/${projectId}/assets/upload?name=${encodeURIComponent(name)}`, bytes, { 'content-type': 'application/octet-stream' })
  const recordPath = (p: ProjectDetail, id: string) => join(p.path, 'Assets', `${id}.json`)
  /** Closes the project, edits one asset record on disk (as a shared bundle could arrive), reopens it. */
  async function tamper(p: ProjectDetail, id: string, edit: (rec: AssetRecord) => void) {
    // The project stays open while its media is being processed.
    await waitFor(async () => ((await (await req('GET', `/api/assets/${id}`)).json()) as AssetDTO).status === 'ready' || undefined)
    expect(await (await req('POST', `/api/projects/${p.id}/close`)).json()).toEqual({ closed: true })
    const rec = readJsonFile<AssetRecord>(recordPath(p, id))!.value
    edit(rec)
    writeJsonSync(recordPath(p, id), rec)
    expect((await req('POST', '/api/projects/open', { path: p.path })).status).toBe(200)
  }
  let png: Uint8Array

  beforeAll(async () => {
    const out = join(root, 'dot.png')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', out])
    png = new Uint8Array(readFileSync(out))
  })

  it('serves originals only as media, never as something a browser would run', async () => {
    const p = await create('Hardening')
    const asset = (await (await upload(p.id, 'dot.png', png)).json()) as AssetDTO
    const res = await req('GET', `/media/${asset.id}/original`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    await tamper(p, asset.id, (rec) => (rec.mime = 'text/html'))
    expect((await req('GET', `/media/${asset.id}/original`)).status).toBe(415)
  })

  it('never turns path parts from a bundle into a path outside its Media folder', async () => {
    const p = await create('Tampered')
    const asset = (await (await upload(p.id, 'dot.png', png)).json()) as AssetDTO
    // A file next to the bundle that a crafted record would point at.
    writeFileSync(join(dirname(p.path), 'secret.png'), 'TOP SECRET')
    writeFileSync(join(dirname(p.path), 'secret.svg'), '<svg>TOP SECRET</svg>')
    await tamper(p, asset.id, (rec) => {
      rec.sha256 = '../../secret'
      rec.meta = { ...rec.meta, vector: { sha256: '../../secret', ext: 'svg' } }
    })
    const original = await req('GET', `/media/${asset.id}/original`)
    expect(original.status).not.toBe(200)
    expect(await original.text()).not.toContain('TOP SECRET')
    const svg = await req('GET', `/media/${asset.id}/svg`)
    expect(svg.status).toBe(404)
    const listed = (await (await req('GET', `/api/projects/${p.id}/assets`)).json()) as AssetDTO[]
    expect(listed.find((a) => a.id === asset.id)?.vector).toBeFalsy()
  })

  it('leaves no temp file behind when an upload cannot be imported, and sweeps leftovers at startup', async () => {
    const p = await create('Broken upload')
    const res = await upload(p.id, 'broken.png', new TextEncoder().encode('this is not an image'))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(readdirSync(join(deps.env.tmpDir, 'uploads'))).toEqual([])

    const tmp = (...parts: string[]) => join(deps.env.tmpDir, ...parts)
    for (const sub of ['frames', 'exports/stale-export', 'jobs/stale-job', 'mock-tasks']) mkdirSync(tmp(sub), { recursive: true })
    writeFileSync(tmp('uploads', 'stale.mp4'), 'x')
    writeFileSync(tmp('frames', 'stale.png'), 'x')
    // An export whose tab closed mid-way, a job download of the previous run.
    writeFileSync(tmp('exports', 'stale-export', 'video.mp4'), 'x')
    writeFileSync(tmp('jobs', 'stale-job', 'output-0.mp4'), 'x')
    writeFileSync(tmp('mock-tasks', 'mock_kept.json'), '{}')
    // Job folders other tests left behind count too.
    expect(sweepUploadTemp(deps.env.tmpDir)).toBeGreaterThanOrEqual(4)
    for (const sub of ['uploads', 'frames', 'exports', 'jobs']) expect(readdirSync(tmp(sub))).toEqual([])
    // Demo tasks resume from their folder after a restart: kept.
    expect(existsSync(tmp('mock-tasks', 'mock_kept.json'))).toBe(true)
    rmSync(tmp('mock-tasks', 'mock_kept.json'))
  })

  it('serves only real variants (an inherited name never re-processes a ready asset)', async () => {
    const p = await create('Variant names')
    const asset = (await (await upload(p.id, 'dot.png', png)).json()) as AssetDTO
    await waitFor(async () => ((await (await req('GET', `/api/assets/${asset.id}`)).json()) as AssetDTO).status === 'ready' || undefined)
    for (const name of ['constructor', 'toString', '__proto__']) expect((await req('GET', `/media/${asset.id}/${name}`)).status).toBe(404)
    expect(((await (await req('GET', `/api/assets/${asset.id}`)).json()) as AssetDTO).status).toBe('ready')
  })

  it('answers invalid asset edits with 400 and unknown assets with 404', async () => {
    const p = await create('Asset edits')
    const asset = (await (await upload(p.id, 'dot.png', png)).json()) as AssetDTO
    for (const body of [{ name: '' }, { name: 5 }, { rating: 7 }, { keywords: 'one, two' }, { role: 3 }]) {
      expect((await req('PATCH', `/api/assets/${asset.id}`, body)).status).toBe(400)
    }
    expect((await req('PATCH', `/api/assets/${asset.id}`, { name: 'Red dot', keywords: ['red'] })).status).toBe(200)
    expect(() => deps.media.update('no-such-asset', { name: 'x' })).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('renders SVGs without reading the local files they point at', async () => {
    const victim = join(root, 'dot.png')
    expect(stripExternalRefs(`<svg><image href="${victim}" width="10"/><use xlink:href="#a"/><image href='data:image/png;base64,AA'/></svg>`)).toBe(
      `<svg><image width="10"/><use xlink:href="#a"/><image href='data:image/png;base64,AA'/></svg>`,
    )
    expect(stripExternalRefs('<svg><x:image x:href="file:///etc/passwd"/><feImage href="https://x/y.png"/></svg>')).toBe('<svg><x:image/><feImage/></svg>')
    // A `>` inside an attribute value, a decoy href inside another value, comments and DOCTYPE literals hide nothing.
    expect(stripExternalRefs(`<svg><image x="1>" href="${victim}"/></svg>`)).toBe('<svg><image x="1>"/></svg>')
    expect(stripExternalRefs(`<svg><image title="x href='data:a" href="${victim}" b='"'/></svg>`)).toBe(`<svg><image title="x href='data:a" b='"'/></svg>`)
    expect(stripExternalRefs(`<svg><!-- <image " --><image href="${victim}"/><!-- " --></svg>`)).toBe('<svg><!-- <image " --><image/><!-- " --></svg>')
    expect(stripExternalRefs(`<!DOCTYPE svg SYSTEM "a>b<!--" []><svg><image href="${victim}"/></svg>`)).toBe('<svg><image/></svg>')
    // A nested SVG data URL could carry its own file references.
    expect(stripExternalRefs('<svg><image href="data:image/svg+xml;base64,AA"/></svg>')).toBe('<svg><image/></svg>')
    // Plain-text entities (Illustrator's namespace URLs) are written out; ones that could turn into markup are refused.
    expect(stripExternalRefs('<!DOCTYPE svg [<!ENTITY ns "http://ns.adobe.com/x">]><svg xmlns:x="&ns;"/>')).toBe('<svg xmlns:x="http://ns.adobe.com/x"/>')
    expect(() => stripExternalRefs(`<!DOCTYPE svg [<!ENTITY e "&#60;image href='${victim}'/>">]><svg>&e;</svg>`)).toThrow(UnsafeSvgError)
    expect(() => stripExternalRefs(`<!DOCTYPE svg [<!ATTLIST image href CDATA "${victim}">]><svg><image/></svg>`)).toThrow(UnsafeSvgError)
    const withImage = join(root, 'leaky.svg')
    const without = join(root, 'plain.svg')
    writeFileSync(withImage, `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image class="a>b" href="${victim}" width="64" height="64"/></svg>`)
    writeFileSync(without, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>')
    await rasterizeSvg(withImage, join(root, 'leaky.png'), 64)
    await rasterizeSvg(without, join(root, 'plain.png'), 64)
    expect(readFileSync(join(root, 'leaky.png')).equals(readFileSync(join(root, 'plain.png')))).toBe(true)
  })
})

describe('asset records from disk', () => {
  it('keeps only safe hashes, extensions and vector references', () => {
    const sha = 'a'.repeat(64)
    const base = { id: 'x', projectId: 'p', name: 'n' } as unknown as AssetRecord
    expect(normalizeAssetRecord({ ...base, sha256: sha, ext: 'png' })).toMatchObject({ sha256: sha, ext: 'png' })
    expect(normalizeAssetRecord({ ...base, sha256: '../../etc/passwd', ext: 'png/../x' })).toMatchObject({ sha256: null, ext: null })
    expect(normalizeAssetRecord({ ...base, sha256: sha, ext: 'svg', meta: { vector: { sha256: '../x' } } }).meta.vector).toBeUndefined()
    expect(RECORD_ID_RE.test('V1StGXR8_Z5jdHi6B-myT')).toBe(true)
    expect(RECORD_ID_RE.test('../escape')).toBe(false)
  })
})

describe('ElevenLabs voices', () => {
  it('never answers with the voices of the key that was set before', async () => {
    // Stands in for api.elevenlabs.io: each key has its own voices.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const key = new Headers(init?.headers).get('xi-api-key')
      return new Response(JSON.stringify({ voices: [{ voice_id: `voice-of-${key}`, name: `Voice of ${key}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    try {
      const voices = async () => ((await (await req('GET', '/api/voices')).json()) as { voices: Array<{ id: string }> }).voices.map((v) => v.id)
      deps.secrets.set('elevenlabs', 'apiKey', 'key-one')
      expect(await voices()).toEqual(['voice-of-key-one'])
      deps.secrets.set('elevenlabs', 'apiKey', 'key-two')
      expect(await voices()).toEqual(['voice-of-key-two'])
    } finally {
      fetchSpy.mockRestore()
      deps.secrets.delete('elevenlabs', 'apiKey')
    }
  })
})

describe('ComfyUI window', () => {
  it('serves the local ComfyUI address and keeps where the outputs go', async () => {
    const view = (await (await req('GET', '/api/gpu/comfy')).json()) as { url: string; target: { mode: string; projectId?: string }; pendingImports: number }
    expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(view.url).not.toBe(`http://${HOST}/`)
    expect(view.target).toEqual({ mode: 'assets' })
    expect(view.pendingImports).toBe(0)

    const project = (await (await req('POST', '/api/projects', { name: 'Comfy target' })).json()) as ProjectDetail
    expect((await req('PUT', '/api/gpu/comfy/target', { mode: 'sideways', projectId: project.id })).status).toBe(400)
    expect((await req('PUT', '/api/gpu/comfy/target', { mode: 'append', projectId: 'no-such-project' })).status).toBe(400)

    const set = await req('PUT', '/api/gpu/comfy/target', { mode: 'append', projectId: project.id })
    expect(set.status).toBe(200)
    expect(((await set.json()) as typeof view).target).toEqual({ mode: 'append', projectId: project.id })
    expect(deps.runpodState.comfyTarget).toEqual({ mode: 'append', projectId: project.id })

    // Changing only the mode keeps the project.
    const off = (await (await req('PUT', '/api/gpu/comfy/target', { mode: 'off', projectId: project.id })).json()) as typeof view
    expect(off.target).toEqual({ mode: 'off', projectId: project.id })
  })
})
