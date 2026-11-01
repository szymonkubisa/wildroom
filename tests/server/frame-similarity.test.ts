import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { parseSsim } from '../../src/server/services/analysis'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { endVerdict } from '../../src/shared/story/endFrame'
import type { ProjectDetail } from '../../src/shared/types/api'
import type { AssetDTO } from '../../src/shared/types/assets'
import type { GenerationDTO } from '../../src/shared/types/jobs'

const ORIGIN = 'http://127.0.0.1:5180'
const HOST = '127.0.0.1:5180'

describe('ffmpeg’s ssim summary', () => {
  it('reads the overall score from the last summary line', () => {
    const stderr = 'Input #0, png_pipe…\n[Parsed_ssim_4 @ 0x15181a430] SSIM Y:0.757985 (6.161582) All:0.757985 (6.161582)\n'
    expect(parseSsim(stderr)).toBe(0.757985)
    expect(parseSsim('[Parsed_ssim_4 @ 0x1] SSIM Y:1.000000 (inf) All:1.000000 (inf)')).toBe(1)
    expect(parseSsim('frame=1 fps=0.0 q=-0.0 Lsize=N/A')).toBeUndefined()
  })
})

describe('frame similarity: how alike two stills of a project are', () => {
  let root: string
  let deps: AppDeps
  let app: ReturnType<typeof createApp>
  let a: ProjectDetail
  let b: ProjectDetail
  let start: AssetDTO
  let moved: AssetDTO
  let noise: AssetDTO
  let elsewhere: AssetDTO

  const req = (method: string, path: string, body?: unknown) =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, ...(method !== 'GET' ? { origin: ORIGIN, 'x-studio': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const similarity = (x: string, y: string) => req('POST', '/api/analysis/frame-similarity', { a: x, b: y })
  const ssim = async (x: AssetDTO, y: AssetDTO) => ((await (await similarity(x.id, y.id)).json()) as { ssim: number }).ssim

  async function still(projectId: string, name: string, source: string): Promise<AssetDTO> {
    const path = join(root, `${name}.png`)
    await runFfmpeg(['-f', 'lavfi', '-i', source, '-frames:v', '1', path])
    return deps.media.whenReady((await deps.media.importFile(path, { name, source: 'import', projectId })).id)
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network in tests'))))
    mkdirSync('tests/.tmp', { recursive: true })
    root = resolve(await mkdtemp(join('tests/.tmp', 'frame-similarity-')))
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7782 }), { secrets: new MemorySecretStore() })
    app = createApp(deps)
    a = (await (await req('POST', '/api/projects', { name: 'Similar A' })).json()) as ProjectDetail
    b = (await (await req('POST', '/api/projects', { name: 'Similar B' })).json()) as ProjectDetail
    // A grey room with a white box, then the box carried across the frame from the same camera.
    const room = 'color=c=0x606060:s=640x360'
    start = await still(a.id, 'start', `${room},drawbox=x=80:y=80:w=240:h=200:color=white:t=fill`)
    moved = await still(a.id, 'moved', `${room},drawbox=x=340:y=80:w=240:h=200:color=white:t=fill`)
    noise = await still(a.id, 'noise', 'cellauto=s=640x360:rule=110:random_seed=7')
    elsewhere = await still(b.id, 'elsewhere', `${room},drawbox=x=80:y=80:w=240:h=200:color=white:t=fill`)
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await closeDeps(deps)
    rmSync(root, { recursive: true, force: true })
  })

  it('the same still is 1, the box carried across is in between, an unrelated picture is low', async () => {
    const same = await ssim(start, start)
    const changed = await ssim(start, moved)
    const unrelated = await ssim(start, noise)
    expect(same).toBeCloseTo(1, 3)
    expect(changed).toBeGreaterThan(0.5)
    expect(changed).toBeLessThan(0.9)
    expect(unrelated).toBeLessThan(0.2)
    expect([same, changed, unrelated].map(endVerdict)).toEqual(['same', 'changed', 'recomposed'])
    // Either way round.
    expect(await ssim(moved, start)).toBeCloseTo(changed, 3)
  })

  it('both stills come from one project; it is free, so nothing is recorded', async () => {
    expect((await similarity(start.id, elsewhere.id)).status).toBe(404)
    expect((await similarity(start.id, 'no-such-asset')).status).toBe(404)
    expect((await req('POST', '/api/analysis/frame-similarity', { a: start.id })).status).toBe(400)
    const records = (await (await req('GET', `/api/projects/${a.id}/generations`)).json()) as GenerationDTO[]
    expect(records).toEqual([])
  })
})
